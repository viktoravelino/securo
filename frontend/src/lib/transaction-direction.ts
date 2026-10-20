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
