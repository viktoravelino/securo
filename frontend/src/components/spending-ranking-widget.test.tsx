import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { SpendingRankingWidget } from '@/components/spending-ranking-widget'
import { renderWithProviders } from '@/test/utils'
import type { DashboardScope } from '@/components/dashboard-widgets'

const api = vi.hoisted(() => ({
  dashboard: { spendingByCategory: vi.fn() },
  budgets: { comparison: vi.fn() },
}))
vi.mock('@/lib/api', () => api)
vi.mock('@/hooks/use-display-locale', () => ({ useDisplayLocale: () => 'en-US', useDateLocale: () => 'en-US' }))
vi.mock('@/hooks/use-privacy-mode', () => ({ usePrivacyMode: () => ({ mask: (v: string) => v, privacyMode: false, MASK: '••••' }) }))

const SCOPE: DashboardScope = { month: '2026-03', activeAccountIds: null, activeWalletIds: null, noAccounts: false, currency: 'USD' }
const row = (id: string, total: number) => ({ category_id: id, category_name: id, category_icon: 'x', category_color: '#111111', total, projected_total: total, percentage: 0 })

describe('SpendingRankingWidget', () => {
  it('lists categories largest first with their share', async () => {
    api.dashboard.spendingByCategory.mockResolvedValue([row('Food', 250), row('Rent', 750)])
    api.budgets.comparison.mockResolvedValue([])
    renderWithProviders(<SpendingRankingWidget scope={SCOPE} />)
    await screen.findByText('Rent')
    const names = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(names[0]).toContain('Rent')
    expect(names[1]).toContain('Food')
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
  })
})
