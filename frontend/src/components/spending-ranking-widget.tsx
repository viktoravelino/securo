import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { budgets, dashboard } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { currentMonth, shiftMonth } from '@/lib/month-utils'
import { buildSpendingRanking } from '@/lib/spending-ranking'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { CategoryIcon } from '@/components/category-icon'
import { Skeleton } from '@/components/ui/skeleton'
import { Empty, Failed, WidgetCard, type DashboardScope } from '@/components/dashboard-widgets'
import { cn } from '@/lib/utils'

// A downward caret for last month, and a dashed foreground tick outlined in the card color for the budget.
const CARET = 'block size-0 border-x-[4px] border-t-[6px] border-x-transparent border-t-muted-foreground'
const TICK = 'h-3 w-0.5 bg-[repeating-linear-gradient(to_bottom,var(--foreground)_0_3px,transparent_3px_5px)] shadow-[0_0_0_1px_var(--card)]'

/** Spending per category this month as sorted bars, with last month and budget marks. */
export function SpendingRankingWidget({ scope }: { scope: DashboardScope }) {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const { mask } = usePrivacyMode()
  const accountIds = scope.activeAccountIds ?? undefined
  const previousMonth = shiftMonth(scope.month, -1)

  // Same query keys as the dashboard, so the cache is shared.
  const current = useQuery({
    queryKey: ['dashboard', 'spending', scope.month, scope.activeAccountIds],
    queryFn: () => dashboard.spendingByCategory(`${scope.month}-01`, accountIds),
    enabled: !scope.noAccounts,
  })
  const previous = useQuery({
    queryKey: ['dashboard', 'spending', previousMonth, scope.activeAccountIds],
    queryFn: () => dashboard.spendingByCategory(`${previousMonth}-01`, accountIds),
    enabled: !scope.noAccounts,
  })
  const budgetData = useQuery({
    queryKey: ['budgets', 'comparison', scope.month],
    queryFn: () => budgets.comparison(`${scope.month}-01`),
    enabled: !scope.noAccounts,
  })

  const ranking = useMemo(
    () => buildSpendingRanking(current.data ?? [], previous.data ?? [], budgetData.data ?? [], scope.month === currentMonth()),
    [current.data, previous.data, budgetData.data, scope.month],
  )
  const money = (value: number) => mask(formatCurrency(value, scope.currency, locale))
  const hasBudget = ranking.rows.some((row) => row.budget !== null)
  const change = ranking.change === null ? null : Math.round(ranking.change)

  return (
    <WidgetCard title={t('widgets.ranking.title')}>
      {current.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : current.isError ? (
        <Failed onRetry={() => void current.refetch()} />
      ) : ranking.total <= 0 ? (
        <Empty>{t('dashboard.noData')}</Empty>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
              <span className="flex items-baseline gap-1.5">
                <span className="text-xs text-muted-foreground">{t('widgets.ranking.spent')}</span>
                <span className="text-base font-bold tabular-nums">{money(ranking.spent)}</span>
              </span>
              <span className="flex items-baseline gap-1.5">
                <span className="text-xs text-muted-foreground">{t('widgets.ranking.projected')}</span>
                <span className="text-sm font-semibold tabular-nums">{money(ranking.projected)}</span>
              </span>
            </div>
            {change !== null ? (
              <span className={cn('text-xs font-medium tabular-nums', change > 0 ? 'text-rose-500' : change < 0 ? 'text-emerald-500' : 'text-muted-foreground')}>
                {change !== 0 && <span aria-hidden="true">{change > 0 ? '\u2191' : '\u2193'} </span>}
                {t('widgets.ranking.vsLastMonth', { percent: Math.abs(change) })}
              </span>
            ) : (
              ranking.previousProjected > 0 && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t('widgets.ranking.lastMonthTotal', { amount: money(ranking.previousProjected) })}
                </span>
              )
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-4 rounded-full bg-muted-foreground/60" aria-hidden="true" />
              {t('widgets.ranking.thisMonth')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className={CARET} aria-hidden="true" />
              {t('widgets.ranking.lastMonth')}
            </span>
            {hasBudget && (
              <span className="inline-flex items-center gap-1.5">
                <span className={TICK} aria-hidden="true" />
                {t('widgets.ranking.budget')}
              </span>
            )}
          </div>
          <ul className="max-h-[420px] min-h-0 flex-1 space-y-3 overflow-y-auto pe-1">
            {ranking.rows.map((row) => {
              const label = [
                t('widgets.ranking.rowLabel', { name: row.name, amount: money(row.amount), percent: Math.round(row.share) }),
                row.previous !== null ? t('widgets.ranking.rowPrevious', { amount: money(row.previous) }) : null,
                row.budget !== null ? t('widgets.ranking.rowBudget', { amount: money(row.budget) }) : null,
              ].filter(Boolean).join(', ')
              return (
                <li key={row.key} title={label} aria-label={label} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <CategoryIcon icon={row.icon} color={row.color} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
                    <span className="text-sm font-semibold tabular-nums">{money(row.amount)}</span>
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
                      {Math.round(row.share)}%
                    </span>
                  </div>
                  <div className="relative h-2 w-full rounded-full bg-muted" aria-hidden="true">
                    <div
                      className="absolute inset-y-0 rounded-full"
                      style={{ insetInlineStart: 0, width: `${row.fillPct}%`, backgroundColor: row.color || 'var(--chart-muted)' }}
                    />
                    {row.markerPct !== null && (
                      <div className="absolute -top-1.5 -translate-x-1/2 rtl:translate-x-1/2" style={{ insetInlineStart: `${row.markerPct}%` }}>
                        <span className={CARET} />
                      </div>
                    )}
                    {row.budgetPct !== null && (
                      <div className={cn('absolute -inset-y-1', TICK)} style={{ insetInlineStart: `${row.budgetPct}%` }} />
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          {ranking.negatives.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {t('widgets.ranking.refunds', { items: ranking.negatives.map((n) => `${n.name} ${money(n.amount)}`).join(', ') })}
            </p>
          )}
        </div>
      )}
    </WidgetCard>
  )
}
