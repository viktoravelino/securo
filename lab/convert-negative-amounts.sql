-- Convert the fork's refund model (a debit with a negative amount) to the
-- upstream model (a credit with a positive amount). A negative credit becomes
-- a positive debit. Only manual rows outside a transfer pair change.
BEGIN;

UPDATE transactions
SET type = CASE type WHEN 'debit' THEN 'credit' ELSE 'debit' END,
    amount = -amount,
    amount_primary = -amount_primary
WHERE amount < 0
  AND source = 'manual'
  AND transfer_pair_id IS NULL;

UPDATE recurring_transactions
SET type = CASE type WHEN 'debit' THEN 'credit' ELSE 'debit' END,
    amount = -amount,
    amount_primary = abs(amount_primary)
WHERE amount < 0;

-- Nothing negative may be left.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM transactions WHERE amount < 0)
     OR EXISTS (SELECT 1 FROM recurring_transactions WHERE amount < 0 OR amount_primary < 0) THEN
    RAISE EXCEPTION 'negative amounts are left';
  END IF;
END $$;

COMMIT;
