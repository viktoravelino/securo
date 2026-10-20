import { describe, expect, it } from 'vitest'
import { isInflow, signedAmount } from './transaction-direction'

describe('transaction direction', () => {
  it.each([
    ['credit', 100, true, 100],
    ['debit', 100, false, -100],
    ['debit', -472.46, true, 472.46],
    ['credit', -50, false, -50],
    ['debit', '-472.46', true, 472.46],
    ['credit', '25.5', true, 25.5],
    ['credit', 0, true, 0],
    ['debit', 0, false, -0],
  ] as const)('%s %s -> inflow %s, signed %s', (type, amount, inflow, signed) => {
    expect(isInflow({ type, amount })).toBe(inflow)
    expect(signedAmount({ type, amount })).toBe(signed)
  })
})
