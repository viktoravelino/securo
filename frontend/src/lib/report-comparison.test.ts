import { describe, expect, it } from 'vitest'
import { buildComparisonRows, deltaPercent } from './report-comparison'
import type { ReportCompositionItem } from '@/types'

const item = (key: string, value: number, group = 'expenses'): ReportCompositionItem => ({
  key,
  label: key.toUpperCase(),
  value,
  color: `#${key}`,
  group,
})

describe('deltaPercent', () => {
  it('returns the percent change, or null when previous is 0', () => {
    expect(deltaPercent(150, 100)).toBe(50)
    expect(deltaPercent(50, 100)).toBe(-50)
    expect(deltaPercent(10, 0)).toBeNull()
  })
})

describe('buildComparisonRows', () => {
  it('handles a new category, a vanished category and sorts by current', () => {
    const rows = buildComparisonRows(
      [item('food', 200), item('fresh', 50)],
      [item('food', 100), item('gone', 80)],
      'expenses',
    )
    expect(rows.map((r) => r.key)).toEqual(['food', 'fresh', 'gone'])
    expect(rows[0]).toMatchObject({ current: 200, previous: 100, delta: 100, deltaPct: 100 })
    expect(rows[1]).toMatchObject({ current: 50, previous: 0, delta: 50, deltaPct: null })
    expect(rows[2]).toMatchObject({ label: 'GONE', color: '#gone', current: 0, previous: 80, delta: -80, deltaPct: -100 })
  })

  it('keeps only the requested side', () => {
    const current = [item('food', 10), item('pay', 500, 'income'), item('etf', 99, 'investments')]
    expect(buildComparisonRows(current, [], 'income').map((r) => r.key)).toEqual(['pay'])
    expect(buildComparisonRows(current, [], 'expenses').map((r) => r.key)).toEqual(['food'])
  })
})
