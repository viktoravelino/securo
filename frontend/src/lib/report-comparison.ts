import type { ReportCompositionItem } from '@/types'

export interface ComparisonRow {
  key: string
  label: string
  color: string
  current: number
  previous: number
  delta: number
  deltaPct: number | null
}

/** Percent change from previous to current; null when previous is 0. */
export function deltaPercent(current: number, previous: number): number | null {
  if (previous === 0) return null
  return ((current - previous) / Math.abs(previous)) * 100
}

/** Merge current and previous composition items of one side into comparison rows. */
export function buildComparisonRows(
  current: ReportCompositionItem[],
  previous: ReportCompositionItem[],
  side: 'income' | 'expenses',
): ComparisonRow[] {
  const cur = new Map(current.filter((c) => c.group === side).map((c) => [c.key, c]))
  const prev = new Map(previous.filter((c) => c.group === side).map((c) => [c.key, c]))
  const keys = new Set([...cur.keys(), ...prev.keys()])
  return [...keys]
    .map((key) => {
      const c = cur.get(key)
      const p = prev.get(key)
      const base = c ?? p!
      const currentValue = c?.value ?? 0
      const previousValue = p?.value ?? 0
      return {
        key,
        label: base.label,
        color: base.color,
        current: currentValue,
        previous: previousValue,
        delta: currentValue - previousValue,
        deltaPct: deltaPercent(currentValue, previousValue),
      }
    })
    .sort((a, b) => b.current - a.current || b.previous - a.previous)
}

/** Text color for a delta: more spending is bad, more income is good, no change is muted. */
export function deltaColorClass(delta: number, side: 'income' | 'expenses'): string {
  if (delta === 0) return 'text-muted-foreground'
  const good = side === 'income' ? delta > 0 : delta < 0
  return good ? 'text-emerald-600' : 'text-rose-500'
}
