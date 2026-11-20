import type { BudgetVsActual, SpendingByCategory } from '@/types'

/** One category of the ranking, with the bar positions as percentages of the track. */
export interface RankingRow {
  key: string
  name: string
  icon: string
  color: string
  amount: number
  /** Share of the month total, 0-100, not rounded. */
  share: number
  /** Last month's amount for this category, or null when it had no spending. */
  previous: number | null
  budget: number | null
  fillPct: number
  markerPct: number | null
  budgetPct: number | null
}

export interface SpendingRanking {
  rows: RankingRow[]
  /** Sum of the positive rows: the base of the share pills. */
  total: number
  /** Posted and projected spending over all rows, negatives included, as the overview card sums them. */
  spent: number
  projected: number
  /** Last month's projected spending over all rows. */
  previousProjected: number
  /** Percent change against last month, or null for the current month or when last month had none. */
  change: number | null
  /** Categories whose net is below zero this month (refunds larger than spending). */
  negatives: { key: string; name: string; amount: number }[]
  scaleMax: number
}

const keyOf = (row: SpendingByCategory) => row.category_id ?? row.category_name
// The all-in amount (settled plus pending), as the spending-by-category widget shows it.
const amountOf = (row: SpendingByCategory) => Number(row.projected_total ?? row.total)

/** Positive amounts only: a refund can net a category below zero. */
function positive(rows: SpendingByCategory[]) {
  return rows.map((row) => ({ row, amount: amountOf(row) })).filter((item) => item.amount > 0)
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

/**
 * Sorts the month's spending, largest first, and works out the share, the
 * change against last month and the bar positions. Every position is relative
 * to the largest of the amounts, last month's amounts and budgets, so each mark fits.
 * A partial current month is not compared with a full one, so it has no change.
 */
export function buildSpendingRanking(
  current: SpendingByCategory[],
  previous: SpendingByCategory[],
  budgets: BudgetVsActual[],
  isCurrentMonth = false,
): SpendingRanking {
  const items = positive(current).sort((a, b) => b.amount - a.amount)
  const total = items.reduce((sum, item) => sum + item.amount, 0)
  const previousByKey = new Map(positive(previous).map((item) => [keyOf(item.row), item.amount]))
  const previousProjected = sum(previous.map(amountOf))
  const budgetById = new Map(budgets.map((b) => [b.category_id, Number(b.budget_amount ?? 0)]))

  const base = items.map(({ row, amount }) => {
    const budget = row.category_id ? budgetById.get(row.category_id) ?? 0 : 0
    return { row, amount, previous: previousByKey.get(keyOf(row)) ?? null, budget: budget > 0 ? budget : null }
  })
  const scaleMax = Math.max(0, ...base.flatMap((r) => [r.amount, r.previous ?? 0, r.budget ?? 0]))
  const pct = (value: number) => (scaleMax > 0 ? (value / scaleMax) * 100 : 0)

  return {
    rows: base.map(({ row, amount, previous: prev, budget }) => ({
      key: keyOf(row),
      name: row.category_name,
      icon: row.category_icon,
      color: row.category_color,
      amount,
      share: total > 0 ? (amount / total) * 100 : 0,
      previous: prev,
      budget,
      fillPct: pct(amount),
      markerPct: prev !== null ? pct(prev) : null,
      budgetPct: budget !== null ? pct(budget) : null,
    })),
    total,
    spent: sum(current.map((row) => Number(row.total))),
    projected: sum(current.map(amountOf)),
    previousProjected,
    change: !isCurrentMonth && previousProjected > 0 ? ((sum(current.map(amountOf)) - previousProjected) / previousProjected) * 100 : null,
    negatives: current
      .filter((row) => amountOf(row) < 0)
      .map((row) => ({ key: keyOf(row), name: row.category_name, amount: amountOf(row) }))
      .sort((a, b) => a.amount - b.amount),
    scaleMax,
  }
}
