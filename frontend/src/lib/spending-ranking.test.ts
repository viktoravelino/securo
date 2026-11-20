import { describe, expect, it } from 'vitest'

import { buildSpendingRanking } from './spending-ranking'
import type { BudgetVsActual, SpendingByCategory } from '@/types'

const spend = (id: string, projected: number): SpendingByCategory => ({
  category_id: id, category_name: id, category_icon: 'x', category_color: '#111', total: projected, projected_total: projected, percentage: 0,
})
const budget = (id: string, amount: number | null) => ({ category_id: id, budget_amount: amount }) as BudgetVsActual

describe('buildSpendingRanking', () => {
  it('sorts largest first, drops zero and negative rows, and shares the total', () => {
    const r = buildSpendingRanking([spend('a', 100), spend('b', 300), spend('c', 0), spend('d', -50)], [], [])
    expect(r.rows.map((row) => row.key)).toEqual(['b', 'a'])
    expect(r.total).toBe(400)
    expect(r.rows[0].share).toBe(75)
  })

  it('fits last month and budget marks on the track', () => {
    const r = buildSpendingRanking([spend('a', 100), spend('b', 50)], [spend('a', 400)], [budget('b', 200), budget('a', 0)])
    expect(r.scaleMax).toBe(400)
    expect(r.rows[0]).toMatchObject({ fillPct: 25, markerPct: 100, budget: null, budgetPct: null })
    expect(r.rows[1]).toMatchObject({ fillPct: 12.5, markerPct: null, budgetPct: 50 })
  })

  it('has no change when last month is empty', () => {
    expect(buildSpendingRanking([spend('a', 100)], [], []).change).toBeNull()
    expect(buildSpendingRanking([spend('a', 120)], [spend('a', 100)], []).change).toBeCloseTo(20)
  })

  it('has no change for the current month, but keeps last month total', () => {
    const r = buildSpendingRanking([spend('a', 120)], [spend('a', 100)], [], true)
    expect(r.change).toBeNull()
    expect(r.previousProjected).toBe(100)
  })

  it('sums totals over all rows, shares over positive rows, and lists negative categories', () => {
    const r = buildSpendingRanking([spend('a', 300), spend('b', 100), spend('c', -40), spend('d', -10)], [], [])
    expect(r.spent).toBe(350)
    expect(r.projected).toBe(350)
    expect(r.total).toBe(400)
    expect(r.rows.map((row) => row.share)).toEqual([75, 25])
    expect(r.negatives.map((n) => [n.key, n.amount])).toEqual([['c', -40], ['d', -10]])
  })
})
