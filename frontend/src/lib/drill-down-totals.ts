import { signedAmount } from '@/lib/transaction-direction'

/**
 * A drill-down row, reduced to what the footer totals need. Kept structural
 * rather than importing the panel's DisplayItem so the arithmetic can be
 * tested without standing up the panel.
 */
export type DrillDownTotalsItem = {
  type: 'debit' | 'credit'
  amount: number
  amountPrimary: number | null
  currency: string
  isPending: boolean
  isProjected: boolean
}

export type DrillDownTotals = {
  total: number
  postedTotal: number
  pendingTotal: number
  projectedTotal: number
}

/**
 * Split the rows the panel is showing into the buckets the footer reports.
 *
 * Every row lands in exactly one of posted, pending or projected, so the
 * three always add back up to `total`. That invariant is the point: the
 * footer labels its bottom line "total shown", and a row the user can see in
 * the list has to be inside it. Bucketing on the row's own `isPending` and
 * `isProjected` flags, rather than on a persisted status, is what keeps
 * projections from falling through the gaps: they have no transaction behind
 * them, so a status test can never place them.
 *
 * `direction` is the panel's type filter, passed in rather than inferred from
 * the data. With a filter, rows net in that direction (see `signedAmount`): a
 * debit-filtered list with 314.97, 314.97 and a -472.46 repayment reports
 * 157.48 of spending, and a list holding only the repayment reports -472.46,
 * negative spending shown as is rather than flipped. Without a filter
 * (`null`: Uncategorized, a chart day) the list mixes credits and debits, so
 * the total is the sum of magnitudes, matching the dashboard banner's
 * pending_categorization_amount. The buckets always add back up to `total`.
 *
 * Foreign-currency rows are converted through `amountPrimary`; when that is
 * missing the row is skipped rather than added as if its raw amount were
 * already in the user's currency. This matches how `get_summary` computes
 * `monthly_*_primary` on the backend.
 */
export function sumDrillDownTotals(
  items: DrillDownTotalsItem[],
  userCurrency: string,
  direction: 'debit' | 'credit' | null,
): DrillDownTotals {
  return items.reduce<DrillDownTotals>(
    (totals, item) => {
      const signed = signedAmount({
        type: item.type,
        amount: item.currency === userCurrency ? item.amount : item.amountPrimary ?? 0,
      })
      const amount = direction === null
        ? Math.abs(signed)
        : direction === 'credit' ? signed : -signed

      totals.total += amount
      if (item.isProjected) totals.projectedTotal += amount
      else if (item.isPending) totals.pendingTotal += amount
      else totals.postedTotal += amount
      return totals
    },
    { total: 0, postedTotal: 0, pendingTotal: 0, projectedTotal: 0 },
  )
}
