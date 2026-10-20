import { describe, expect, it } from 'vitest'
import { formAmount, isInflow, signedAmount, storedAmount, transactionKind, typeForKind } from './transaction-direction'

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

describe('transaction kind (form mapping)', () => {
  it.each([
    ['debit', 100, 'expense', 100],
    ['credit', 100, 'income', 100],
    ['debit', -472.46, 'refund', 472.46],
    ['debit', '-472.46', 'refund', 472.46],
    ['credit', -50, 'income', -50],
  ] as const)('%s %s loads as %s with form amount %s', (type, amount, kind, shown) => {
    expect(transactionKind({ type, amount })).toBe(kind)
    expect(formAmount({ type, amount })).toBe(shown)
  })

  it('round-trips a refund back to a negative debit', () => {
    const tx = { type: 'debit', amount: -472.46 } as const
    const kind = transactionKind(tx)
    expect(typeForKind(kind)).toBe('debit')
    expect(storedAmount(kind, formAmount(tx))).toBe(-472.46)
  })

  it('stores a refund as a negative debit whatever sign was typed', () => {
    expect(storedAmount('refund', 10)).toBe(-10)
    expect(storedAmount('refund', -10)).toBe(-10)
  })

  it('keeps expense and income amounts as typed, including a negative credit', () => {
    expect(storedAmount('expense', 10)).toBe(10)
    expect(storedAmount('income', 10)).toBe(10)
    expect(storedAmount('income', -50)).toBe(-50)
    expect(typeForKind('income')).toBe('credit')
    expect(typeForKind('expense')).toBe('debit')
  })
})
