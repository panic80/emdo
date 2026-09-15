import { createHash } from 'node:crypto';
import {
  FinanceReportMappingDefinitionSchema,
  FinanceStandardizationRunSchema,
  type FinanceStandardizationRun,
} from '@emdo/contracts/browser';
import {
  FINANCE_EXTRACTION_REGISTRY,
  standardizationAllowedActions,
} from '../../../packages/domains/src/finance/standardization.js';

export const standardizationBookId = '73000000-0000-4000-8000-000000000001';
export const standardizationEvidenceId = '73000000-0000-4000-8000-000000000002';
export const standardizationMappingId = '73000000-0000-4000-8000-000000000003';
export const standardizationRunId = '73000000-0000-4000-8000-000000000004';
const userId = '73000000-0000-4000-8000-000000000005';
const workspaceId = '73000000-0000-4000-8000-000000000006';
export const standardizationCsv =
  'Date,Memo,Amount,Currency\n2026-01-01,Reviewed payment,10.00,CAD\n';
export const standardizationDigest = createHash('sha256')
  .update(standardizationCsv)
  .digest('hex');
export const standardizationDefinition =
  FinanceReportMappingDefinitionSchema.parse({
    providerKey: 'Example bank',
    reportName: 'Account activity',
    reportType: 'bank-transactions',
    layoutVersion: '1',
    headers: ['Date', 'Memo', 'Amount', 'Currency'],
    bindings: [
      { field: 'transactionDate', column: 'Date', context: null },
      { field: 'description', column: 'Memo', context: null },
      { field: 'amount', column: 'Amount', context: null },
      { field: 'currency', column: 'Currency', context: null },
    ],
    dateFormat: 'yyyy-mm-dd',
    decimalSeparator: '.',
    groupingSeparator: ',',
    quantityUnit: null,
    valuationMultiplier: null,
    identifierScheme: null,
    identifierNamespace: null,
  });
export function standardizationFixture() {
  const state = {
    ready: true,
    readStatus: 200,
    writeStatus: 200,
    canManage: true,
    loseStartResponse: false,
  };
  const originals = [
    {
      id: standardizationEvidenceId,
      filename: 'activity.csv',
      format: 'csv',
      sourceDigest: standardizationDigest,
    },
  ];
  const runs: FinanceStandardizationRun[] = [];
  function createRun(
    status: FinanceStandardizationRun['status'] = 'queued',
    format = 'csv',
  ) {
    const run = FinanceStandardizationRunSchema.parse({
      id: standardizationRunId,
      workspaceId,
      bookId: standardizationBookId,
      evidenceId: standardizationEvidenceId,
      filename: `activity.${format}`,
      format,
      sourceDigest: standardizationDigest,
      revision: 1,
      attempt: 0,
      status: 'queued',
      authorizedByUserId: userId,
      authorizationExpiresAt: '2026-09-15T12:00:00.000Z',
      createdAt: '2026-09-14T12:00:00.000Z',
      updatedAt: '2026-09-14T12:00:00.000Z',
      extraction: null,
      proposal: null,
      modelProvenance: null,
      blockers: [],
      allowedActions: ['cancel'],
      approval: 'not-granted',
      posting: 'not-performed',
    });
    updateRun(run, status);
    runs.unshift(run);
    return run;
  }
  function updateRun(
    run: FinanceStandardizationRun,
    status: FinanceStandardizationRun['status'],
  ) {
    run.status = status;
    if (['proposing', 'needs-review', 'blocked'].includes(status)) {
      run.extraction = {
        revision: 1,
        adapterId: `finance.${run.format === 'xlsx' ? 'xlsx-regions' : run.format === 'pdf' ? 'pdf-layout' : 'csv-table'}`,
        adapterVersion: '1',
        sourceDigest: run.sourceDigest,
        extractionDigest: 'b'.repeat(64),
        status: 'needs-source-review',
        tableCount: run.format === 'pdf' ? 0 : 1,
        sheetCount: run.format === 'xlsx' ? 2 : 0,
        pageCount: run.format === 'pdf' ? 3 : 0,
        truncated: false,
        issues: [
          'Header, date locale and financial field meanings require source review.',
        ],
      };
    }
    if (status === 'needs-review') {
      run.proposal = {
        mappingId: run.format === 'csv' ? standardizationMappingId : null,
        mappingVersion: 1,
        definition: standardizationDefinition,
        rationale:
          'Column meanings are proposed from source headings and example values.',
        status: 'candidate',
        unresolvedQuestions: [
          'Confirm whether positive amounts represent receipts.',
        ],
      };
      run.modelProvenance = {
        controller: 'emdo',
        orchestrationMode: 'registered-workflow',
        managerInvocationId: '73000000-0000-4000-8000-000000000007',
        financeInvocationId: '73000000-0000-4000-8000-000000000008',
        providerResponseId: 'response-standardization-fixture',
        model: 'gpt-6-astra',
        reasoningEffort: 'max',
        promptVersion: 'finance-standardization-proposal.v1',
        completedAt: '2026-09-14T12:05:00.000Z',
      };
    }
    if (status === 'blocked')
      run.blockers = [
        'The source requires review before another analysis attempt.',
      ];
    run.allowedActions = standardizationAllowedActions(run, state.canManage);
    return run;
  }
  const options = () => ({
    registry: FINANCE_EXTRACTION_REGISTRY,
    ready: state.ready,
    reason: state.ready ? null : 'The saved analysis service is not available.',
  });
  function handle(
    url: string,
    method = 'GET',
    body: Record<string, unknown> = {},
  ): { status: number; json: unknown } {
    const parsed = new URL(url, 'http://localhost'),
      path = parsed.pathname;
    const ok = (json: unknown) => ({ status: 200, json });
    if (method === 'POST') {
      if (state.writeStatus !== 200)
        return {
          status: state.writeStatus,
          json: { code: 'finance-standardization-conflict' },
        };
      if (path.endsWith('/evidence'))
        return ok({
          id: standardizationEvidenceId,
          sourceDigest: standardizationDigest,
        });
      if (path.endsWith('/standardizations')) {
        if (
          body.evidenceId !== standardizationEvidenceId ||
          body.expectedSourceDigest !== standardizationDigest
        )
          return { status: 409, json: { code: 'source-mismatch' } };
        const run =
          runs.find((item) => item.evidenceId === body.evidenceId) ??
          createRun();
        if (state.loseStartResponse) {
          state.loseStartResponse = false;
          throw new TypeError('Network response was lost');
        }
        return ok(run);
      }
      const run = runs.find((item) => path.includes(item.id));
      if (!run) return { status: 404, json: {} };
      if (body.expectedRevision !== run.revision)
        return { status: 409, json: { code: 'revision-changed' } };
      run.revision++;
      if (path.endsWith('/retry')) {
        run.attempt++;
        run.blockers = [];
        updateRun(run, 'queued');
      } else if (path.endsWith('/cancel')) updateRun(run, 'cancelled');
      else throw new Error(`Unexpected analysis write ${path}`);
      return ok(run);
    }
    if (state.readStatus !== 200) return { status: state.readStatus, json: {} };
    if (path.endsWith('/options')) return ok(options());
    if (path.endsWith('/standardizations')) {
      const offset = Number(parsed.searchParams.get('offset') ?? 0);
      return ok({
        runs: runs.slice(offset, offset + 50).map((run) => ({
          ...run,
          allowedActions: standardizationAllowedActions(run, state.canManage),
        })),
        nextOffset: runs.length > offset + 50 ? offset + 50 : null,
      });
    }
    if (path.endsWith(`/evidence/${standardizationEvidenceId}`))
      return ok({
        filename: 'activity.csv',
        format: 'csv',
        sourceText: standardizationCsv,
      });
    if (path.endsWith('/evidence'))
      return ok({ documents: originals, nextOffset: null });
    const run = runs.find((item) => path.endsWith(item.id));
    if (run)
      return ok({
        ...run,
        allowedActions: standardizationAllowedActions(run, state.canManage),
      });
    throw new Error(`Unexpected analysis read ${path}`);
  }
  return { state, originals, runs, createRun, updateRun, options, handle };
}
