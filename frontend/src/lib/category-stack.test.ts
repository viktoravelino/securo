import { describe, expect, it } from 'vitest'
import { buildCategoryStack } from './category-stack'
import type { CategoryTrendItem } from '@/types'

const point = (date: string, value: number) => ({ date, value, breakdowns: {}, change: null })
const item = (key: string, values: [number, number]): CategoryTrendItem => ({
  key,
  label: key.toUpperCase(),
  color: `#${key}`,
  total: values[0] + values[1],
  group: 'expenses',
  series: [point('Jan', values[0]), point('Feb', values[1])],
})

describe('buildCategoryStack', () => {
  it('builds one row per bucket with a column per category and a total', () => {
    const { series, rows } = buildCategoryStack([item('a', [10, 0]), item('b', [5, 20]), item('c', [0, 1])])
    expect(series.map((s) => s.key)).toEqual(['a', 'b', 'c'])
    expect(series[1]).toEqual({ key: 'b', label: 'B', color: '#b' })
    expect(rows).toEqual([
      { date: 'Jan', total: 15, a: 10, b: 5, c: 0 },
      { date: 'Feb', total: 21, a: 0, b: 20, c: 1 },
    ])
  })

  it('returns empty arrays for empty input', () => {
    expect(buildCategoryStack([])).toEqual({ series: [], rows: [] })
  })
})
