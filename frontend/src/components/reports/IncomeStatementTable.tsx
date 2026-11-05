import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { formatCurrency } from '@/lib/format'
import type { IncomeStatement, StatementLine } from '@/lib/income-statement'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface IncomeStatementTableProps {
  statement: IncomeStatement
  currency: string
  locale: string
  periodLabel: (date: string) => string
}

const ROW_STYLE: Record<StatementLine['kind'], string> = {
  section: 'border-t border-border font-bold',
  group: 'font-medium',
  category: 'text-muted-foreground',
  result: 'border-t border-border bg-muted/40 font-bold',
  ratio: 'text-muted-foreground italic',
}

const INDENT: Record<StatementLine['depth'], string> = { 0: 'pl-4', 1: 'pl-8', 2: 'pl-12' }

/** Income statement (DRE) with one column per period. Sections and groups collapse. */
export function IncomeStatementTable({ statement, currency, locale, periodLabel }: IncomeStatementTableProps) {
  const { t } = useTranslation()
  const { mask } = usePrivacyMode()
  // Sections start open and groups start closed.
  const [expanded, setExpanded] = useState(
    () => new Set(statement.lines.filter((l) => l.kind === 'section').map((l) => l.key)),
  )

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const lineByKey = new Map(statement.lines.map((l) => [l.key, l]))
  // A line shows only when every ancestor is expanded.
  const isVisible = (line: StatementLine): boolean => {
    const parent = line.parentKey ? lineByKey.get(line.parentKey) : undefined
    return !parent || (expanded.has(parent.key) && isVisible(parent))
  }

  const money = (value: number) => (value === 0 ? '–' : mask(formatCurrency(value, currency, locale)))
  const percent = (fraction: number | null) =>
    fraction === null || fraction === 0 ? '–' : mask(`${Math.round(fraction * 100)}%`)
  const cell = (line: StatementLine, value: number) => (line.kind === 'ratio' ? percent(value) : money(value))

  return (
    <Table data-testid="income-statement-table">
      <TableHeader>
        <TableRow>
          <TableHead className="sticky left-0 z-10 bg-card">&nbsp;</TableHead>
          {statement.periods.map((date) => (
            <TableHead key={date} className="text-right whitespace-nowrap">{periodLabel(date)}</TableHead>
          ))}
          <TableHead className="text-right">{t('reports.statementTotal')}</TableHead>
          <TableHead className="text-right whitespace-nowrap">{t('reports.statementShare')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {statement.lines.filter(isVisible).map((line) => {
          const collapsible = line.kind === 'section' || line.kind === 'group'
          const open = expanded.has(line.key)
          const Chevron = open ? ChevronDown : ChevronRight
          return (
            <TableRow
              key={line.key}
              className={ROW_STYLE[line.kind]}
            >
              <TableCell
                className={`sticky left-0 z-10 whitespace-nowrap ${line.kind === 'result' ? 'bg-muted' : 'bg-card'} ${INDENT[line.depth]}`}
              >
                {collapsible ? (
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggle(line.key)}
                    className="flex cursor-pointer items-center gap-1.5 rounded-sm outline-none focus-visible:ring-[2px] focus-visible:ring-ring/30"
                  >
                    <Chevron className="h-3.5 w-3.5 shrink-0" />
                    {line.label}
                  </button>
                ) : (
                  <span className="flex items-center gap-1.5">
                    {line.kind === 'category' && line.color && (
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: line.color }} />
                    )}
                    {line.label}
                  </span>
                )}
              </TableCell>
              {line.values.map((value, i) => (
                <TableCell key={statement.periods[i]} className="text-right tabular-nums">{cell(line, value)}</TableCell>
              ))}
              <TableCell className="text-right tabular-nums">{cell(line, line.total)}</TableCell>
              <TableCell className="text-right tabular-nums">{percent(line.shareOfIncome)}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
