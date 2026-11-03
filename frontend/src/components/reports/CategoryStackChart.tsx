import { useTranslation } from 'react-i18next'
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { buildCategoryStack } from '@/lib/category-stack'
import { formatBucketLabel } from '@/lib/income-statement'
import { formatCompact, formatCurrency } from '@/lib/format'
import type { CategoryTrendItem } from '@/types'

interface CategoryStackChartProps {
  items: CategoryTrendItem[]
  mode: 'absolute' | 'percent'
  currency: string
  locale: string
  /** Bucket size of the dates in `items`, and the locale for their axis labels. */
  interval: string
  dateLocale: string
}

const tooltipStyle = {
  background: 'var(--card)',
  color: 'var(--foreground)',
  border: '1px solid var(--border)',
  borderRadius: '0.75rem',
  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
  fontSize: '12px',
}

/** Stacked bars of category amounts per bucket, as amounts or as shares of the bucket total. */
export function CategoryStackChart({ items, mode, currency, locale, interval, dateLocale }: CategoryStackChartProps) {
  const { t } = useTranslation()
  const { privacyMode, MASK } = usePrivacyMode()
  const { series, rows } = buildCategoryStack(items)

  if (series.length === 0) {
    return <p className="text-muted-foreground text-sm text-center py-16">{t('reports.noData')}</p>
  }

  const labelOf = (key: string, label: string) =>
    key === 'uncategorized' ? t('reports.uncategorized') : key === 'other' ? t('reports.other') : label
  const labels = new Map(series.map((s) => [s.key, labelOf(s.key, s.label)]))

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={rows}
        stackOffset={mode === 'percent' ? 'expand' : 'none'}
        margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
      >
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
          tickFormatter={(date: string) => formatBucketLabel(date, interval, dateLocale)}
        />
        <YAxis
          tickFormatter={(v: number) => {
            if (privacyMode) return ''
            if (mode === 'percent') return `${Math.round(v * 100)}%`
            if (v === 0) return '0'
            return formatCompact(v, currency, locale)
          }}
          tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          width={64}
          tickCount={5}
        />
        <Tooltip
          content={({ active, payload, label }) => {
            if (!active || !payload) return null
            const entries = payload.filter((p) => typeof p.value === 'number' && p.value !== 0)
            if (entries.length === 0) return null
            return (
              <div style={tooltipStyle} className="px-3 py-2">
                <p className="text-xs font-medium mb-1">{label}</p>
                {entries.map((p) => {
                  const key = String(p.dataKey)
                  const row: Partial<Record<string, number>> = p.payload
                  const amount = mode === 'percent' ? row[key] ?? 0 : Number(p.value)
                  const total = row.total ?? 0
                  const pct = total ? (amount / total) * 100 : 0
                  const text = formatCurrency(amount, currency, locale)
                  return (
                    <p key={key} className="text-xs" style={{ color: p.color }}>
                      {labels.get(key) ?? p.name}:{' '}
                      {privacyMode ? MASK : mode === 'percent' ? `${text} (${pct.toFixed(1)}%)` : text}
                    </p>
                  )
                })}
              </div>
            )
          }}
        />
        <Legend
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }}
          formatter={(value: string) => labels.get(value) ?? value}
        />
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            stackId="stack"
            fill={s.color}
            maxBarSize={32}
            radius={i === series.length - 1 ? [4, 4, 0, 0] : undefined}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}
