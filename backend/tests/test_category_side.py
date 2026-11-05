"""Refund netting: a credit in an expense category reduces that category's expenses."""
import uuid
from datetime import date

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.account_service import get_account_summary
from app.services.category_side import CategorySides, classify, get_category_sides, totals_by_side
from app.services.dashboard_service import get_spending_by_category, get_summary
from tests.test_dashboard_service import _add_txn, _make_account, _make_category

_CAT = uuid.uuid4()
_SALARY = uuid.uuid4()


def test_classify_nets_opposite_type_against_the_category_side():
    sides: CategorySides = {_CAT: "expenses", _SALARY: "income"}
    assert classify(sides, _CAT, "debit", 80.0) == ("expenses", 80.0)
    assert classify(sides, _CAT, "credit", 50.0) == ("expenses", -50.0)
    assert classify(sides, _SALARY, "credit", 900.0) == ("income", 900.0)
    assert classify(sides, _SALARY, "debit", 20.0) == ("income", -20.0)


def test_classify_leaves_uncategorized_and_unknown_categories_gross():
    assert classify({}, None, "credit", 10.0) == ("income", 10.0)
    assert classify({}, None, "debit", 10.0) == ("expenses", 10.0)
    assert classify({}, uuid.uuid4(), "credit", 10.0) == ("income", 10.0)


def test_totals_by_side_keeps_net_unchanged():
    sides: CategorySides = {_CAT: "expenses"}
    rows = [(_CAT, "debit", 80.0), (_CAT, "credit", 50.0), (None, "credit", 200.0)]
    income, expenses = totals_by_side(sides, rows)
    assert (income, expenses) == (200.0, 30.0)
    assert income - expenses == 200.0 + 50.0 - 80.0


@pytest.mark.asyncio
async def test_category_side_follows_the_larger_volume(session: AsyncSession, test_user, test_workspace):
    account = await _make_account(session, test_user.id)
    food = await _make_category(session, test_user.id, "Food")
    salary = await _make_category(session, test_user.id, "Salary")
    today = date.today()
    await _add_txn(session, test_user.id, account.id, 80, "debit", today, category_id=food.id)
    await _add_txn(session, test_user.id, account.id, 50, "credit", today, category_id=food.id)
    await _add_txn(session, test_user.id, account.id, 900, "credit", today, category_id=salary.id)
    # Pending and ignored-from-P/L history must not tip the side.
    await _add_txn(session, test_user.id, account.id, 5000, "credit", today,
                   category_id=food.id, status="pending")

    sides = await get_category_sides(session, test_workspace.id)
    assert sides == {food.id: "expenses", salary.id: "income"}


@pytest.mark.asyncio
async def test_summary_nets_refund_against_its_category(session: AsyncSession, test_user, test_workspace):
    account = await _make_account(session, test_user.id)
    food = await _make_category(session, test_user.id, "Food")
    salary = await _make_category(session, test_user.id, "Salary")
    today = date.today()
    await _add_txn(session, test_user.id, account.id, 80, "debit", today, category_id=food.id)
    await _add_txn(session, test_user.id, account.id, 50, "credit", today, category_id=food.id)
    await _add_txn(session, test_user.id, account.id, 1000, "credit", today, category_id=salary.id)
    # Uncategorized rows are never netted.
    await _add_txn(session, test_user.id, account.id, 10, "debit", today)
    await _add_txn(session, test_user.id, account.id, 5, "credit", today)

    summary = await get_summary(session, test_workspace.id, test_user.id)
    assert summary.monthly_income == pytest.approx(1005.0)
    assert summary.monthly_expenses == pytest.approx(40.0)


@pytest.mark.asyncio
async def test_spending_by_category_nets_refund_and_skips_income(
    session: AsyncSession, test_user, test_workspace
):
    account = await _make_account(session, test_user.id)
    food = await _make_category(session, test_user.id, "Food")
    salary = await _make_category(session, test_user.id, "Salary")
    today = date.today()
    await _add_txn(session, test_user.id, account.id, 80, "debit", today, category_id=food.id)
    await _add_txn(session, test_user.id, account.id, 50, "credit", today, category_id=food.id)
    await _add_txn(session, test_user.id, account.id, 1000, "credit", today, category_id=salary.id)

    spending = await get_spending_by_category(session, test_workspace.id, test_user.id)
    assert [(s.category_name, s.total) for s in spending] == [("Food", pytest.approx(30.0))]


@pytest.mark.asyncio
async def test_credit_card_refund_is_netted_in_the_bill_and_not_income(
    session: AsyncSession, test_user, test_workspace
):
    card = await _make_account(session, test_user.id, "Card", acc_type="credit_card")
    travel = await _make_category(session, test_user.id, "Travel")
    today = date.today()
    await _add_txn(session, test_user.id, card.id, 300, "debit", today, category_id=travel.id)
    await _add_txn(session, test_user.id, card.id, 100, "credit", today, category_id=travel.id)

    summary = await get_account_summary(session, card.id, test_workspace.id)
    assert summary is not None
    assert summary["monthly_expenses"] == pytest.approx(200.0)
    assert summary["monthly_income"] == pytest.approx(0.0)


@pytest.mark.asyncio
async def test_income_expenses_report_nets_refund_in_totals_and_period_composition(
    session: AsyncSession, test_user, test_workspace
):
    from app.services.report_service import get_income_expenses_report
    from tests.test_dashboard_service_coverage import _register_sqlite_to_char

    await _register_sqlite_to_char(session)
    account = await _make_account(session, test_user.id)
    food = await _make_category(session, test_user.id, "Food")
    today = date.today()
    await _add_txn(session, test_user.id, account.id, 80, "debit", today, category_id=food.id)
    await _add_txn(session, test_user.id, account.id, 50, "credit", today, category_id=food.id)

    report = await get_income_expenses_report(
        session, test_workspace.id, test_user.id, months=1, interval="monthly"
    )
    totals = {item.key: item.value for item in report.summary.breakdowns}
    assert totals["income"] == 0
    assert totals["expenses"] == 30
    assert totals["netIncome"] == -30
    assert [(c.label, c.group, c.value) for c in report.trend[-1].composition] == [
        ("Food", "expenses", 30.0)
    ]


@pytest.mark.asyncio
async def test_netted_totals_come_back_rounded_to_cents(
    session: AsyncSession, test_user, test_workspace
):
    account = await _make_account(session, test_user.id)
    food = await _make_category(session, test_user.id, "Food")
    fun = await _make_category(session, test_user.id, "Fun")
    today = date.today()
    # 0.3 - 0.1 and 0.1 + 0.2 leave float residue unless the result is rounded.
    await _add_txn(session, test_user.id, account.id, 0.3, "debit", today, category_id=food.id)
    await _add_txn(session, test_user.id, account.id, 0.1, "credit", today, category_id=food.id)
    await _add_txn(session, test_user.id, account.id, 0.1, "debit", today, category_id=fun.id)

    summary = await get_summary(session, test_workspace.id, test_user.id)
    assert summary.monthly_expenses == 0.3
    assert summary.monthly_expenses_primary == 0.3

    spending = await get_spending_by_category(session, test_workspace.id, test_user.id)
    assert {s.category_name: s.total for s in spending} == {"Food": 0.2, "Fun": 0.1}
