import type { ReportCompositionItem } from '@/types'

export interface GroupChild { key: string; name: string; value: number; color: string }
export interface GroupSlice { key: string; name: string; value: number; color: string; children: GroupChild[] }

/** Key of the bucket that holds categories without a group. */
export const NO_GROUP_KEY = 'none'

const NO_GROUP_COLOR = '#9CA3AF'

/** Bucket composition items of one side by category group, largest first. */
export function groupComposition(
  items: ReportCompositionItem[],
  side: 'income' | 'expenses',
  labels: { noGroup: string; uncategorized: string },
): GroupSlice[] {
  const buckets = new Map<string, GroupSlice>()
  for (const item of items) {
    if (item.group !== side) continue
    const key = item.group_id ?? NO_GROUP_KEY
    let slice = buckets.get(key)
    if (!slice) {
      slice = {
        key,
        name: item.group_name ?? labels.noGroup,
        value: 0,
        color: item.group_color ?? NO_GROUP_COLOR,
        children: [],
      }
      buckets.set(key, slice)
    }
    slice.children.push({
      key: item.key,
      name: item.key === 'uncategorized' ? labels.uncategorized : item.label,
      value: item.value,
      color: item.color,
    })
    slice.value += item.value
  }
  const slices = [...buckets.values()]
  for (const slice of slices) slice.children.sort((a, b) => b.value - a.value)
  return slices.sort((a, b) => b.value - a.value)
}
