import type { CategoryTrendItem } from '@/types'

export interface StackSeries {
  key: string
  label: string
  color: string
}

export type StackRow = { date: string; total: number } & Record<string, number | string>

/** Build rows for a stacked bar chart: one row per bucket, one numeric column per category key. */
export function buildCategoryStack(items: CategoryTrendItem[]): { series: StackSeries[]; rows: StackRow[] } {
  const series = items.map(({ key, label, color }) => ({ key, label, color }))
  const rows = (items[0]?.series ?? []).map((bucket, i): StackRow => {
    const row: StackRow = { date: bucket.date, total: 0 }
    for (const item of items) {
      const value = item.series[i]?.value ?? 0
      row[item.key] = value
      row.total += value
    }
    return row
  })
  return { series, rows }
}
