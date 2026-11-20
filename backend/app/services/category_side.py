"""Which side of the income statement a category sits on, and refund netting.

The app models a refund as a credit in the purchase's category. Classifying
rows only by transaction type would show that refund as income and keep the
full purchase as spending. Instead, a category has a side, and a row of the
opposite type reduces that side:

  - Expense category: expense = debits - credits (a refund lowers spending).
  - Income category: income = credits - debits.
  - Uncategorized rows keep their type: credit is income, debit is expense.

Categories have no kind column, so the side comes from the workspace's whole
posted history: debit volume >= credit volume means an expense category.
Values are never clamped at zero, so income - expenses always equals the net.
"""
import uuid
from decimal import Decimal
from typing import Iterable, Literal, TypeVar, cast

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.transaction import Transaction
from app.services._query_filters import (
    counts_as_user_pnl,
    line_category_id,
    line_primary_or_amount,
    with_category_lines,
)

Side = Literal["income", "expenses"]

# Amounts are floats in the reports and Decimals in the transaction list.
Amount = TypeVar("Amount", float, Decimal)

# category_id -> side. A category missing from the map is treated like an
# uncategorized row (no netting).
CategorySides = dict[uuid.UUID, Side]


async def get_category_sides(
    session: AsyncSession, workspace_id: uuid.UUID
) -> CategorySides:
    """Return the side of every category that has posted P/L history.

    Uses the primary-currency amount (falling back to the native amount) so
    mixed-currency volumes compare fairly. Split rows count per category line.
    """
    # A split row counts part by part, so each category line adds its own
    # share to its own category.
    part_category = line_category_id()
    amount = func.abs(line_primary_or_amount())
    result = await session.execute(
        with_category_lines(
            select(part_category, Transaction.type, func.sum(amount)).select_from(
                Transaction
            )
        )
        .where(
            Transaction.workspace_id == workspace_id,
            part_category.is_not(None),
            Transaction.source != "opening_balance",
            Transaction.status == "posted",
            counts_as_user_pnl(part_category),
        )
        .group_by(part_category, Transaction.type)
    )
    volume: dict[uuid.UUID, dict[str, float]] = {}
    for category_id, tx_type, total in result.all():
        volume.setdefault(category_id, {})[tx_type] = float(total or 0)
    return {
        category_id: (
            "expenses" if v.get("debit", 0.0) >= v.get("credit", 0.0) else "income"
        )
        for category_id, v in volume.items()
    }


def classify(
    sides: CategorySides,
    category_id: uuid.UUID | None,
    tx_type: str,
    amount: Amount,
) -> tuple[Side, Amount]:
    """Return (side, signed amount) that a row contributes to the statement.

    `amount` is a positive magnitude. The result is negative when the row
    is a credit in an expense category (a refund) or a debit in an income
    category.
    """
    natural: Side = "income" if tx_type == "credit" else "expenses"
    side = sides.get(category_id, natural) if category_id else natural
    return side, (amount if side == natural else -amount)


def totals_by_side(
    sides: CategorySides,
    rows: Iterable[tuple[uuid.UUID | None, str, Amount]],
) -> tuple[Amount, Amount]:
    """Sum (category_id, type, amount) rows into (income, expenses)."""
    income = expenses = cast(Amount, 0)
    for category_id, tx_type, amount in rows:
        side, signed = classify(sides, category_id, tx_type, amount)
        if side == "income":
            income += signed
        else:
            expenses += signed
    return income, expenses
