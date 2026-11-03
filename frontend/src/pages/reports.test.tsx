import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'

import ReportsPage from '@/pages/reports'
import { renderWithProviders, t } from '@/test/utils'
import type { ReportResponse } from '@/types'

const api = vi.hoisted(() => ({
  reports: {
    netWorth: vi.fn(),
    incomeExpenses: vi.fn(),
    cashFlow: vi.fn(),
    dataRange: vi.fn(),
  },
  // The page reads the workspace timezone to tell a balance that is already
  // negative from one that crosses later. Unresolved here, which lands on the
  // browser's own day.
  timezones: { list: vi.fn().mockResolvedValue({ timezones: [], default: null }) },
}))

vi.mock('@/lib/api', () => ({ reports: api.reports, timezones: api.timezones }))

vi.mock('@/hooks/use-display-locale', () => ({
  useDisplayLocale: () => 'en-US',
  useDateLocale: () => 'en-US',
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { preferences: { currency_display: 'USD' } } }),
}))

vi.mock('@/contexts/collection-filter-context', () => ({
  useCollectionFilter: () => ({ activeAccountIds: null, activeWalletIds: null }),
}))

vi.mock('@/hooks/use-privacy-mode', () => ({
  usePrivacyMode: () => ({ mask: (value: string) => value, privacyMode: false, MASK: '••••' }),
}))

function emptyReport(type: string): ReportResponse {
  return {
    summary: { primary_value: 1000, change_amount: 100, change_percent: 5, breakdowns: [] },
    trend: [{ date: '2026-01-01', value: 1000, breakdowns: {}, change: null }],
    meta: { type, series_keys: [], currency: 'USD', interval: 'monthly' },
    composition: [],
    category_trend: [],
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 12, 12))
  vi.clearAllMocks()
  api.reports.netWorth.mockResolvedValue(emptyReport('net_worth'))
  api.reports.incomeExpenses.mockResolvedValue(emptyReport('income_expenses'))
  api.reports.cashFlow.mockResolvedValue(emptyReport('cash_flow'))
  // No data by default: the year picker stays hidden unless a test opts in.
  api.reports.dataRange.mockResolvedValue({ min_date: null, max_date: null })
})

afterEach(() => vi.useRealTimers())

describe('Reports page — Custom range segment', () => {
  it('loads the Net Worth tab with the 1Y preset by default', async () => {
    renderWithProviders(<ReportsPage />)

    await waitFor(() => expect(api.reports.netWorth).toHaveBeenCalled())
    const [, , , , , startDate, endDate] = api.reports.netWorth.mock.calls[0]
    expect(startDate).toBeUndefined()
    expect(endDate).toBeUndefined()
  })

  it('opening Custom waits for Apply before querying January 1 through today', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    await waitFor(() => expect(api.reports.netWorth).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: t('reports.customRange') }))

    expect(api.reports.netWorth).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: t('reports.range1y') })).toHaveClass('bg-primary')
    await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.apply') }))
    const year = 2026
    await waitFor(() => {
      const last = api.reports.netWorth.mock.calls.at(-1)!
      expect(last[5]).toBe(`${year}-01-01`)
      expect(last[6]).toBe('2026-09-12')
    })

    // The segment itself now displays the picked range instead of "Custom
    // range" — in the same compact, year-less form as the transactions
    // filter bar's applied-range chip.
    const fmt = (iso: string) =>
      new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
        day: '2-digit',
        month: 'short',
      })
    expect(
      screen.getByRole('button', { name: t('reports.customRange') }),
    ).toHaveTextContent(`${fmt(`${year}-01-01`)} - ${fmt('2026-09-12')}`)
  })

  it('is not offered on the Cash Flow tab', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    await waitFor(() => expect(api.reports.netWorth).toHaveBeenCalled())

    await user.click(screen.getByRole('button', { name: t('reports.cashFlow') }))

    await waitFor(() => expect(api.reports.cashFlow).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: t('reports.customRange') })).not.toBeInTheDocument()
  })
})


it.each(['Cancel', 'Escape', 'outside'] as const)(
  '6M → Custom → %s leaves the preset and query unchanged', async (dismiss) => {
    const { user } = renderWithProviders(<ReportsPage />)
    await waitFor(() => expect(api.reports.netWorth).toHaveBeenCalledTimes(1))
    const preset = screen.getByRole('button', { name: t('reports.range6m') })
    await user.click(preset)
    await waitFor(() => expect(api.reports.netWorth).toHaveBeenCalledTimes(2))
    await user.click(screen.getByRole('button', { name: t('reports.customRange') }))
    if (dismiss === 'Cancel') {
      await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.cancel') }))
    } else if (dismiss === 'Escape') {
      await user.keyboard('{Escape}')
    } else {
      await user.click(document.body)
    }
    expect(preset).toHaveClass('bg-primary')
    expect(api.reports.netWorth).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: t('reports.customRange') }))
    expect(api.reports.netWorth).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.apply') }))
    await waitFor(() => expect(api.reports.netWorth).toHaveBeenCalledTimes(3))
  },
)

it.each([
  ['reports.netWorth', 'reports.range1y', 12],
  ['reports.incomeExpenses', 'reports.range1y', 12],
  ['reports.moneyMap', 'reports.range3m', 3],
] as const)('Reset then Apply restores the fallback for %s', async (tab, fallback, months) => {
  const { user } = renderWithProviders(<ReportsPage />)
  if (tab !== 'reports.netWorth') {
    await user.click(screen.getByRole('button', { name: t(tab) }))
  }
  const custom = screen.getByRole('button', { name: t('reports.customRange') })
  await user.click(custom)
  await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.apply') }))
  const reportApi = tab === 'reports.netWorth' ? api.reports.netWorth : api.reports.incomeExpenses
  await waitFor(() => expect(reportApi.mock.calls.at(-1)?.slice(5, 7)).toEqual([
    '2026-01-01', '2026-09-12',
  ]))
  await user.click(custom)
  await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.reset') }))
  await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.apply') }))
  await waitFor(() => {
    expect(screen.getByRole('button', { name: t(fallback) })).toHaveClass('bg-primary')
    expect(reportApi.mock.calls.at(-1)?.[0]).toBe(months)
    expect(reportApi.mock.calls.at(-1)?.slice(5, 7)).toEqual([undefined, undefined])
  })
  expect(custom).toHaveTextContent(t('reports.customRange'))
})

it('preserves saved custom dates across supported tabs and preset dismissal', async () => {
  const { user } = renderWithProviders(<ReportsPage />)
  const custom = screen.getByRole('button', { name: t('reports.customRange') })
  await user.click(custom)
  await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.apply') }))
  for (const tab of ['reports.incomeExpenses', 'reports.moneyMap']) {
    await user.click(screen.getByRole('button', { name: t(tab) }))
    await waitFor(() => expect(api.reports.incomeExpenses.mock.calls.at(-1)?.slice(5, 7))
      .toEqual(['2026-01-01', '2026-09-12']))
    expect(custom).toHaveClass('bg-primary')
  }
  await user.click(screen.getByRole('button', { name: t('reports.range6m') }))
  await waitFor(() => expect(api.reports.incomeExpenses.mock.calls.at(-1)?.slice(5, 7))
    .toEqual([undefined, undefined]))
  const count = api.reports.incomeExpenses.mock.calls.length
  await user.click(custom)
  await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.reset') }))
  await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.cancel') }))
  expect(api.reports.incomeExpenses).toHaveBeenCalledTimes(count)
  expect(screen.getByRole('button', { name: t('reports.range6m') })).toHaveClass('bg-primary')
  await user.click(custom)
  await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.apply') }))
  await waitFor(() => expect(api.reports.incomeExpenses.mock.calls.at(-1)?.slice(5, 7))
    .toEqual(['2026-01-01', '2026-09-12']))
  await user.click(screen.getByRole('button', { name: t('reports.cashFlow') }))
  await waitFor(() => expect(api.reports.cashFlow).toHaveBeenCalled())
  expect(screen.queryByRole('button', { name: t('reports.customRange') })).not.toBeInTheDocument()
  expect(api.reports.cashFlow.mock.calls.at(-1)?.[0]).toBe(6)
  await user.click(screen.getByRole('button', { name: t('reports.netWorth') }))
  await user.click(screen.getByRole('button', { name: t('reports.customRange') }))
  await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.apply') }))
  await waitFor(() => expect(api.reports.netWorth.mock.calls.at(-1)?.slice(-2))
    .toEqual(['2026-01-01', '2026-09-12']))
})

describe('Reports page — query failure', () => {
  it('surfaces a rejected custom range instead of showing stale numbers', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    await waitFor(() => expect(api.reports.netWorth).toHaveBeenCalledTimes(1))

    api.reports.netWorth.mockRejectedValueOnce({
      response: { data: { detail: 'Custom range is too wide (max 10 years)' } },
    })
    await user.click(screen.getByRole('button', { name: t('reports.customRange') }))
    await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.apply') }))

    expect(await screen.findByText('Custom range is too wide (max 10 years)')).toBeInTheDocument()
    // The prior successful report must not linger under the error.
    expect(screen.queryByText(t('reports.trend'), { exact: false })).not.toBeInTheDocument()
    // Tabs and range controls stay usable so the user can correct the request.
    expect(screen.getByRole('button', { name: t('reports.range1y') })).toBeInTheDocument()
  })

  it('shows a generic fallback for a network failure and recovers via Retry', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    await waitFor(() => expect(api.reports.netWorth).toHaveBeenCalledTimes(1))

    api.reports.netWorth.mockRejectedValueOnce(new Error('network error'))
    await user.click(screen.getByRole('button', { name: t('reports.range6m') }))

    expect(await screen.findByText(t('reports.loadError'))).toBeInTheDocument()

    api.reports.netWorth.mockResolvedValueOnce(emptyReport('net_worth'))
    await user.click(screen.getByRole('button', { name: t('common.retry') }))

    await waitFor(() => expect(screen.queryByText(t('reports.loadError'))).not.toBeInTheDocument())
  })

  it('recovers by changing the range after a rejected selection', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    await waitFor(() => expect(api.reports.netWorth).toHaveBeenCalledTimes(1))

    api.reports.netWorth.mockRejectedValueOnce({ response: { data: { detail: 'end_date must be on or before today' } } })
    await user.click(screen.getByRole('button', { name: t('reports.customRange') }))
    await user.click(screen.getByRole('button', { name: t('transactions.filtersBar.apply') }))
    expect(await screen.findByText('end_date must be on or before today')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: t('reports.range6m') }))
    await waitFor(() => expect(screen.queryByText('end_date must be on or before today')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: t('reports.range6m') })).toHaveClass('bg-primary')
  })
})

describe('Reports page, cash-flow runway', () => {
  async function openCashFlow(meta: Partial<ReportResponse['meta']>) {
    const report = emptyReport('cash_flow')
    api.reports.cashFlow.mockResolvedValue({ ...report, meta: { ...report.meta, ...meta } })
    const { user } = renderWithProviders(<ReportsPage />)
    await waitFor(() => expect(api.reports.netWorth).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: t('reports.cashFlow') }))
    return screen.findByTestId('cash-flow-runway')
  }

  it('names the day the balance goes negative and its lowest point', async () => {
    const callout = await openCashFlow({
      runway_date: '2099-10-05',
      lowest_balance: -500,
      lowest_balance_date: '2099-12-20',
    })

    expect(callout).toHaveTextContent(t('reports.runwayNegativeOn', { date: 'Oct 5, 2099' }))
    expect(callout).toHaveTextContent('-$500.00')
    // Only the crossing date is shown: a second date next to the amount reads
    // as part of the same sentence rather than as the bottom of the dip.
    expect(callout).not.toHaveTextContent('Dec 20')
  })

  it('reads today in the workspace timezone, not the browser one', async () => {
    // 23:30 UTC on the 13th is already the 14th fourteen hours ahead, so the
    // same crossing date is "already negative" there and still ahead in UTC.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-10-13T23:30:00Z'))
    try {
      api.timezones.list.mockResolvedValue({ timezones: [], default: 'Pacific/Kiritimati' })
      const ahead = await openCashFlow({
        runway_date: '2026-10-14',
        lowest_balance: -10,
        lowest_balance_date: '2026-10-14',
      })
      await waitFor(() => expect(ahead).toHaveTextContent(t('reports.runwayAlreadyNegative')))

      cleanup()
      api.timezones.list.mockResolvedValue({ timezones: [], default: 'UTC' })
      const behind = await openCashFlow({
        runway_date: '2026-10-14',
        lowest_balance: -10,
        lowest_balance_date: '2026-10-14',
      })
      await waitFor(() =>
        expect(behind).toHaveTextContent(t('reports.runwayNegativeOn', { date: 'Oct 14' })),
      )
    } finally {
      vi.useRealTimers()
      api.timezones.list.mockResolvedValue({ timezones: [], default: null })
    }
  })

  it('says the balance is already negative rather than naming today', async () => {
    const callout = await openCashFlow({
      runway_date: '2020-01-02',
      lowest_balance: -500,
      lowest_balance_date: '2020-01-31',
    })

    expect(callout).toHaveTextContent(t('reports.runwayAlreadyNegative'))
    expect(callout).not.toHaveTextContent(t('reports.runwayNegativeOn', { date: 'Jan 2' }))
  })

  it.each([
    [400, '$400.00'],
    [0, '$0.00'],
  ])('reports a lowest balance of %d as never going below zero', async (lowest, amount) => {
    const callout = await openCashFlow({
      runway_date: null,
      lowest_balance: lowest,
      lowest_balance_date: '2026-12-01',
    })

    expect(callout).toHaveTextContent(t('reports.lowestBalance'))
    expect(callout).toHaveTextContent(amount)
    expect(callout).toHaveTextContent('Dec 1')
  })

  it('is not shown on the other tabs', async () => {
    api.reports.netWorth.mockResolvedValue({
      ...emptyReport('net_worth'),
      meta: { ...emptyReport('net_worth').meta, lowest_balance: 1, lowest_balance_date: '2026-10-01' },
    })
    renderWithProviders(<ReportsPage />)
    await screen.findAllByText('$1,000.00')

    expect(screen.queryByTestId('cash-flow-runway')).not.toBeInTheDocument()
  })
})

describe('Reports page: month presets and period navigation (issue #519)', () => {
  it('offers This Month and Last Month with exact month windows', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    expect(await screen.findByRole('heading', { name: 'Net Worth' })).toBeInTheDocument()

    // The default preset (1Y) keeps the API-anchored window: no explicit dates.
    expect(api.reports.netWorth.mock.calls.at(-1)?.slice(-2)).toEqual([undefined, undefined])

    await user.click(screen.getByRole('button', { name: 'This Month' }))
    expect(api.reports.netWorth.mock.calls.at(-1)?.slice(-2)).toEqual(['2026-09-01', '2026-09-12'])
    expect(screen.getByTestId('reports-period-label')).toHaveTextContent('September 2026')

    await user.click(screen.getByRole('button', { name: 'Last Month' }))
    expect(api.reports.netWorth.mock.calls.at(-1)?.slice(-2)).toEqual(['2026-08-01', '2026-08-31'])
    expect(screen.getByTestId('reports-period-label')).toHaveTextContent('August 2026')
  })

  it('steps the active period back and forward with the arrows', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    await screen.findByRole('heading', { name: 'Net Worth' })
    await user.click(screen.getByRole('button', { name: 'This Month' }))

    const prev = screen.getByRole('button', { name: 'Previous period' })
    const next = screen.getByRole('button', { name: 'Next period' })
    expect(next).toBeDisabled()

    await user.click(prev)
    expect(screen.getByTestId('reports-period-label')).toHaveTextContent('August 2026')
    expect(api.reports.netWorth.mock.calls.at(-1)?.slice(-2)).toEqual(['2026-08-01', '2026-08-31'])
    expect(next).not.toBeDisabled()

    await user.click(next)
    expect(screen.getByTestId('reports-period-label')).toHaveTextContent('September 2026')
    expect(api.reports.netWorth.mock.calls.at(-1)?.slice(-2)).toEqual(['2026-09-01', '2026-09-12'])
    expect(next).toBeDisabled()
  })

  it('steps a macro preset back by a whole window and labels the covered span', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    await screen.findByRole('heading', { name: 'Net Worth' })
    await user.click(screen.getByRole('button', { name: '6M' }))

    expect(screen.getByTestId('reports-period-label')).toHaveTextContent('6M')
    await user.click(screen.getByRole('button', { name: 'Previous period' }))

    expect(api.reports.netWorth.mock.calls.at(-1)?.slice(-2)).toEqual(['2025-08-01', '2026-02-28'])
    expect(screen.getByTestId('reports-period-label')).toHaveTextContent('Aug 2025 - Feb 2026')
  })

  it('does not carry a stepped window into the Cash Flow forecast', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    await screen.findByRole('heading', { name: 'Net Worth' })
    await user.click(screen.getByRole('button', { name: '6M' }))
    await user.click(screen.getByRole('button', { name: 'Previous period' }))

    await user.click(screen.getByRole('button', { name: t('reports.cashFlow') }))
    await waitFor(() => expect(api.reports.cashFlow).toHaveBeenCalled())

    expect(api.reports.cashFlow.mock.calls.at(-1)?.[0]).toBe(6)
  })

  it('hides period navigation on the forward-only Cash Flow tab', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    await screen.findByRole('heading', { name: 'Net Worth' })
    expect(screen.getByRole('button', { name: 'Previous period' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: t('reports.cashFlow') }))
    expect(screen.queryByRole('button', { name: 'Previous period' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('reports-period-nav')).not.toBeInTheDocument()
  })
})

describe('Reports page - year picker (issue #765)', () => {
  beforeEach(() => {
    api.reports.dataRange.mockResolvedValue({ min_date: '2023-04-10', max_date: '2026-09-12' })
  })

  it('lists every year from this year back to the oldest transaction', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    const trigger = await screen.findByRole('button', { name: t('reports.year') })
    await user.click(trigger)
    await screen.findByRole('button', { name: '2026' })
    expect(screen.getByRole('button', { name: '2025' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2024' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2023' })).toBeInTheDocument()
  })

  it('commits the picked past year as a Jan 1 to Dec 31 range', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    const trigger = await screen.findByRole('button', { name: t('reports.year') })
    await user.click(trigger)
    await user.click(await screen.findByRole('button', { name: '2023' }))

    // Full calendar year: 364 days, ceil(364/30) = 13 monthly buckets.
    expect(api.reports.netWorth).toHaveBeenCalledWith(
      13, 'monthly', undefined, undefined, undefined, '2023-01-01', '2023-12-31',
    )
    // The custom segment is now the active range and shows the span.
    expect(screen.getByRole('button', { name: t('reports.customRange') })).toHaveClass('bg-primary')
    expect(screen.getByRole('button', { name: t('reports.customRange') })).toHaveTextContent('Jan 01 - Dec 31')
    // The trigger highlights the year that is currently on screen.
    expect(screen.getByRole('button', { name: `${t('reports.year')} 2023` })).toHaveClass('bg-primary')
  })

  it('ends the current year at today', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    const trigger = await screen.findByRole('button', { name: t('reports.year') })
    await user.click(trigger)
    await user.click(await screen.findByRole('button', { name: '2026' }))

    // Jan 1 through today (2026-09-12): 254 days, ceil(254/30) = 9.
    expect(api.reports.netWorth).toHaveBeenCalledWith(
      9, 'monthly', undefined, undefined, undefined, '2026-01-01', '2026-09-12',
    )
  })

  it('hides the picker when the data spans a single year', async () => {
    // Two phases: the same widget shows for multi-year data and disappears
    // once the data no longer covers a previous year.
    renderWithProviders(<ReportsPage />)
    await screen.findByRole('button', { name: t('reports.year') })
    cleanup()

    api.reports.dataRange.mockResolvedValue({ min_date: '2026-01-05', max_date: '2026-09-12' })
    renderWithProviders(<ReportsPage />)
    await screen.findByRole('heading', { name: 'Net Worth' })
    expect(screen.queryByRole('button', { name: t('reports.year') })).not.toBeInTheDocument()
  })

  it('hides the picker when the data range fails to load', async () => {
    renderWithProviders(<ReportsPage />)
    await screen.findByRole('button', { name: t('reports.year') })
    cleanup()

    api.reports.dataRange.mockRejectedValue(new Error('network down'))
    renderWithProviders(<ReportsPage />)
    await screen.findByRole('heading', { name: 'Net Worth' })
    expect(screen.queryByRole('button', { name: t('reports.year') })).not.toBeInTheDocument()
  })

  it('is not offered on the forward-only Cash Flow tab', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    const trigger = await screen.findByRole('button', { name: t('reports.year') })
    expect(trigger).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: t('reports.cashFlow') }))
    await screen.findByRole('heading', { name: t('reports.cashFlow') })
    expect(screen.queryByRole('button', { name: t('reports.year') })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: `${t('reports.year')} 2026` })).not.toBeInTheDocument()
  })
})

const point = (date: string, value: number) => ({ date, value, breakdowns: {}, change: null })
const trendItem = (key: string, group: string, values: [number, number]) => ({
  key,
  label: key,
  color: '#6366F1',
  total: values[0] + values[1],
  group,
  series: [point('Jan', values[0]), point('Feb', values[1])],
})

function incomeExpensesReport(extra: Partial<ReportResponse> = {}): ReportResponse {
  return {
    ...emptyReport('income_expenses'),
    summary: {
      primary_value: 500,
      change_amount: 10,
      change_percent: 2,
      breakdowns: [
        { key: 'income', label: 'Income', value: 1000, color: '#10B981' },
        { key: 'expenses', label: 'Expenses', value: 500, color: '#F43F5E' },
      ],
    },
    composition: [{ key: 'food', label: 'Food', value: 500, color: '#F59E0B', group: 'expenses' }],
    category_trend: [
      trendItem('food', 'expenses', [200, 300]),
      trendItem('rent', 'expenses', [100, 100]),
      trendItem('salary', 'income', [500, 500]),
    ],
    ...extra,
  }
}

describe('Reports page, spending by category card', () => {
  it('shows the card title, switches side and toggles the share mode', async () => {
    api.reports.incomeExpenses.mockResolvedValue(incomeExpensesReport())
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(screen.getByRole('button', { name: t('reports.incomeExpenses') }))

    const card = await screen.findByTestId('category-stack-card')
    expect(within(card).getByText(t('reports.spendingByCategory'))).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: t('reports.byIncome') }))
    expect(within(card).getByText(t('reports.incomeByCategory'))).toBeInTheDocument()

    const share = within(card).getByRole('button', { name: t('reports.stackPercent') })
    expect(share).toHaveAttribute('aria-pressed', 'false')
    await user.click(share)
    expect(share).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('Reports page, period comparison', () => {
  const comparisonReport = () =>
    incomeExpensesReport({
      comparison: {
        start_date: '2025-08-01',
        end_date: '2025-08-31',
        summary: {
          primary_value: 450,
          change_amount: 0,
          change_percent: null,
          breakdowns: [
            { key: 'income', label: 'Income', value: 900, color: '#10B981' },
            { key: 'expenses', label: 'Expenses', value: 400, color: '#F43F5E' },
          ],
        },
        composition: [{ key: 'food', label: 'Food', value: 400, color: '#F59E0B', group: 'expenses' }],
        current_composition: [{ key: 'food', label: 'Food', value: 500, color: '#F59E0B', group: 'expenses' }],
      },
    })

  it('sends the compare mode and renders the hero deltas and the table', async () => {
    api.reports.incomeExpenses.mockResolvedValue(comparisonReport())
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(screen.getByRole('button', { name: t('reports.incomeExpenses') }))
    await waitFor(() => expect(api.reports.incomeExpenses).toHaveBeenCalled())
    expect(api.reports.incomeExpenses.mock.calls.at(-1)?.[7]).toBeUndefined()

    await user.click(within(screen.getByTestId('reports-compare')).getByRole('button', { name: t('reports.comparePrevious') }))
    await waitFor(() => expect(api.reports.incomeExpenses.mock.calls.at(-1)?.[7]).toBe('previous'))

    expect(await screen.findByText(new RegExp(t('reports.vsPrevious')))).toBeInTheDocument()
    expect(screen.getByText('+$100.00 (+25.0%)')).toBeInTheDocument()
    const row = screen.getByRole('row', { name: /Food/ })
    expect(within(row).getByText('+$100.00')).toBeInTheDocument()
    expect(within(row).getByText('+25.0%')).toBeInTheDocument()

    await user.click(within(screen.getByTestId('reports-compare')).getByRole('button', { name: t('reports.compareOff') }))
    await waitFor(() => expect(api.reports.incomeExpenses.mock.calls.at(-1)?.[7]).toBeUndefined())
  })

  it('never sends compare from the Money Map tab', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(screen.getByRole('button', { name: t('reports.incomeExpenses') }))
    await user.click(within(await screen.findByTestId('reports-compare')).getByRole('button', { name: t('reports.compareYearAgo') }))
    await waitFor(() => expect(api.reports.incomeExpenses.mock.calls.at(-1)?.[7]).toBe('year_ago'))

    await user.click(screen.getByRole('button', { name: t('reports.moneyMap') }))
    await waitFor(() => expect(screen.queryByTestId('reports-compare')).not.toBeInTheDocument())
    await waitFor(() => expect(api.reports.incomeExpenses.mock.calls.at(-1)?.[7]).toBeUndefined())
  })
})

describe('Reports page, composition donut by category group', () => {
  const groupedReport = () =>
    incomeExpensesReport({
      composition: [
        { key: 'rent', label: 'Rent', value: 300, color: '#F59E0B', group: 'expenses', group_id: 'g1', group_name: 'Essentials', group_color: '#112233' },
        { key: 'food', label: 'Food', value: 200, color: '#10B981', group: 'expenses', group_id: 'g1', group_name: 'Essentials', group_color: '#112233' },
        { key: 'fun', label: 'Fun', value: 100, color: '#8B5CF6', group: 'expenses' },
      ],
    })

  it('narrows to one group on click and goes back', async () => {
    api.reports.incomeExpenses.mockResolvedValue(groupedReport())
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(screen.getByRole('button', { name: t('reports.incomeExpenses') }))

    const card = (await screen.findByText(t('reports.composition'))).closest('.rounded-xl') as HTMLElement
    await user.click(within(card).getByRole('button', { name: t('reports.byExpenses') }))

    expect(within(card).getByRole('button', { name: 'Essentials' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: t('reports.noGroup') })).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: 'Essentials' }))
    expect(within(card).getByText('Rent')).toBeInTheDocument()
    expect(within(card).getByText('Food')).toBeInTheDocument()
    expect(within(card).queryByText('Fun')).not.toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: t('common.back') }))
    expect(within(card).getByRole('button', { name: 'Essentials' })).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: 'Essentials' }))
    await user.click(within(card).getByRole('button', { name: t('reports.byIncome') }))
    expect(within(card).queryByRole('button', { name: t('common.back') })).not.toBeInTheDocument()
  })
})

describe('Reports page, income statement tab', () => {
  const item = (
    key: string,
    group: 'income' | 'expenses',
    value: number,
    groupId: string,
    groupName: string,
  ) => ({ key, label: key, value, color: '#888', group, group_id: groupId, group_name: groupName, group_color: '#444' })

  const statementReport = (): ReportResponse => {
    const composition = [
      item('Salary', 'income', 1000, 'work', 'Work Income'),
      item('Rent', 'expenses', 400, 'housing', 'Housing'),
      item('Groceries', 'expenses', 200, 'food', 'Food'),
    ]
    return {
      ...emptyReport('income_expenses'),
      trend: ['2026-07', '2026-08'].map((date) => ({ date, value: 0, breakdowns: {}, change: null, composition })),
    }
  }

  it('shows the statement, expands a group and sends no compare', async () => {
    api.reports.incomeExpenses.mockResolvedValue(statementReport())
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(screen.getByRole('button', { name: t('reports.incomeStatement') }))

    const table = await screen.findByTestId('income-statement-table')
    expect(within(table).getByText(t('reports.statementIncome'))).toBeInTheDocument()
    expect(within(table).getByText(t('reports.statementExpenses'))).toBeInTheDocument()
    expect(within(table).getByText(t('reports.statementResult'))).toBeInTheDocument()
    expect(within(table).getByText('Housing')).toBeInTheDocument()
    expect(within(table).queryByText('Rent')).not.toBeInTheDocument()

    const housing = within(table).getByRole('button', { name: 'Housing' })
    expect(housing).toHaveAttribute('aria-expanded', 'false')
    housing.focus()
    await user.keyboard('{Enter}')
    expect(housing).toHaveAttribute('aria-expanded', 'true')
    expect(within(table).getByText('Rent')).toBeInTheDocument()
    await user.click(housing)
    expect(housing).toHaveAttribute('aria-expanded', 'false')
    await user.click(housing)

    expect(screen.queryByTestId('reports-compare')).not.toBeInTheDocument()
    expect(api.reports.incomeExpenses.mock.calls.at(-1)?.[7]).toBeUndefined()
  })

  it('asks for explicit dates, so the statement shows actuals only', async () => {
    api.reports.incomeExpenses.mockResolvedValue(statementReport())
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(screen.getByRole('button', { name: t('reports.incomeExpenses') }))
    await waitFor(() => expect(api.reports.incomeExpenses).toHaveBeenCalled())
    // 1Y at offset 0 sends no dates on this tab.
    expect(api.reports.incomeExpenses.mock.calls.at(-1)?.slice(5, 7)).toEqual([undefined, undefined])

    await user.click(screen.getByRole('button', { name: t('reports.incomeStatement') }))
    await waitFor(() => {
      const [start, end] = api.reports.incomeExpenses.mock.calls.at(-1)?.slice(5, 7) ?? []
      expect(start).toMatch(/^\d{4}-\d{2}-01$/)
      expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })
})
