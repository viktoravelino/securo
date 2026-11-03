import { useTranslation } from 'react-i18next'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { formatCurrency } from '@/lib/format'
import { deltaColorClass, type ComparisonRow } from '@/lib/report-comparison'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface PeriodComparisonTableProps {
  rows: ComparisonRow[]
  side: 'income' | 'expenses'
  currency: string
  locale: string
}

/** Table of current vs previous amounts per category, with two small bars under each name. */
export function PeriodComparisonTable({ rows, side, currency, locale }: PeriodComparisonTableProps) {
  const { t } = useTranslation()
  const { mask } = usePrivacyMode()
  const maxValue = Math.max(...rows.map((r) => Math.max(r.current, r.previous)), 0)
  const width = (value: number) => `${maxValue > 0 ? (value / maxValue) * 100 : 0}%`
  const money = (value: number) => mask(formatCurrency(value, currency, locale))

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('reports.category')}</TableHead>
          <TableHead className="text-right">{t('reports.current')}</TableHead>
          <TableHead className="text-right">{t('reports.previous')}</TableHead>
          <TableHead className="text-right">{t('reports.change')}</TableHead>
          <TableHead className="text-right">{t('reports.deltaPercent')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const color = deltaColorClass(row.delta, side)
          return (
            <TableRow key={row.key}>
              <TableCell>
                <div className="flex items-center gap-1.5 mb-1">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: row.color }} />
                  <span className="truncate">
                    {row.key === 'uncategorized' ? t('reports.uncategorized') : row.key === 'other' ? t('reports.other') : row.label}
                  </span>
                </div>
                <div className="space-y-0.5">
                  <div className="h-1 rounded-full" style={{ width: width(row.current), backgroundColor: row.color }} />
                  <div className="h-1 rounded-full bg-muted-foreground/40" style={{ width: width(row.previous) }} />
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{money(row.current)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(row.previous)}</TableCell>
              <TableCell className={`text-right tabular-nums ${color}`}>
                {mask(`${row.delta > 0 ? '+' : ''}${formatCurrency(row.delta, currency, locale)}`)}
              </TableCell>
              <TableCell className={`text-right tabular-nums ${color}`}>
                {row.deltaPct === null ? '—' : mask(`${row.deltaPct > 0 ? '+' : ''}${row.deltaPct.toFixed(1)}%`)}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
