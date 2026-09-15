import {
  FinanceStandardizationReconciliationSchema,
  LookupFinanceStandardizationReceiptSchema,
  ResolveFinanceStandardizationSchema,
  type FinanceStandardizationRun,
} from '@emdo/contracts/browser';
import { reconciliationChoices } from '../src/features/finance-v1/finance-standardization-reconciliation-api.js';

export const reservationId = '74000000-0000-4000-8000-000000000001';
export const receiptId = '74000000-0000-4000-8000-000000000002';
export function reconciliationFixture(run: FinanceStandardizationRun) {
  const record = FinanceStandardizationReconciliationSchema.parse({
    runId: run.id,
    workspaceId: run.workspaceId,
    bookId: run.bookId,
    sourceDigest: run.sourceDigest,
    revision: run.revision,
    status: run.status,
    hasLiveLease: false,
    canResolve: true,
    spend: [
      {
        id: reservationId,
        attempt: 1,
        status: 'indeterminate',
        dispatchPhase: 'dispatch-started',
        pricingVersion: 'fixture-rates.v1',
        pricing: {
          inputCadMinorPerMillionTokens: 200,
          outputCadMinorPerMillionTokens: 1200,
        },
        reservedCadMinor: 50,
        actualCadMinor: null,
        providerResponseId: 'response-reconciliation-original',
        lineage: { sourceEvidenceId: run.evidenceId },
      },
    ],
    receipts: [],
    resolutions: [],
  });
  const state = {
    readStatus: 200,
    writeStatus: 200,
    loseLookupResponse: false,
  };
  function addReceipt(
    status: 'pending' | 'verified' | 'unavailable' | 'mismatch' = 'pending',
  ) {
    const receipt = {
      id: receiptId,
      reservationId,
      providerResponseId: 'response-reconciliation-original',
      status,
      receiptDigest: status === 'verified' ? 'c'.repeat(64) : null,
      inputTokens: status === 'verified' ? 10000 : null,
      outputTokens: status === 'verified' ? 1000 : null,
      actualCadMinor: status === 'verified' ? 4 : null,
      observedAt: '2026-09-14T16:00:00.000Z',
    };
    record.receipts.splice(0, record.receipts.length, receipt);
    return receipt;
  }
  function handle(method = 'GET', payload: unknown = {}, path = '') {
    if (method === 'GET')
      return {
        status: state.readStatus,
        json: state.readStatus === 200 ? record : {},
      };
    if (state.writeStatus !== 200)
      return { status: state.writeStatus, json: {} };
    if (path.endsWith('/lookup')) {
      const body = LookupFinanceStandardizationReceiptSchema.parse(payload);
      if (
        body.expectedRevision !== record.revision ||
        body.reservationId !== reservationId
      )
        return { status: 409, json: {} };
      if (
        !record.receipts.some((receipt) =>
          ['pending', 'verified'].includes(receipt.status),
        )
      ) {
        const history = [...record.receipts];
        const receipt = addReceipt();
        if (history.length)
          receipt.id = `74000000-0000-4000-8000-${String(history.length + 10).padStart(12, '0')}`;
        record.receipts = [...history, receipt];
      }
      if (state.loseLookupResponse) {
        state.loseLookupResponse = false;
        throw new TypeError('Lookup response lost');
      }
    } else if (path.endsWith('/resolve')) {
      const body = ResolveFinanceStandardizationSchema.parse(payload);
      const choice = reconciliationChoices(
        record,
        body.reservationId ?? '',
        body.receiptId ?? '',
      );
      if (
        body.expectedRevision !== record.revision ||
        (body.decision === 'confirm-not-sent'
          ? !choice.canConfirmNotSent
          : !choice.canAcceptActual)
      )
        return { status: 409, json: {} };
      if (choice.reservation) {
        choice.reservation.status =
          body.decision === 'confirm-not-sent' ? 'not-sent' : 'completed';
        choice.reservation.actualCadMinor =
          body.decision === 'confirm-not-sent' ? 0 : choice.actualCost;
      }
      record.resolutions.push({
        id: '74000000-0000-4000-8000-000000000003',
        reservationId: body.reservationId,
        decision: body.decision,
        reviewedBy: run.authorizedByUserId,
        reviewedAt: '2026-09-14T16:05:00.000Z',
        receiptId: body.receiptId,
      });
      record.revision++;
      if (record.status === 'indeterminate') {
        record.status = 'blocked';
        run.status = 'blocked';
      }
      run.revision = record.revision;
    } else throw new Error(`Unexpected reconciliation path ${path}`);
    return { status: 200, json: record };
  }
  return { record, state, addReceipt, handle };
}
