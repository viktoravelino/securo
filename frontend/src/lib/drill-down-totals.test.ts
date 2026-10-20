import { describe, expect, it } from 'vitest'

import { sumDrillDownTotals } from '@/lib/drill-down-totals'
import type { DrillDownTotalsItem } from '@/lib/drill-down-totals'

const row = (overrides: Partial<DrillDownTotalsItem> = {}): DrillDownTotalsItem => ({
  type: 'debit',
  amount: 100,
  amountPrimary: null,
  currency: 'USD',
  isPending: false,
  isProjected: false,
  ...overrides,
})

describe('sumDrillDownTotals', () => {
  it('splits rows into posted, pending and projected', () => {
    const totals = sumDrillDownTotals([
      row({ amount: 200 }),
      row({ amount: 100, isPending: true }),
      row({ amount: 487.68, isProjected: true }),
    ], 'USD', null)

    expect(totals.postedTotal).toBeCloseTo(200)
    expect(totals.pendingTotal).toBeCloseTo(100)
    expect(totals.projectedTotal).toBeCloseTo(487.68)
    expect(totals.total).toBeCloseTo(787.68)
  })

  it('keeps a projected row inside the total when the panel also has a pending one', () => {
    // The regression: a projected row is neither posted nor pending, so
    // bucketing it by transaction status dropped it from the footer while
    // the list above still showed it.
    const totals = sumDrillDownTotals([
      row({ amount: 100, isPending: true }),
      row({ amount: 487.68, isProjected: true }),
    ], 'USD', null)

    expect(totals.postedTotal + totals.pendingTotal + totals.projectedTotal)
      .toBeCloseTo(totals.total)
    expect(totals.total).toBeCloseTo(587.68)
  })

  it('never loses a row: the three buckets always rebuild the total', () => {
    const totals = sumDrillDownTotals([
      row({ amount: 10 }),
      row({ amount: 20, isPending: true }),
      row({ amount: 30, isProjected: true }),
      row({ amount: 40, isPending: true, isProjected: true }),
    ], 'USD', null)

    expect(totals.postedTotal + totals.pendingTotal + totals.projectedTotal)
      .toBeCloseTo(totals.total)
  })

  it('counts a foreign row through its primary amount', () => {
    expect(sumDrillDownTotals([
      row({ amount: 2500, amountPrimary: 487.68, currency: 'BRL' }),
    ], 'USD', null)).toMatchObject({ total: 487.68, postedTotal: 487.68 })
  })

  it('skips a foreign row with no conversion rather than counting it raw', () => {
    expect(sumDrillDownTotals([
      row({ amount: 2500, amountPrimary: null, currency: 'BRL' }),
    ], 'USD', null)).toEqual({
      total: 0,
      postedTotal: 0,
      pendingTotal: 0,
      projectedTotal: 0,
    })
  })

  it('nets a negative debit against the spending it repays in a debit-filtered list', () => {
    const totals = sumDrillDownTotals([
      row({ amount: 314.97 }),
      row({ amount: 314.97 }),
      row({ amount: -472.46 }),
    ], 'USD', 'debit')

    expect(totals.total).toBeCloseTo(157.48)
    expect(totals.postedTotal).toBeCloseTo(157.48)
  })

  it('shows a debit-filtered list of only a repayment as negative spending', () => {
    expect(sumDrillDownTotals([row({ amount: -472.46 })], 'USD', 'debit').total)
      .toBeCloseTo(-472.46)
  })

  it('reads a credit-filtered list in the inflow direction', () => {
    expect(sumDrillDownTotals([
      row({ type: 'credit', amount: 100 }),
      row({ type: 'credit', amount: 50, isPending: true }),
      row({ type: 'credit', amount: -30 }),
    ], 'USD', 'credit')).toMatchObject({ total: 120, postedTotal: 70, pendingTotal: 50 })
  })

  it('sums magnitudes when there is no type filter', () => {
    expect(sumDrillDownTotals([
      row({ type: 'credit', amount: 5000 }),
      row({ amount: 4800 }),
    ], 'USD', null).total).toBeCloseTo(9800)
  })

  it('returns zeroes for an empty panel', () => {
    expect(sumDrillDownTotals([], 'USD', null)).toEqual({
      total: 0,
      postedTotal: 0,
      pendingTotal: 0,
      projectedTotal: 0,
    })
  })
})
