import { z } from 'zod';
import {
  FinanceStandardizationReconciliationSchema,
  type FinanceStandardizationRun,
} from '@emdo/contracts/browser';
import {
  standardizationBase,
  standardizationJson,
  StandardizationRequestError,
} from './finance-standardization-api.js';

export type StandardizationReconciliation = z.infer<
  typeof FinanceStandardizationReconciliationSchema
>;
export type ReconciliationReservation =
  StandardizationReconciliation['spend'][number];
export type ReconciliationReceipt =
  StandardizationReconciliation['receipts'][number];
export const reconciliationPath = (
  run: Pick<FinanceStandardizationRun, 'bookId' | 'id'>,
) =>
  `${standardizationBase(run.bookId)}/standardizations/${run.id}/reconciliation`;
export function verifyReconciliation(
  raw: unknown,
  run: Pick<FinanceStandardizationRun, 'bookId' | 'id' | 'sourceDigest'>,
) {
  const result = FinanceStandardizationReconciliationSchema.parse(raw);
  const reservationIds = new Set(result.spend.map((spend) => spend.id));
  if (
    result.bookId !== run.bookId ||
    result.runId !== run.id ||
    result.sourceDigest !== run.sourceDigest ||
    reservationIds.size !== result.spend.length ||
    new Set(result.receipts.map((receipt) => receipt.id)).size !==
      result.receipts.length ||
    result.receipts.some(
      (receipt) => !reservationIds.has(receipt.reservationId),
    )
  )
    throw new Error(
      'The saved outcome and its original could not be verified. Refresh this analysis.',
    );
  return result;
}
export async function readReconciliation(
  run: Pick<FinanceStandardizationRun, 'bookId' | 'id' | 'sourceDigest'>,
  signal: AbortSignal,
) {
  return verifyReconciliation(
    await standardizationJson(reconciliationPath(run), signal),
    run,
  );
}
export function reconciliationError(cause: unknown) {
  if (cause instanceof StandardizationRequestError) {
    if ([401, 403].includes(cause.status))
      return 'Administrator access is required to reconcile an analysis outcome. Previously loaded cost details have been cleared.';
    if (cause.status === 409)
      return 'The saved outcome or its evidence changed. Refresh and review the current record before continuing.';
    if (cause.status === 503)
      return 'Outcome reconciliation is not available right now. Existing cost reservations remain unchanged.';
  }
  return cause instanceof z.ZodError
    ? 'The saved outcome response could not be verified. Refresh before continuing.'
    : cause instanceof Error
      ? cause.message
      : 'Unable to read or reconcile the saved outcome.';
}
export function cadMinorText(value: number | null) {
  if (value === null) return 'Not established';
  const minor = BigInt(value);
  return `CAD ${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
}
export function reconciliationChoices(
  record: StandardizationReconciliation,
  reservationId: string,
  receiptId: string,
) {
  const reservation = record.spend.find((item) => item.id === reservationId);
  const receipt = record.receipts.find((item) => item.id === receiptId);
  const canResolve =
    record.canResolve &&
    !record.hasLiveLease &&
    ['indeterminate', 'cancelled', 'authority-revoked'].includes(record.status);
  const latestAttempt = record.spend.reduce(
    (latest, item) => Math.max(latest, item.attempt),
    0,
  );
  const isLatest = !!reservation && reservation.attempt === latestAttempt;
  const verifiedReceipt = !!(
    reservation &&
    receipt &&
    receipt.reservationId === reservation.id &&
    receipt.providerResponseId === reservation.providerResponseId &&
    receipt.status === 'verified' &&
    receipt.receiptDigest &&
    receipt.actualCadMinor !== null
  );
  return {
    reservation,
    receipt,
    isLatest,
    canConfirmNotSent:
      canResolve &&
      (record.spend.length === 0 ||
        (isLatest && reservation?.dispatchPhase === 'not-dispatched')),
    canAcceptActual:
      canResolve &&
      isLatest &&
      !!reservation &&
      ((reservation.status === 'completed' &&
        reservation.actualCadMinor !== null) ||
        verifiedReceipt),
    actualCost:
      reservation?.status === 'completed'
        ? reservation.actualCadMinor
        : verifiedReceipt
          ? receipt!.actualCadMinor
          : null,
    canRequestReceipt:
      record.canResolve &&
      record.receipts.length < 30 &&
      !!reservation?.providerResponseId &&
      !record.receipts.some(
        (item) =>
          item.reservationId === reservation.id &&
          item.providerResponseId === reservation.providerResponseId &&
          ['pending', 'verified'].includes(item.status),
      ),
  };
}
