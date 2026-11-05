import { describe, expect, it } from 'vitest'

import { buildIncomeStatement, buildStatementCsv, formatBucketLabel, type StatementLine } from '@/lib/income-statement'
import type { ReportCompositionItem, ReportDataPoint } from '@/types'

const labels = {
  income: 'Revenue',
  expenses: 'Expenses',
  result: 'Result',
  investments: 'Investments',
  netResult: 'Net result',
  savingsRate: 'Savings rate',
  noGroup: 'No group',
  uncategorized: 'Uncategorized',
}

const item = (
  key: string,
  group: ReportCompositionItem['group'],
  value: number,
  groupId?: string,
): ReportCompositionItem => ({
  key,
  label: key,
  value,
  color: '#000',
  group,
  group_id: groupId ?? null,
  group_name: groupId ? `Group ${groupId}` : null,
  group_color: groupId ? '#111' : null,
})

const point = (date: string, composition: ReportCompositionItem[]): ReportDataPoint => ({
  date,
  value: 0,
  breakdowns: {},
  change: null,
  composition,
})

const base = [
  point('2026-01', [
    item('salary', 'income', 800, 'work'),
    item('bonus', 'income', 200, 'work'),
    item('rent', 'expenses', 300, 'housing'),
    item('utilities', 'expenses', 100, 'housing'),
    item('groceries', 'expenses', 150, 'food'),
    item('gifts', 'expenses', 50),
  ]),
  point('2026-02', [
    item('salary', 'income', 800, 'work'),
    item('rent', 'expenses', 300, 'housing'),
    item('groceries', 'expenses', 250, 'food'),
  ]),
]

const find = (lines: StatementLine[], key: string) => lines.find((l) => l.key === key)

describe('buildIncomeStatement', () => {
  it('totals sections and orders groups and categories by total', () => {
    const { periods, lines } = buildIncomeStatement(base, labels)
    expect(periods).toEqual(['2026-01', '2026-02'])
    expect(lines.map((l) => l.key)).toEqual([
      'income',
      'income:g:work',
      'income:g:work:c:salary',
      'income:g:work:c:bonus',
      'expenses',
      'expenses:g:housing',
      'expenses:g:housing:c:rent',
      'expenses:g:housing:c:utilities',
      'expenses:g:food',
      'expenses:g:food:c:groceries',
      'expenses:g:none',
      'expenses:g:none:c:gifts',
      'result',
      'savingsRate',
    ])
    expect(lines[0]).toMatchObject({ values: [1000, 800], total: 1800, kind: 'section', depth: 0 })
    expect(find(lines, 'expenses')).toMatchObject({ values: [600, 550], total: 1150 })
    expect(find(lines, 'expenses:g:none')).toMatchObject({ label: 'No group', parentKey: 'expenses' })
    expect(find(lines, 'income:g:work:c:salary')).toMatchObject({ depth: 2, parentKey: 'income:g:work' })
  })

  it('computes the result, shares and savings rate', () => {
    const { lines } = buildIncomeStatement(base, labels)
    expect(find(lines, 'result')).toMatchObject({ kind: 'result', values: [400, 250], total: 650 })
    expect(find(lines, 'expenses')?.shareOfIncome).toBeCloseTo(1150 / 1800)
    const rate = find(lines, 'savingsRate')!
    expect(rate.kind).toBe('ratio')
    expect(rate.values[0]).toBeCloseTo(0.4)
    expect(rate.values[1]).toBeCloseTo(0.3125)
    expect(rate.total).toBeCloseTo(650 / 1800)
    expect(rate.shareOfIncome).toBeNull()
  })

  it('gives a category missing from one period 0 there', () => {
    const { lines } = buildIncomeStatement(base, labels)
    expect(find(lines, 'income:g:work:c:bonus')).toMatchObject({ values: [200, 0], total: 200 })
  })

  it('omits the investments section when no period has one', () => {
    const { lines } = buildIncomeStatement(base, labels)
    expect(find(lines, 'investments')).toBeUndefined()
    expect(find(lines, 'netResult')).toBeUndefined()
  })

  it('adds investments and the net result when present', () => {
    const trend = [
      point('2026-01', [...base[0].composition!, item('etf', 'investments', 100)]),
      base[1],
    ]
    const { lines } = buildIncomeStatement(trend, labels)
    expect(find(lines, 'investments')).toMatchObject({ values: [100, 0], total: 100 })
    expect(find(lines, 'investments:c:etf')).toMatchObject({ depth: 1, parentKey: 'investments' })
    expect(find(lines, 'netResult')).toMatchObject({ values: [300, 250], total: 550 })
    expect(find(lines, 'savingsRate')?.values[0]).toBeCloseTo(0.3)
  })

  it('returns 0 for ratios and null shares when income is 0', () => {
    const { lines } = buildIncomeStatement([point('2026-01', [item('rent', 'expenses', 50, 'housing')])], labels)
    expect(find(lines, 'savingsRate')).toMatchObject({ values: [0], total: 0 })
    expect(find(lines, 'expenses')?.shareOfIncome).toBeNull()
  })
})

describe('buildIncomeStatement refunds', () => {
  it('reads the values the API already netted, including a negative refund-only period', () => {
    const { lines } = buildIncomeStatement(
      [
        point('2026-01', [item('groceries', 'expenses', 110, 'food')]),
        point('2026-02', [item('groceries', 'expenses', -40, 'food'), item('salary', 'income', 800, 'work')]),
      ],
      labels,
    )
    expect(find(lines, 'expenses:g:food:c:groceries')?.values).toEqual([110, -40])
    expect(find(lines, 'income')?.total).toBe(800)
    expect(find(lines, 'expenses')?.total).toBe(70)
    expect(find(lines, 'result')?.total).toBe(730)
  })

  it('leaves an uncategorized credit as revenue', () => {
    const { lines } = buildIncomeStatement(
      [point('2026-01', [item('uncategorized', 'income', 30), item('uncategorized', 'expenses', 20)])],
      labels,
    )
    expect(find(lines, 'income')?.total).toBe(30)
    expect(find(lines, 'expenses')?.total).toBe(20)
  })
})

describe('formatBucketLabel', () => {
  it('shows the Monday of an ISO week', () => {
    expect(formatBucketLabel('2026-W44', 'weekly', 'en-US')).toBe('Oct 26, 2026')
    // Week 1 of 2026 starts in the previous year.
    expect(formatBucketLabel('2026-W01', 'weekly', 'en-US')).toBe('Dec 29, 2025')
  })
})

describe('buildStatementCsv', () => {
  it('adds a header row and neutralizes formulas in labels only', () => {
    const trend = [
      point('2026-01', [item('=SUM(A1)', 'income', 100, 'work'), item('rent', 'expenses', -5, 'home')]),
    ]
    const csv = buildStatementCsv(buildIncomeStatement(trend, labels), {
      period: (date) => `P ${date}`,
      total: 'Total',
      share: 'Share',
    })
    const rows = csv.split('\r\n')
    expect(rows[0]).toBe(',"P 2026-01","Total","Share"')
    expect(csv).toContain(`"'=SUM(A1)",100,100,1`)
    expect(csv).toContain(',-5,-5,')
  })
})
