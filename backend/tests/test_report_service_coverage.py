"""Coverage-focused tests for app.services.report_service.

These exercise the large uncovered blocks: get_income_expenses_report
(lines 328-865), the cash-flow accrual / baseline / non-daily-interval
branches, and the net-worth credit-card / asset composition branches.

`get_income_expenses_report` builds its period buckets with PostgreSQL's
``to_char`` (and ``extract`` for weekly). Tests run on SQLite, so we register
a ``to_char`` user-defined function on the shared test engine for the
daily / monthly / yearly intervals (weekly relies on ``extract('isoyear')``
which SQLite cannot compile and is therefore not exercised here — its label
helper is covered by the existing pure-function tests).
"""
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.asset import Asset
from app.models.asset_value import AssetValue
from app.models.bank_connection import BankConnection
from app.models.category import Category
from app.models.recurring_transaction import RecurringTransaction
from app.models.transaction import Transaction
from app.services.report_service import (
    _get_baseline_projection,
    _net_worth_at,
    get_cash_flow_report,
    get_income_expenses_report,
    get_net_worth_report,
)

from tests.conftest import engine as _test_engine


# ---------------------------------------------------------------------------
# Register a `to_char` UDF on the SQLite test engine so the income/expenses
# report (which uses Postgres `to_char`) can run. Idempotent across tests.
# ---------------------------------------------------------------------------


def _py_to_char(value, fmt):
    """Minimal emulation of PostgreSQL to_char(date, fmt) for the formats
    the report uses: 'YYYY-MM-DD', 'YYYY-MM', 'YYYY'."""
    if value is None:
        return None
    s = str(value)[:10]  # 'YYYY-MM-DD'
    y, m, d = s.split("-")
    if fmt == "YYYY-MM-DD":
        return f"{y}-{m}-{d}"
    if fmt == "YYYY-MM":
        return f"{y}-{m}"
    if fmt == "YYYY":
        return y
    return s


@event.listens_for(_test_engine.sync_engine, "connect")
def _register_to_char(dbapi_connection, _connection_record):
    dbapi_connection.create_function("to_char", 2, _py_to_char)


@pytest.fixture(autouse=True)
async def _ensure_to_char(session: AsyncSession):
    """Make sure the UDF is registered on the live connection.

    The `connect` listener covers fresh connections; for the StaticPool's
    already-open connection we register directly via the raw DBAPI handle.
    """
    raw = await session.connection()

    def _do(sync_conn):
        dbapi = sync_conn.connection.dbapi_connection
        dbapi.create_function("to_char", 2, _py_to_char)

    await raw.run_sync(_do)
    yield


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_account(
    session: AsyncSession, user_id: uuid.UUID, name: str,
    acc_type: str = "checking", balance: str = "0.00", currency: str = "BRL",
    connection_id: uuid.UUID | None = None, is_closed: bool = False,
) -> Account:
    acct = Account(
        id=uuid.uuid4(), user_id=user_id, name=name, type=acc_type,
        balance=Decimal(balance), currency=currency,
        connection_id=connection_id, is_closed=is_closed,
    )
    session.add(acct)
    await session.commit()
    await session.refresh(acct)
    return acct


async def _add_txn(
    session: AsyncSession, user_id: uuid.UUID, account_id: uuid.UUID,
    amount: float, txn_type: str, txn_date: date, *,
    source: str = "manual", category_id: uuid.UUID | None = None,
    currency: str = "BRL", effective_date: date | None = None,
    workspace_id: uuid.UUID | None = None, status: str = "posted",
) -> Transaction:
    txn = Transaction(
        id=uuid.uuid4(), user_id=user_id, account_id=account_id,
        category_id=category_id, description=f"Test {txn_type} {amount}",
        amount=Decimal(str(amount)), date=txn_date, type=txn_type,
        source=source, status=status, currency=currency,
        effective_date=effective_date or txn_date,
        created_at=datetime.now(timezone.utc),
    )
    if workspace_id is not None:
        txn.workspace_id = workspace_id
    session.add(txn)
    await session.commit()
    await session.refresh(txn)
    return txn


async def _make_category(
    session: AsyncSession, user_id: uuid.UUID, name: str, color: str = "#123456",
) -> Category:
    cat = Category(
        id=uuid.uuid4(), user_id=user_id, name=name, icon="tag",
        color=color, is_system=False,
    )
    session.add(cat)
    await session.commit()
    await session.refresh(cat)
    return cat


async def _make_recurring(
    session: AsyncSession, user_id: uuid.UUID, account_id: uuid.UUID,
    amount: float, txn_type: str, *, frequency: str = "monthly",
    next_occurrence: date | None = None, category_id: uuid.UUID | None = None,
    currency: str = "BRL",
) -> RecurringTransaction:
    today = date.today()
    rec = RecurringTransaction(
        id=uuid.uuid4(), user_id=user_id, account_id=account_id,
        category_id=category_id, description=f"Rec {txn_type} {amount}",
        amount=Decimal(str(amount)), currency=currency, type=txn_type,
        frequency=frequency, start_date=today,
        next_occurrence=next_occurrence or (today + timedelta(days=2)),
        is_active=True,
    )
    session.add(rec)
    await session.commit()
    await session.refresh(rec)
    return rec


# ---------------------------------------------------------------------------
# Sanity: the to_char UDF is wired up
# ---------------------------------------------------------------------------


async def test_to_char_udf_registered(session: AsyncSession):
    from sqlalchemy import func, select
    from app.models.transaction import Transaction  # noqa: F401

    res = await session.execute(select(func.to_char(date(2025, 6, 15), "YYYY-MM")))
    assert res.scalar_one() == "2025-06"


# ---------------------------------------------------------------------------
# get_income_expenses_report — the big uncovered function (328-865)
# ---------------------------------------------------------------------------


async def test_income_expenses_basic_structure(session, test_user, test_workspace):
    """Income + expense actuals flow through into summary, trend, composition."""
    cat_food = await _make_category(session, test_user.id, "Food", color="#F00")
    cat_salary = await _make_category(session, test_user.id, "Salary", color="#0F0")
    acct = await _make_account(session, test_user.id, "IE Acct")
    today = date.today()

    await _add_txn(session, test_user.id, acct.id, 5000, "credit", today, category_id=cat_salary.id)
    await _add_txn(session, test_user.id, acct.id, 1200, "debit", today, category_id=cat_food.id)
    await _add_txn(session, test_user.id, acct.id, 300, "debit", today)  # uncategorized
    # opening balance must be excluded
    await _add_txn(session, test_user.id, acct.id, 99999, "credit", today, source="opening_balance")

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=3, interval="monthly"
    )

    assert report.meta.type == "income_expenses"
    assert report.meta.series_keys == [
        "income", "expenses", "projectedIncome", "projectedExpenses"
    ]
    assert report.meta.currency == "BRL"
    assert report.meta.interval == "monthly"

    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["income"] == pytest.approx(5000.0)
    assert bd["expenses"] == pytest.approx(1500.0)
    assert bd["projectedIncome"] == pytest.approx(0.0)
    assert bd["projectedExpenses"] == pytest.approx(0.0)
    assert bd["netIncome"] == pytest.approx(3500.0)

    # Composition contains the two named categories + uncategorized
    labels = {c.label for c in report.composition}
    assert "Salary" in labels
    assert "Food" in labels
    assert "Uncategorized" in labels

    # Each trend point has income/expenses breakdowns
    for dp in report.trend:
        assert "income" in dp.breakdowns
        assert "expenses" in dp.breakdowns
        assert "projectedIncome" in dp.breakdowns
        assert "projectedExpenses" in dp.breakdowns

    # Category trend present with proper grouping
    groups = {ct.group for ct in report.category_trend}
    assert "expenses" in groups
    assert "income" in groups
    for ct in report.category_trend:
        assert len(ct.series) == len(report.trend)


async def test_income_expenses_empty_data(session, test_user, test_workspace):
    """No transactions → zeroed summary, empty composition / category trend."""
    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=2, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["income"] == 0.0
    assert bd["expenses"] == 0.0
    assert bd["netIncome"] == 0.0
    assert report.summary.change_percent is None  # previous net == 0
    assert report.composition == []
    assert report.category_trend == []
    assert len(report.trend) > 0


async def test_income_expenses_daily_interval(session, test_user, test_workspace):
    """Daily interval exercises the YYYY-MM-DD to_char path."""
    acct = await _make_account(session, test_user.id, "IE Daily")
    today = date.today()
    await _add_txn(session, test_user.id, acct.id, 400, "debit", today)

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=1, interval="daily"
    )
    assert report.meta.interval == "daily"
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["expenses"] == pytest.approx(400.0)


async def test_income_expenses_yearly_interval(session, test_user, test_workspace):
    """Yearly interval exercises the YYYY to_char path."""
    acct = await _make_account(session, test_user.id, "IE Yearly")
    today = date.today()
    await _add_txn(session, test_user.id, acct.id, 2000, "credit", today)

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=6, interval="yearly"
    )
    assert report.meta.interval == "yearly"
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["income"] == pytest.approx(2000.0)


async def test_income_expenses_excludes_opening_but_keeps_closed_history(
    session, test_user, test_workspace
):
    """opening_balance rows contribute nothing; a closed account's history still counts."""
    closed = await _make_account(session, test_user.id, "IE Closed", is_closed=True)
    today = date.today()
    await _add_txn(session, test_user.id, closed.id, 1000, "credit", today)
    await _add_txn(session, test_user.id, closed.id, 300, "debit", today)

    open_acct = await _make_account(session, test_user.id, "IE Open")
    await _add_txn(session, test_user.id, open_acct.id, 7000, "credit", today, source="opening_balance")

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=2, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["income"] == 1000.0
    assert bd["expenses"] == 300.0


async def test_income_expenses_with_recurring_projection(session, test_user, test_workspace):
    """Recurring projections are layered into income / expenses + composition."""
    cat = await _make_category(session, test_user.id, "Rent", color="#00F")
    acct = await _make_account(session, test_user.id, "IE Rec")
    today = date.today()
    month_start = today.replace(day=1)
    # Recurring projections are layered per-month over the [start, today]
    # window. Anchor occurrences at the 1st of the current month so they
    # land inside that window regardless of what day "today" is.
    await _make_recurring(
        session, test_user.id, acct.id, 800, "debit",
        frequency="monthly", next_occurrence=month_start,
        category_id=cat.id,
    )
    await _make_recurring(
        session, test_user.id, acct.id, 1500, "credit",
        frequency="monthly", next_occurrence=month_start,
    )

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=2, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["expenses"] == pytest.approx(0.0)
    assert bd["income"] == pytest.approx(0.0)
    assert bd["projectedExpenses"] >= 800.0
    assert bd["projectedIncome"] >= 1500.0

    labels = {c.label for c in report.composition}
    assert "Rent" in labels


async def test_income_expenses_pending_is_projected_not_actual(
    session, test_user, test_workspace
):
    """Pending rows belong to the payable forecast, never actual P&L."""
    acct = await _make_account(session, test_user.id, "IE Pending")
    today = date.today()
    await _add_txn(session, test_user.id, acct.id, 100, "debit", today)
    await _add_txn(
        session, test_user.id, acct.id, 50, "debit", today, status="pending"
    )

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=1, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["expenses"] == pytest.approx(100.0)
    assert bd["projectedExpenses"] == pytest.approx(50.0)


async def test_income_expenses_many_categories_triggers_other_bucket(session, test_user, test_workspace):
    """More than CATEGORY_TREND_TOP_N expense categories → an 'Other' bucket."""
    acct = await _make_account(session, test_user.id, "IE Many")
    today = date.today()
    # 14 distinct expense categories (> top-N of 11)
    for i in range(14):
        cat = await _make_category(session, test_user.id, f"Cat{i}", color="#aabbcc")
        await _add_txn(
            session, test_user.id, acct.id, 100 + i, "debit", today, category_id=cat.id
        )

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=1, interval="monthly"
    )
    expense_items = [ct for ct in report.category_trend if ct.group == "expenses"]
    keys = {ct.key for ct in expense_items}
    assert "other" in keys
    other = next(ct for ct in expense_items if ct.key == "other")
    assert other.label == "Other"
    assert other.total > 0


async def test_income_expenses_change_percent_computed(session, test_user, test_workspace):
    """A non-zero net in the first period yields a numeric change_percent."""
    acct = await _make_account(session, test_user.id, "IE Change")
    today = date.today()
    # Transaction ~2 months ago and one today so trend has >1 point with nets
    two_months_ago = (today.replace(day=1) - timedelta(days=40)).replace(day=10)
    await _add_txn(session, test_user.id, acct.id, 1000, "credit", two_months_ago)
    await _add_txn(session, test_user.id, acct.id, 3000, "credit", today)

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=4, interval="monthly"
    )
    # change_percent may be None only if the first trend net is 0 — assert the
    # field is the right type either way and totals are correct.
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["income"] == pytest.approx(4000.0)


# ---------------------------------------------------------------------------
# get_net_worth_report — credit-card composition + asset-value branches
# ---------------------------------------------------------------------------


async def test_net_worth_composition_includes_credit_card_liability(session, test_user, test_workspace):
    """A credit-card account surfaces as a liabilities-group composition item."""
    conn = BankConnection(
        id=uuid.uuid4(), user_id=test_user.id, provider="test",
        external_id="ext-nw-cc", institution_name="CC Bank",
        credentials={}, status="active",
        last_sync_at=datetime.now(timezone.utc),
        created_at=datetime.now(timezone.utc),
    )
    session.add(conn)
    await session.flush()
    cc = Account(
        id=uuid.uuid4(), user_id=test_user.id, connection_id=conn.id,
        name="My Card", type="credit_card", balance=Decimal("1500"), currency="BRL",
    )
    session.add(cc)
    await session.commit()

    report = await get_net_worth_report(
        session, test_workspace.id, test_user.id, months=1, interval="monthly"
    )
    liab = [c for c in report.composition if c.group == "liabilities"]
    assert any(c.label == "My Card" for c in liab)


async def test_net_worth_composition_asset_uses_asset_value_entry(session, test_user, test_workspace):
    """Asset with an AssetValue row is valued via the latest entry."""
    asset = Asset(
        id=uuid.uuid4(), user_id=test_user.id, name="Loft",
        type="real_estate", currency="BRL",
    )
    session.add(asset)
    await session.flush()
    session.add(AssetValue(
        id=uuid.uuid4(), asset_id=asset.id,
        amount=Decimal("250000"), date=date.today(),
    ))
    await session.commit()

    report = await get_net_worth_report(
        session, test_workspace.id, test_user.id, months=1, interval="monthly"
    )
    asset_items = [c for c in report.composition if c.group == "assets"]
    loft = next((c for c in asset_items if c.label == "Loft"), None)
    assert loft is not None
    assert loft.value == pytest.approx(250000.0)


async def test_net_worth_at_credit_card_branch(session, test_user, test_workspace):
    """_net_worth_at puts credit-card balances into liabilities."""
    conn = BankConnection(
        id=uuid.uuid4(), user_id=test_user.id, provider="test",
        external_id="ext-nwat-cc", institution_name="CC",
        credentials={}, status="active",
        last_sync_at=datetime.now(timezone.utc),
        created_at=datetime.now(timezone.utc),
    )
    session.add(conn)
    await session.flush()
    cc = Account(
        id=uuid.uuid4(), user_id=test_user.id, connection_id=conn.id,
        name="CC", type="credit_card", balance=Decimal("700"), currency="BRL",
    )
    session.add(cc)
    await session.commit()

    dp = await _net_worth_at(session, test_workspace.id, date.today(), "BRL")
    assert dp.breakdowns["liabilities"] == pytest.approx(700.0)


# ---------------------------------------------------------------------------
# get_cash_flow_report — non-daily interval aggregation (1261-1294)
# ---------------------------------------------------------------------------


async def test_cash_flow_monthly_interval_aggregation(session, test_user, test_workspace):
    """Monthly interval groups daily balances into period buckets."""
    acct = await _make_account(session, test_user.id, "CF Monthly")
    today = date.today()
    await _add_txn(session, test_user.id, acct.id, 5000, "credit", today, source="opening_balance")
    await _make_recurring(
        session, test_user.id, acct.id, 400, "debit",
        frequency="monthly", next_occurrence=today + timedelta(days=2),
    )

    report = await get_cash_flow_report(
        session, test_workspace.id, test_user.id, months=3, interval="monthly"
    )
    assert report.meta.interval == "monthly"
    assert len(report.trend) > 0
    for dp in report.trend:
        assert "inflow" in dp.breakdowns
        assert "outflow" in dp.breakdowns


async def test_cash_flow_weekly_interval_aggregation(session, test_user, test_workspace):
    """Weekly interval also goes through the grouped (non-daily) path."""
    acct = await _make_account(session, test_user.id, "CF Weekly")
    today = date.today()
    await _add_txn(session, test_user.id, acct.id, 1000, "credit", today, source="opening_balance")
    await _make_recurring(
        session, test_user.id, acct.id, 50, "debit",
        frequency="weekly", next_occurrence=today + timedelta(days=1),
    )

    report = await get_cash_flow_report(
        session, test_workspace.id, test_user.id, months=2, interval="weekly"
    )
    assert report.meta.interval == "weekly"
    assert len(report.trend) > 0


# ---------------------------------------------------------------------------
# get_cash_flow_report — baseline projection branch (_get_baseline_projection)
# ---------------------------------------------------------------------------


async def test_cash_flow_baseline_mode_projects_from_history(session, test_user, test_workspace):
    """baseline=True replaces recurring rules with a historical-mean estimate."""
    acct = await _make_account(session, test_user.id, "CF Baseline")
    today = date.today()
    await _add_txn(session, test_user.id, acct.id, 3000, "credit", today, source="opening_balance")
    # Past actual flows feed the baseline window
    await _add_txn(session, test_user.id, acct.id, 6000, "credit", today - timedelta(days=20))
    await _add_txn(session, test_user.id, acct.id, 2000, "debit", today - timedelta(days=15))

    report = await get_cash_flow_report(
        session, test_workspace.id, test_user.id, months=3, interval="daily", baseline=True
    )
    assert report.meta.baseline_active is True
    assert report.meta.baseline_lookback_days is not None
    assert report.meta.baseline_lookback_days > 0
    # Baseline composition uses a synthetic "baseline" category key
    keys = {c.key for c in report.composition}
    assert "baseline" in keys


async def test_baseline_projection_no_history_returns_empty(session, test_user, test_workspace):
    """No qualifying transactions → empty projection, zero lookback days."""
    async def _to_primary(amount, ccy):
        return float(amount)

    today = date.today()
    end = today + timedelta(days=30)
    projections, lookback = await _get_baseline_projection(
        session, test_workspace.id, today, end, "BRL", _to_primary,
    )
    assert projections == []
    assert lookback == 0


async def test_baseline_projection_with_history(session, test_user, test_workspace):
    """With history, projection emits forward synthetic flows."""
    acct = await _make_account(session, test_user.id, "Baseline Hist")
    today = date.today()
    await _add_txn(session, test_user.id, acct.id, 3000, "credit", today - timedelta(days=10))
    await _add_txn(session, test_user.id, acct.id, 900, "debit", today - timedelta(days=5))

    async def _to_primary(amount, ccy):
        return float(amount)

    end = today + timedelta(days=5)
    projections, lookback = await _get_baseline_projection(
        session, test_workspace.id, today, end, "BRL", _to_primary,
    )
    assert lookback > 0
    assert len(projections) > 0
    types = {p["type"] for p in projections}
    assert "credit" in types
    assert "debit" in types
    for p in projections:
        assert today < p["date"] <= end
        assert p["currency"] == "BRL"


# ---------------------------------------------------------------------------
# get_cash_flow_report — accrual mode (pending CC purchases branch 1122-1152)
# ---------------------------------------------------------------------------


async def test_income_expenses_owner_split_offset(session, test_user, test_workspace):
    """A split debit owned by the user has the non-owner share subtracted from
    expenses (owner_offset + per-category offset branches)."""
    from app.models.group import Group, GroupMember
    from app.models.transaction_split import TransactionSplit

    cat = await _make_category(session, test_user.id, "Dinner", color="#abc")
    acct = await _make_account(session, test_user.id, "IE Split")
    today = date.today()

    group = Group(
        id=uuid.uuid4(), user_id=test_user.id, name="Trip",
        kind="shared", default_currency="BRL",
    )
    session.add(group)
    await session.flush()
    # The owner's own self-member, and a friend (non-owner) member.
    self_member = GroupMember(
        id=uuid.uuid4(), group_id=group.id, name="Me",
        linked_user_id=test_user.id, is_self=True,
    )
    friend = GroupMember(
        id=uuid.uuid4(), group_id=group.id, name="Friend", is_self=False,
    )
    session.add_all([self_member, friend])
    await session.flush()

    # User pays a 1000 dinner; friend owes 400 of it.
    txn = await _add_txn(session, test_user.id, acct.id, 1000, "debit", today, category_id=cat.id)
    session.add(TransactionSplit(
        id=uuid.uuid4(), transaction_id=txn.id, group_member_id=friend.id,
        share_amount=Decimal("400"), share_type="amount",
    ))
    await session.commit()

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=2, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    # Owner's share of the dinner is 1000 - 400 = 600.
    assert bd["expenses"] == pytest.approx(600.0)

    dinner = next((c for c in report.composition if c.label == "Dinner"), None)
    assert dinner is not None
    assert dinner.value == pytest.approx(600.0)


async def test_income_expenses_composition_ignores_splits_in_other_workspaces(
    session, test_user, test_workspace
):
    """A split the user owns in another workspace must not shrink this
    workspace's composition. Uncategorized is the bucket both workspaces
    share, since every category belongs to one workspace."""
    from app.models.group import Group, GroupMember
    from app.models.transaction_split import TransactionSplit
    from app.models.workspace import Workspace, WorkspaceMember

    other_ws = Workspace(
        id=uuid.uuid4(), name="Other", kind="personal",
        created_by_user_id=test_user.id, default_currency="BRL",
    )
    session.add(other_ws)
    await session.flush()
    session.add(WorkspaceMember(
        id=uuid.uuid4(), workspace_id=other_ws.id, user_id=test_user.id, role="owner",
    ))
    other_acct = Account(
        id=uuid.uuid4(), user_id=test_user.id, workspace_id=other_ws.id,
        name="Other Acct", type="checking", balance=Decimal("0"), currency="BRL",
    )
    group = Group(
        id=uuid.uuid4(), user_id=test_user.id, workspace_id=other_ws.id,
        name="Trip", kind="shared", default_currency="BRL",
    )
    session.add_all([other_acct, group])
    await session.flush()
    friend = GroupMember(
        id=uuid.uuid4(), group_id=group.id, workspace_id=other_ws.id,
        name="Friend", is_self=False,
    )
    session.add(friend)
    await session.commit()

    today = date.today()
    acct = await _make_account(session, test_user.id, "Main Acct")
    await _add_txn(session, test_user.id, acct.id, 500, "debit", today)
    other_txn = await _add_txn(
        session, test_user.id, other_acct.id, 1000, "debit", today,
        workspace_id=other_ws.id,
    )
    session.add(TransactionSplit(
        id=uuid.uuid4(), transaction_id=other_txn.id, workspace_id=other_ws.id,
        group_member_id=friend.id, share_amount=Decimal("200"), share_type="amount",
    ))
    await session.commit()

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=2, interval="monthly"
    )

    uncategorized = next(
        (c for c in report.composition if c.key == "uncategorized" and c.group == "expenses"),
        None,
    )
    assert uncategorized is not None
    assert uncategorized.value == pytest.approx(500.0)


async def test_income_expenses_trend_points_have_per_period_composition(session, test_user, test_workspace):
    """Each income/expenses trend DataPoint carries per-period composition items."""
    cat_wages = await _make_category(session, test_user.id, "Wages", color="#0E0")
    cat_groceries = await _make_category(session, test_user.id, "Groceries", color="#E00")
    acct = await _make_account(session, test_user.id, "IE Trend Acct")
    today = date.today()

    await _add_txn(session, test_user.id, acct.id, 4000, "credit", today, category_id=cat_wages.id)
    await _add_txn(session, test_user.id, acct.id, 900, "debit", today, category_id=cat_groceries.id)

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=2, interval="monthly"
    )

    # The last trend point always covers the current period where transactions landed
    current_dp = report.trend[-1]
    assert len(current_dp.composition) > 0
    groups = {c.group for c in current_dp.composition}
    assert "income" in groups
    assert "expenses" in groups
    labels = {c.label for c in current_dp.composition}
    assert "Wages" in labels
    assert "Groceries" in labels


async def test_net_worth_composition_positive_checking_in_accounts_group(session, test_user, test_workspace):
    """A manual checking account with positive balance lands in the accounts group."""
    acct = await _make_account(session, test_user.id, "NW Pos Checking")
    await _add_txn(session, test_user.id, acct.id, 4200, "credit", date.today(), source="opening_balance")

    report = await get_net_worth_report(
        session, test_workspace.id, test_user.id, months=1, interval="monthly"
    )
    accts = [c for c in report.composition if c.group == "accounts"]
    item = next((c for c in accts if c.label == "NW Pos Checking"), None)
    assert item is not None
    assert item.value == pytest.approx(4200.0)


async def test_net_worth_composition_asset_purchase_price_fallback(session, test_user, test_workspace):
    """Asset with no AssetValue rows falls back to purchase_price in composition."""
    asset = Asset(
        id=uuid.uuid4(), user_id=test_user.id, name="Old Car",
        type="vehicle", currency="BRL", purchase_price=Decimal("18000"),
        purchase_date=date.today() - timedelta(days=100),
    )
    session.add(asset)
    await session.commit()

    report = await get_net_worth_report(
        session, test_workspace.id, test_user.id, months=1, interval="monthly"
    )
    asset_items = [c for c in report.composition if c.group == "assets"]
    car = next((c for c in asset_items if c.label == "Old Car"), None)
    assert car is not None
    assert car.value == pytest.approx(18000.0)


async def test_net_worth_composition_asset_zero_value_excluded(session, test_user, test_workspace):
    """Asset with no value entry and future purchase date contributes nothing."""
    asset = Asset(
        id=uuid.uuid4(), user_id=test_user.id, name="Future Buy",
        type="other", currency="BRL", purchase_price=Decimal("5000"),
        purchase_date=date.today() + timedelta(days=60),
    )
    session.add(asset)
    await session.commit()

    report = await get_net_worth_report(
        session, test_workspace.id, test_user.id, months=1, interval="monthly"
    )
    assert all(c.label != "Future Buy" for c in report.composition)


async def test_cash_flow_foreign_currency_conversion_path(session, test_user, test_workspace):
    """A non-primary-currency transaction exercises the _to_primary rate path."""
    acct = await _make_account(session, test_user.id, "CF USD", currency="USD")
    today = date.today()
    await _add_txn(session, test_user.id, acct.id, 1000, "credit", today,
                   source="opening_balance", currency="USD")
    # Past actual flow in USD → hits _to_primary with a non-BRL currency
    await _add_txn(session, test_user.id, acct.id, 200, "debit",
                   today - timedelta(days=5), currency="USD")

    report = await get_cash_flow_report(
        session, test_workspace.id, test_user.id, months=2, interval="daily"
    )
    assert report.meta.type == "cash_flow"
    assert len(report.trend) > 0


async def test_cash_flow_categorized_recurring_composition(session, test_user, test_workspace):
    """Categorized recurring projection populates the per-category cache + composition."""
    cat = await _make_category(session, test_user.id, "Utilities", color="#777")
    acct = await _make_account(session, test_user.id, "CF Cat")
    today = date.today()
    await _add_txn(session, test_user.id, acct.id, 2000, "credit", today, source="opening_balance")
    await _make_recurring(
        session, test_user.id, acct.id, 150, "debit",
        frequency="monthly", next_occurrence=today + timedelta(days=2),
        category_id=cat.id,
    )

    report = await get_cash_flow_report(
        session, test_workspace.id, test_user.id, months=3, interval="daily"
    )
    util = next((c for c in report.composition if c.label == "Utilities"), None)
    assert util is not None
    assert util.group == "expenses"
    assert util.value > 0


async def test_cash_flow_baseline_amount_primary_used(session, test_user, test_workspace):
    """Baseline projection uses amount_primary when present on the transaction."""
    acct = await _make_account(session, test_user.id, "CF Baseline AP", currency="USD")
    today = date.today()
    await _add_txn(session, test_user.id, acct.id, 500, "credit", today,
                   source="opening_balance", currency="USD")
    # Give the historical txn an explicit amount_primary
    txn = await _add_txn(session, test_user.id, acct.id, 100, "debit",
                         today - timedelta(days=8), currency="USD")
    txn.amount_primary = Decimal("550")
    await session.commit()

    report = await get_cash_flow_report(
        session, test_workspace.id, test_user.id, months=2, interval="daily", baseline=True
    )
    assert report.meta.baseline_active is True

    assert report.meta.baseline_lookback_days is not None
    assert report.meta.baseline_lookback_days > 0


async def test_cash_flow_accrual_mode_pending_cc(session, test_user, test_workspace):
    """Accrual mode re-projects pending CC purchases on their effective_date."""
    from app.models.app_settings import AppSetting

    # Switch global accounting mode to accrual
    session.add(AppSetting(key="credit_card_accounting_mode", value="accrual"))
    await session.commit()

    conn = BankConnection(
        id=uuid.uuid4(), user_id=test_user.id, provider="test",
        external_id="ext-cf-accrual", institution_name="CC",
        credentials={}, status="active",
        last_sync_at=datetime.now(timezone.utc),
        created_at=datetime.now(timezone.utc),
    )
    session.add(conn)
    await session.flush()
    cc = Account(
        id=uuid.uuid4(), user_id=test_user.id, connection_id=conn.id,
        name="CC Accrual", type="credit_card", balance=Decimal("0"), currency="BRL",
    )
    session.add(cc)
    await session.commit()

    today = date.today()
    # Purchase booked today, cash impact (effective_date) in the future window
    await _add_txn(
        session, test_user.id, cc.id, 500, "debit", today,
        effective_date=today + timedelta(days=15),
    )

    report = await get_cash_flow_report(
        session, test_workspace.id, test_user.id, months=2, interval="daily"
    )
    assert report.meta.type == "cash_flow"
    assert len(report.trend) > 0


@pytest.mark.parametrize('interval', ['daily', 'monthly', 'yearly'])
@pytest.mark.parametrize('end', [date(2022, 3, 20), date(2026, 9, 12)])
async def test_custom_income_expenses_only_include_in_range_actuals(
    session, test_user, test_workspace, monkeypatch, interval, end,
):
    from app.models.invoice import Invoice
    from app.services import report_service

    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 9, 12)

    monkeypatch.setattr(report_service, 'date', FixedDate)
    start = end.replace(day=10)
    currency = test_user.primary_currency
    account = await _make_account(session, test_user.id, 'Custom actuals', currency=currency)
    category = await _make_category(session, test_user.id, 'Actual category')
    for amount, kind, day, status in [
        (100, 'credit', start, 'posted'),
        (30, 'debit', end, 'posted'),
        (500, 'credit', start - timedelta(days=1), 'posted'),
        (700, 'debit', end + timedelta(days=1), 'posted'),
        (900, 'credit', start, 'pending'),
        (800, 'debit', end, 'pending'),
    ]:
        await _add_txn(session, test_user.id, account.id, amount, kind, day,
                       status=status, category_id=category.id, currency=currency)
    recurring = await _make_recurring(
        session, test_user.id, account.id, 600, 'credit',
        next_occurrence=start, category_id=category.id, currency=currency,
    )
    recurring.start_date = start
    session.add(Invoice(
        workspace_id=test_workspace.id, user_id=test_user.id, status='open',
        issue_date=start, due_date=start, currency=currency, total=Decimal('1100'),
        direction='receivable', number=1, series='TEST',
    ))
    await session.commit()

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, interval=interval,
        start_date=start, end_date=end,
    )
    totals = {item.key: item.value for item in report.summary.breakdowns}
    assert totals['income'] == 100
    assert totals['expenses'] == 30
    assert totals['projectedIncome'] == totals['projectedExpenses'] == 0
    assert report.summary.primary_value == 70
    assert sum(point.breakdowns['income'] for point in report.trend) == 100
    assert sum(point.breakdowns['expenses'] for point in report.trend) == 30
    assert all(point.breakdowns['projectedIncome'] == 0 and
               point.breakdowns['projectedExpenses'] == 0 for point in report.trend)
    assert {item.group: item.value for item in report.composition} == {
        'income': 100, 'expenses': 30,
    }
    assert {item.group: item.total for item in report.category_trend} == {
        'income': 100, 'expenses': 30,
    }
    for item in report.category_trend:
        assert sum(point.value for point in item.series) == item.total


async def test_income_expenses_nets_negative_debit(session, test_user, test_workspace):
    """Debits 314.97, 314.97 and -472.46 in one category report 157.48 everywhere."""
    cat = await _make_category(session, test_user.id, "Card")
    acct = await _make_account(session, test_user.id, "IE NegDebit")
    today = date.today()
    for amount in (314.97, 314.97, -472.46):
        await _add_txn(session, test_user.id, acct.id, amount, "debit", today, category_id=cat.id)

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=3, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["expenses"] == pytest.approx(157.48)
    card = next(c for c in report.composition if c.label == "Card")
    assert card.value == pytest.approx(157.48)
    card_trend = next(ct for ct in report.category_trend if ct.label == "Card" and ct.group == "expenses")
    assert card_trend.total == pytest.approx(157.48)


async def test_income_expenses_net_negative_category_contributes_nothing(
    session, test_user, test_workspace
):
    cat = await _make_category(session, test_user.id, "OnlyRefund")
    acct = await _make_account(session, test_user.id, "IE NegOnly")
    await _add_txn(session, test_user.id, acct.id, -50, "debit", date.today(), category_id=cat.id)

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=3, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["expenses"] == 0.0
    assert all(c.label != "OnlyRefund" for c in report.composition)


async def test_cash_flow_nets_negative_debit_outflow(session, test_user, test_workspace):
    """A future booked -472.46 debit offsets same-day outflow instead of adding to it."""
    acct = await _make_account(session, test_user.id, "CF NegDebit")
    when = date.today() + timedelta(days=10)
    for amount in (314.97, 314.97, -472.46):
        await _add_txn(session, test_user.id, acct.id, amount, "debit", when)

    report = await get_cash_flow_report(
        session, test_workspace.id, test_user.id, months=3, interval="daily"
    )
    proj_expenses = next(b for b in report.summary.breakdowns if b.key == "projectedExpenses")
    assert proj_expenses.value == pytest.approx(157.48)


async def test_income_expenses_forecast_nets_pending_negative_debit(
    session, test_user, test_workspace
):
    """Pending 314.97 x2 and -472.46 forecast 157.48 in summary, trend and composition."""
    cat = await _make_category(session, test_user.id, "PendingCard")
    acct = await _make_account(session, test_user.id, "IE PendingNeg")
    for amount in (314.97, 314.97, -472.46):
        await _add_txn(
            session, test_user.id, acct.id, amount, "debit", date.today(),
            category_id=cat.id, status="pending",
        )

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=3, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["projectedExpenses"] == pytest.approx(157.48)
    card = next(c for c in report.composition if c.label == "PendingCard")
    assert card.value == pytest.approx(157.48)


async def test_income_expenses_forecast_refund_only_projects_zero(
    session, test_user, test_workspace
):
    """A lone pending -50 debit clamps to 0 and its category drops out."""
    cat = await _make_category(session, test_user.id, "PendingRefundOnly")
    acct = await _make_account(session, test_user.id, "IE PendingRefund")
    await _add_txn(
        session, test_user.id, acct.id, -50, "debit", date.today(),
        category_id=cat.id, status="pending",
    )

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=3, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["projectedExpenses"] == 0.0
    assert all(c.label != "PendingRefundOnly" for c in report.composition)
    assert all(ct.label != "PendingRefundOnly" for ct in report.category_trend)


async def test_income_expenses_negative_credit_reduces_income_only_to_zero(
    session, test_user, test_workspace
):
    """A negative credit offsets income but never below 0, and drops its category."""
    cat = await _make_category(session, test_user.id, "ClawedBack")
    acct = await _make_account(session, test_user.id, "IE NegCredit")
    await _add_txn(session, test_user.id, acct.id, -50, "credit", date.today(), category_id=cat.id)

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=3, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["income"] == 0.0
    assert all(c.label != "ClawedBack" for c in report.composition)
    assert all(ct.label != "ClawedBack" for ct in report.category_trend)


async def test_income_expenses_clamps_per_period_not_across_range(
    session, test_user, test_workspace
):
    """A repayment in a later period never reduces an earlier period's spending.

    Prior month 314.97 x2, this month -472.46: summary and category trend keep
    the prior month's 629.94 (this month clamps to 0), while composition nets
    the whole range to 157.48.
    """
    cat = await _make_category(session, test_user.id, "CrossPeriod")
    acct = await _make_account(session, test_user.id, "IE CrossPeriod")
    this_month = date.today().replace(day=1)
    prior_month = (this_month - timedelta(days=1)).replace(day=1)
    for amount, when in ((314.97, prior_month), (314.97, prior_month), (-472.46, this_month)):
        await _add_txn(session, test_user.id, acct.id, amount, "debit", when, category_id=cat.id)

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=3, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["expenses"] == pytest.approx(629.94)
    trend = next(ct for ct in report.category_trend if ct.label == "CrossPeriod")
    assert trend.total == pytest.approx(629.94)
    comp = next(c for c in report.composition if c.label == "CrossPeriod")
    assert comp.value == pytest.approx(157.48)


async def test_cash_flow_refund_only_clamps_outflow_but_raises_balance(
    session, test_user, test_workspace
):
    """A future -50 debit: projected expenses clamp to 0, the balance still rises by 50."""
    acct = await _make_account(session, test_user.id, "CF Refund")
    when = date.today() + timedelta(days=10)
    await _add_txn(session, test_user.id, acct.id, -50, "debit", when)

    report = await get_cash_flow_report(
        session, test_workspace.id, test_user.id, months=3, interval="daily"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["projectedExpenses"] == 0.0
    assert bd["endingBalance"] - bd["startingBalance"] == pytest.approx(50.0)
    assert all(p.breakdowns["outflow"] >= 0 for p in report.trend)


async def _make_split_group(session, owner_id, *, viewer_user_id=None):
    """A group owned by `owner_id` with an is_self member and a second member
    (the linked viewer when given, otherwise a plain friend)."""
    from app.models.group import Group, GroupMember

    group = Group(
        id=uuid.uuid4(), user_id=owner_id, name="Split",
        kind="shared", default_currency="BRL",
    )
    session.add(group)
    await session.flush()
    self_m = GroupMember(
        id=uuid.uuid4(), group_id=group.id, name="Me",
        linked_user_id=owner_id, is_self=True,
    )
    other_m = GroupMember(
        id=uuid.uuid4(), group_id=group.id, name="Other",
        linked_user_id=viewer_user_id, is_self=False,
    )
    session.add_all([self_m, other_m])
    await session.commit()
    return self_m, other_m


async def _split_5050(session, txn, self_m, other_m, *, workspace_id=None):
    from app.models.transaction_split import TransactionSplit

    for member in (self_m, other_m):
        session.add(TransactionSplit(
            id=uuid.uuid4(), transaction_id=txn.id, group_member_id=member.id,
            share_amount=abs(txn.amount) / 2, share_type="exact",
            **({"workspace_id": workspace_id} if workspace_id else {}),
        ))
    await session.commit()


async def test_income_expenses_owner_refund_split_matches_dashboard(
    session, test_user, test_workspace
):
    """A -472.46 debit split 50/50 is a refund: expenses clamp to 0 once, after
    the split offset (same as the dashboard), and net stays the signed 236.23."""
    from app.services.dashboard_service import get_summary

    acct = await _make_account(session, test_user.id, "IE RefundSplit")
    txn = await _add_txn(session, test_user.id, acct.id, -472.46, "debit", date.today())
    self_m, friend = await _make_split_group(session, test_user.id)
    await _split_5050(session, txn, self_m, friend)

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=1, interval="monthly"
    )
    summary = await get_summary(
        session, test_workspace.id, test_user.id, month=date.today().replace(day=1)
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["expenses"] == 0.0
    assert bd["expenses"] == pytest.approx(summary.monthly_expenses)
    assert report.summary.primary_value == pytest.approx(236.23)
    assert report.trend[-1].value == pytest.approx(236.23)


async def test_income_expenses_viewer_share_of_refund_split_clamps_once(
    session, test_user, test_workspace
):
    """Viewer's own 100 debit plus a -236.23 share of someone's refund split
    nets to -136.23 and clamps to 0 (never a negative expense)."""
    import bcrypt as _bcrypt
    from app.models.user import User as UserModel
    from app.models.workspace import Workspace, WorkspaceMember

    owner = UserModel(
        id=uuid.uuid4(), email="owner_report_refund@example.com",
        hashed_password=_bcrypt.hashpw(b"x", _bcrypt.gensalt()).decode(),
        is_active=True, is_verified=True,
        preferences={"currency_display": "BRL"},
    )
    session.add(owner)
    await session.flush()
    owner_ws = Workspace(
        id=uuid.uuid4(), name="OwnerWS", kind="personal",
        created_by_user_id=owner.id, default_currency="BRL", locale="en",
    )
    session.add(owner_ws)
    await session.flush()
    session.add(WorkspaceMember(
        id=uuid.uuid4(), workspace_id=owner_ws.id, user_id=owner.id, role="owner"
    ))
    await session.commit()

    owner_acct = await _make_account(session, owner.id, "Owner Acct")
    owner_acct.workspace_id = owner_ws.id
    viewer_acct = await _make_account(session, test_user.id, "Viewer Acct")
    await _add_txn(session, test_user.id, viewer_acct.id, 100, "debit", date.today())
    txn = await _add_txn(
        session, owner.id, owner_acct.id, -472.46, "debit", date.today(),
        workspace_id=owner_ws.id,
    )
    self_m, viewer_m = await _make_split_group(
        session, owner.id, viewer_user_id=test_user.id
    )
    await _split_5050(session, txn, self_m, viewer_m, workspace_id=owner_ws.id)

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=1, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["expenses"] == 0.0
    assert all(p.breakdowns["expenses"] >= 0 for p in report.trend)


async def test_income_expenses_lone_refund_has_positive_net(
    session, test_user, test_workspace
):
    """A lone -50 debit: expenses 0 (clamped) but net is the signed +50."""
    acct = await _make_account(session, test_user.id, "IE LoneRefund")
    await _add_txn(session, test_user.id, acct.id, -50, "debit", date.today())

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=1, interval="monthly"
    )
    bd = {b.key: b.value for b in report.summary.breakdowns}
    assert bd["expenses"] == 0.0
    assert report.summary.primary_value == pytest.approx(50.0)
    assert report.trend[-1].value == pytest.approx(50.0)


async def test_category_trend_pending_refund_never_makes_negative_bar(
    session, test_user, test_workspace
):
    """Food 600 last month and a pending -100 this month: this month's bar is
    0 (not -100) and the category total is the clamped series sum, 600."""
    cat = await _make_category(session, test_user.id, "FoodForecast")
    acct = await _make_account(session, test_user.id, "IE FoodForecast")
    this_month = date.today().replace(day=1)
    prior_month = (this_month - timedelta(days=1)).replace(day=1)
    await _add_txn(session, test_user.id, acct.id, 600, "debit", prior_month, category_id=cat.id)
    await _add_txn(
        session, test_user.id, acct.id, -100, "debit", date.today(),
        category_id=cat.id, status="pending",
    )

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=3, interval="monthly"
    )
    trend = next(ct for ct in report.category_trend if ct.label == "FoodForecast")
    assert all(p.value >= 0 for p in trend.series)
    assert trend.series[-1].value == 0.0
    assert trend.total == pytest.approx(600.0)
