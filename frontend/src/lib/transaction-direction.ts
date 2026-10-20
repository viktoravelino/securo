import type { Transaction } from '@/types'

type DirectionInput = Pick<Transaction, 'type'> & { amount: number | string }

/**
 * True when the transaction brings money in: a credit, or a debit with a
 * negative amount (refund / repayment). A negative credit reads as an outflow.
 * Zero amounts follow `type`.
 */
export function isInflow({ type, amount }: DirectionInput): boolean {
  const negative = Number(amount) < 0
  return (type === 'credit') !== negative
}

/** Amount signed by direction: positive for inflow, negative for outflow. */
export function signedAmount(tx: DirectionInput): number {
  const magnitude = Math.abs(Number(tx.amount))
  return isInflow(tx) ? magnitude : -magnitude
}

/**
 * What the transaction form calls a transaction. Storage stays
 * `type` + signed `amount`; "refund" is a debit with a negative amount.
 */
export type TransactionKind = 'expense' | 'income' | 'refund'

/** Form kind for a stored transaction. A negative credit stays "income". */
export function transactionKind({ type, amount }: DirectionInput): TransactionKind {
  if (type === 'credit') return 'income'
  return Number(amount) < 0 ? 'refund' : 'expense'
}

/** Stored `type` for a form kind. */
export function typeForKind(kind: TransactionKind): Transaction['type'] {
  return kind === 'income' ? 'credit' : 'debit'
}

/**
 * Amount to show in the form: a refund is entered as a positive magnitude.
 * Every other kind keeps the stored amount (and sign) as is.
 */
export function formAmount(tx: DirectionInput): number {
  const amount = Number(tx.amount)
  return transactionKind(tx) === 'refund' ? Math.abs(amount) : amount
}

/**
 * Amount to store for a form kind: a refund is saved as `-abs(amount)`,
 * expense and income as typed.
 */
export function storedAmount(kind: TransactionKind, amount: number): number {
  return kind === 'refund' ? -Math.abs(amount) : amount
}
