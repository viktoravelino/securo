import type { ReportCompositionItem, ReportDataPoint } from '@/types'
import { formatDate } from '@/lib/date-range-format'
import { addDaysIso } from '@/lib/report-period'

export interface StatementLine {
  key: string
  label: string
  kind: 'section' | 'group' | 'category' | 'result' | 'ratio'
  depth: 0 | 1 | 2
  /** One amount per period, in trend order. Ratio lines hold fractions (0.34). */
  values: number[]
  total: number
  /** total / total income. Null when income is 0, and on ratio lines. */
  shareOfIncome: number | null
  color?: string
  /** Group lines point to their section, category lines to their group. */
  parentKey?: string
}

export interface IncomeStatement {
  periods: string[]
  lines: StatementLine[]
}

export interface StatementLabels {
  income: string
  expenses: string
  result: string
  investments: string
  netResult: string
  savingsRate: string
  noGroup: string
  uncategorized: string
}

const NO_GROUP_ID = 'none'
const NO_GROUP_COLOR = '#9CA3AF'

const sum = (values: number[]) => values.reduce((s, v) => s + v, 0)
const addValues = (a: number[], b: number[]) => a.map((v, i) => v + b[i])
const subValues = (a: number[], b: number[]) => a.map((v, i) => v - b[i])

/** (income - expenses - investments) / income, or 0 when income is 0. */
const ratio = (income: number, outflow: number) => (income === 0 ? 0 : (income - outflow) / income)

/**
 * Build the income statement (DRE) lines from the report trend.
 * Income and expenses split into groups and categories. A result line follows,
 * then investments (only when present), the net result and the savings rate.
 */
export function buildIncomeStatement(trend: ReportDataPoint[], labels: StatementLabels): IncomeStatement {
  const periods = trend.map((point) => point.date)
  const zeros = () => periods.map(() => 0)

  type Collected = { item: ReportCompositionItem; values: number[] }

  // Sum the amounts per category, keeping one value per period.
  const collect = (side: ReportCompositionItem['group']) => {
    const categories = new Map<string, Collected>()
    trend.forEach((point, index) => {
      for (const item of point.composition ?? []) {
        if (item.group !== side) continue
        const id = `${item.group_id ?? NO_GROUP_ID}|${item.key}`
        const entry = categories.get(id) ?? { item, values: zeros() }
        entry.values[index] += item.value
        categories.set(id, entry)
      }
    })
    return categories
  }

  // The API already nets refunds against their category, so a period can hold
  // a negative expense value. The statement reads the response as is.
  const collected = {
    income: [...collect('income').values()],
    expenses: [...collect('expenses').values()],
    investments: [...collect('investments').values()],
  }

  const categoryLabel = (item: ReportCompositionItem) =>
    item.key === 'uncategorized' ? labels.uncategorized : item.label

  // Build a line. Shares need the income total, so they are filled in at the end.
  const line = (
    fields: Omit<StatementLine, 'total' | 'shareOfIncome'>,
  ): StatementLine => ({ ...fields, total: sum(fields.values), shareOfIncome: null })

  const byTotalDesc = (a: StatementLine, b: StatementLine) => b.total - a.total

  // A section with its groups (depth 1) and their categories (depth 2).
  const groupedSection = (side: 'income' | 'expenses', label: string): { section: StatementLine; lines: StatementLine[] } => {
    const groups = new Map<string, { group: StatementLine; categories: StatementLine[] }>()
    for (const { item, values } of collected[side]) {
      const groupId = item.group_id ?? NO_GROUP_ID
      const groupKey = `${side}:g:${groupId}`
      let entry = groups.get(groupKey)
      if (!entry) {
        entry = {
          group: line({
            key: groupKey,
            label: item.group_name ?? labels.noGroup,
            kind: 'group',
            depth: 1,
            values: zeros(),
            color: item.group_color ?? NO_GROUP_COLOR,
            parentKey: side,
          }),
          categories: [],
        }
        groups.set(groupKey, entry)
      }
      entry.group.values = addValues(entry.group.values, values)
      entry.categories.push(
        line({
          key: `${groupKey}:c:${item.key}`,
          label: categoryLabel(item),
          kind: 'category',
          depth: 2,
          values,
          color: item.color,
          parentKey: groupKey,
        }),
      )
    }
    const ordered = [...groups.values()]
    for (const entry of ordered) entry.group.total = sum(entry.group.values)
    ordered.sort((a, b) => byTotalDesc(a.group, b.group))
    const section = line({ key: side, label, kind: 'section', depth: 0, values: zeros() })
    for (const entry of ordered) section.values = addValues(section.values, entry.group.values)
    section.total = sum(section.values)
    return {
      section,
      lines: ordered.flatMap((entry) => [entry.group, ...entry.categories.sort(byTotalDesc)]),
    }
  }

  const income = groupedSection('income', labels.income)
  const expenses = groupedSection('expenses', labels.expenses)
  const result = line({
    key: 'result',
    label: labels.result,
    kind: 'result',
    depth: 0,
    values: subValues(income.section.values, expenses.section.values),
  })

  const investmentItems = collected.investments
  const investmentLines = investmentItems
    .map(({ item, values }) =>
      line({
        key: `investments:c:${item.key}`,
        label: categoryLabel(item),
        kind: 'category',
        depth: 1,
        values,
        color: item.color,
        parentKey: 'investments',
      }),
    )
    .sort(byTotalDesc)
  const investments = line({
    key: 'investments',
    label: labels.investments,
    kind: 'section',
    depth: 0,
    values: investmentLines.reduce((acc, l) => addValues(acc, l.values), zeros()),
  })

  const lines: StatementLine[] = [
    income.section,
    ...income.lines,
    expenses.section,
    ...expenses.lines,
    result,
  ]
  const hasInvestments = investmentItems.length > 0
  const outflow = hasInvestments ? addValues(expenses.section.values, investments.values) : expenses.section.values
  if (hasInvestments) {
    lines.push(
      investments,
      ...investmentLines,
      line({ key: 'netResult', label: labels.netResult, kind: 'result', depth: 0, values: subValues(result.values, investments.values) }),
    )
  }

  const incomeTotal = income.section.total
  for (const l of lines) l.shareOfIncome = incomeTotal === 0 ? null : l.total / incomeTotal

  lines.push({
    key: 'savingsRate',
    label: labels.savingsRate,
    kind: 'ratio',
    depth: 0,
    values: income.section.values.map((v, i) => ratio(v, outflow[i])),
    total: ratio(incomeTotal, sum(outflow)),
    shareOfIncome: null,
  })

  return { periods, lines }
}

/** Monday of an ISO week (`YYYY-Www`) as `YYYY-MM-DD`. Week 1 is the week that holds Jan 4. */
function isoWeekStart(bucket: string): string | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(bucket)
  if (!match) return null
  const jan4 = `${match[1]}-01-04`
  const weekday = (new Date(`${jan4}T00:00:00`).getDay() + 6) % 7 // Monday is 0
  return addDaysIso(jan4, -weekday + (Number(match[2]) - 1) * 7)
}

/** Short column label for a trend bucket: "Aug 2026" for months, the start date for days and weeks, "2026" for years. */
export function formatBucketLabel(date: string, interval: string, dateLocale: string): string {
  if (interval === 'monthly') {
    const [y, m] = date.split('-').map(Number)
    return new Date(y, m - 1, 1).toLocaleDateString(dateLocale, { month: 'short', year: 'numeric' })
  }
  if (interval === 'daily') return formatDate(date, dateLocale)
  if (interval === 'weekly') {
    const start = isoWeekStart(date)
    return start ? formatDate(start, dateLocale) : date
  }
  return date
}

/** Stop a spreadsheet from running a label as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/
const textCell = (label: string) => {
  const safe = FORMULA_START.test(label) ? `'${label}` : label
  return `"${safe.replace(/"/g, '""')}"`
}

/**
 * Build the statement CSV: a header row, then one row per line.
 * Labels are quoted and neutralized against formulas. Numbers stay raw.
 */
export function buildStatementCsv(
  statement: IncomeStatement,
  headers: { period: (date: string) => string; total: string; share: string },
): string {
  const header = ['', ...statement.periods.map(headers.period), headers.total, headers.share].map((cell) =>
    cell === '' ? '' : textCell(cell),
  )
  const rows = statement.lines.map((line) =>
    [textCell(line.label), ...line.values, line.total, line.shareOfIncome ?? ''].join(','),
  )
  return [header.join(','), ...rows].join('\r\n')
}
