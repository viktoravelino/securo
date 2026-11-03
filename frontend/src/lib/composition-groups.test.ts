import { describe, expect, it } from 'vitest'
import { groupComposition, NO_GROUP_KEY } from '@/lib/composition-groups'
import type { ReportCompositionItem } from '@/types'

const labels = { noGroup: 'No group', uncategorized: 'Uncategorized' }

function item(
  key: string,
  value: number,
  group: string,
  extra: Partial<ReportCompositionItem> = {},
): ReportCompositionItem {
  return { key, label: key.toUpperCase(), value, color: `#${key}`, group, ...extra }
}

describe('groupComposition', () => {
  it('returns an empty list for empty input', () => {
    expect(groupComposition([], 'expenses', labels)).toEqual([])
  })

  it('buckets grouped and ungrouped items and sums the values', () => {
    const slices = groupComposition(
      [
        item('a', 100, 'expenses', { group_id: 'g1', group_name: 'Essentials', group_color: '#112233' }),
        item('b', 50, 'expenses', { group_id: 'g1', group_name: 'Essentials', group_color: '#112233' }),
        item('c', 30, 'expenses'),
        item('uncategorized', 5, 'expenses'),
      ],
      'expenses',
      labels,
    )
    expect(slices).toHaveLength(2)
    expect(slices[0]).toMatchObject({ key: 'g1', name: 'Essentials', value: 150, color: '#112233' })
    expect(slices[1]).toMatchObject({ key: NO_GROUP_KEY, name: 'No group', value: 35, color: '#9CA3AF' })
    expect(slices[1].children.map((c) => c.name)).toEqual(['C', 'Uncategorized'])
  })

  it('ignores items from the other side', () => {
    const slices = groupComposition(
      [item('a', 100, 'income'), item('b', 20, 'expenses')],
      'expenses',
      labels,
    )
    expect(slices).toHaveLength(1)
    expect(slices[0].children.map((c) => c.key)).toEqual(['b'])
  })

  it('sorts children and groups by value, largest first', () => {
    const slices = groupComposition(
      [
        item('a', 10, 'expenses', { group_id: 'g1', group_name: 'Small' }),
        item('b', 40, 'expenses', { group_id: 'g2', group_name: 'Big' }),
        item('c', 60, 'expenses', { group_id: 'g2', group_name: 'Big' }),
      ],
      'expenses',
      labels,
    )
    expect(slices.map((s) => s.key)).toEqual(['g2', 'g1'])
    expect(slices[0].children.map((c) => c.key)).toEqual(['c', 'b'])
  })
})
