import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planLegacyFinanceMigration } from '@emdo/domains/finance';
import {
  FinanceLegacyMigrationInspectionSchema,
  type FinanceLegacyMigrationMapping,
} from '@emdo/contracts/browser';
import { FinanceLegacyMigrations } from './finance-legacy-migrations.js';
const auth = {
  sessionBinding: 'current',
  csrfToken: 'current-csrf' as string | undefined,
};
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bookId = id(1),
  migrationId = id(2),
  accountId = id(3),
  ledgerId = id(4),
  evidenceId = id(5),
  recordId = id(6),
  userId = id(7),
  workspaceId = id(8),
  sourceSpaceId = id(9);
const source = {
  householdId: workspaceId,
  privateSpaceId: sourceSpaceId,
  originalOwnerUserId: userId,
};
const emptyMapping: FinanceLegacyMigrationMapping = {
  source,
  target: { workspaceId, bookId, ownerUserId: userId },
  financialAccounts: [],
  categories: [],
  evidence: [],
  openings: [],
};
const date = '2026-09-14T00:00:00.000Z';
function snapshot(
  mapping = emptyMapping,
  revision = 1,
  status?: string,
  opening = 0,
) {
  const sourceRecord = {
    source,
    entityType: 'finance.account' as const,
    entityId: 'legacy-bank',
    legacyRowId: id(10),
    revision: 1,
    tombstoned: false,
    createdAt: date,
    updatedAt: date,
    payload: {
      schemaVersion: 1,
      id: 'legacy-bank',
      spaceId: sourceSpaceId,
      ownerUserId: userId,
      recordType: 'account',
      source: 'manual',
      name: 'Legacy bank',
      accountKind: 'chequing',
      currency: 'CAD',
      openingBalanceCadMinor: opening,
      active: true,
      createdAt: date,
      updatedAt: date,
    },
    payloadHash: 'a'.repeat(64),
    provenance: null,
  };
  const plan = planLegacyFinanceMigration({
    schemaVersion: 1,
    mapping,
    sourceRecords: [sourceRecord],
    stableTargetIds: [
      {
        entityType: 'finance.account',
        entityId: 'legacy-bank',
        targetRecordId: id(11),
        targetBatchId: null,
        targetRowId: null,
      },
    ],
  });
  const candidate = plan.candidates[0]!;
  return FinanceLegacyMigrationInspectionSchema.parse({
    run: {
      id: migrationId,
      mapping,
      status: status ?? (plan.status === 'ready' ? 'review' : 'blocked'),
      revision,
      sourceSnapshotHash: plan.sourceSnapshotHash,
      mappingHash: plan.mappingHash,
      sourceCount: plan.counts.source,
      readyCount: plan.counts.ready,
      blockedCount: plan.counts.blocked,
      backfilledCount: 0,
      unresolvedCount: plan.counts.unresolved,
      createdBy: userId,
      createdAt: date,
      updatedAt: date,
    },
    plan,
    records: [
      {
        ...candidate,
        id: recordId,
        migrationId,
        workspaceId,
        bookId,
        source,
        legacyRowId: sourceRecord.legacyRowId,
        tombstoned: false,
        payload: sourceRecord.payload,
        payloadHash: sourceRecord.payloadHash,
        provenance: null,
        backfillState: 'pending',
        backfilledAt: null,
        revision,
        createdAt: date,
        updatedAt: date,
      },
    ],
  });
}
function fixture(openingAmount = 0) {
  let current = snapshot(emptyMapping, 1, undefined, openingAmount);
  let inspected = false;
  const posts: { path: string; body: Record<string, any>; headers: Headers }[] =
    [];
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, any>)
      : undefined;
    if (body) posts.push({ path, body, headers: new Headers(init?.headers) });
    let response: unknown;
    if (path.endsWith('/legacy-migrations/sources'))
      response = { sources: [{ name: 'My private Finance', source }] };
    else if (path.endsWith('/financial-accounts'))
      response = {
        accounts: [
          { id: accountId, name: 'Book bank', active: true, currency: 'CAD' },
        ],
      };
    else if (path.includes('/evidence?'))
      response = {
        documents: [
          {
            id: evidenceId,
            filename: 'Reviewed statement.pdf',
            sourceDigest: 'b'.repeat(64),
          },
        ],
        nextOffset: null,
      };
    else if (path.endsWith('/legacy-migrations'))
      response = { runs: inspected ? [current.run] : [] };
    else if (path.endsWith('/inspect')) {
      inspected = true;
      response = current;
    } else if (path.endsWith('/review')) {
      const decision = body!.decision;
      const mapping = {
        ...emptyMapping,
        financialAccounts: [
          {
            legacyAccountId: 'legacy-bank',
            targetFinancialAccountId: decision.targetFinancialAccountId,
          },
        ],
        evidence: decision.targetEvidenceId
          ? [
              {
                legacyEntityId: 'legacy-bank',
                targetEvidenceId: decision.targetEvidenceId,
              },
            ]
          : [],
        openings: [
          {
            legacyAccountId: 'legacy-bank',
            disposition: decision.openingDisposition,
            targetLedgerAccountId: decision.openingLedgerAccountId,
            targetEvidenceId: decision.openingEvidenceId,
            openingEffectiveOn: decision.openingEffectiveOn,
          },
        ],
      };
      current = snapshot(
        mapping,
        current.run.revision + 1,
        undefined,
        openingAmount,
      );
      response = {
        ...current,
        review: {
          id: id(12),
          migrationId,
          recordId,
          revision: current.run.revision,
          decision,
          previousState: {},
          reviewedBy: userId,
          createdAt: date,
        },
      };
    } else if (path.endsWith('/backfill')) {
      current = snapshot(
        current.run.mapping,
        current.run.revision + 1,
        'backfilled',
        openingAmount,
      );
      response = {
        migrationId,
        status: 'backfilled',
        targetBatchIds: [],
        targetRowIds: [],
        backfilledCount: 1,
        preservedCount: 0,
        sourceSnapshotHash: current.run.sourceSnapshotHash,
        replayed: false,
      };
    } else if (path.endsWith('/compare')) {
      current = snapshot(
        current.run.mapping,
        current.run.revision + 1,
        'comparison-passed',
        openingAmount,
      );
      response = {
        id: id(13),
        migrationId,
        sourceSnapshotHash: current.run.sourceSnapshotHash,
        targetSnapshotHash: 'c'.repeat(64),
        status: 'passed',
        sourceTransactionCount: 0,
        targetTransactionCount: 0,
        sourceCadMinorTotal: '0',
        targetCadDecimalTotal: '0',
        unresolvedCount: 0,
        mismatches: [],
        createdBy: userId,
        createdAt: date,
      };
    } else if (path.endsWith('/approve-cutover')) {
      current = snapshot(
        current.run.mapping,
        current.run.revision + 1,
        'cutover-approved',
        openingAmount,
      );
      response = {
        id: id(14),
        migrationId,
        source,
        target: emptyMapping.target,
        comparisonId: id(13),
        status: 'approved',
        approvedBy: userId,
        approvedAt: date,
      };
    } else if (path.endsWith('/opening'))
      response = {
        id: id(15),
        workspaceId,
        bookId,
        financialAccountId: accountId,
        sourceSpaceId,
        sourceOwnerUserId: userId,
        sourceKind: 'legacy-migration',
        migrationId,
        sourceRecordId: recordId,
        sourceRevision: 1,
        sourceSnapshotHash: current.run.sourceSnapshotHash,
        reviewId: id(12),
        evidenceId,
        evidenceDigest: 'b'.repeat(64),
        effectiveOn: '2026-08-01',
        amountCadMinor: String(openingAmount),
        ledgerAccountId: id(16),
        counterpartLedgerAccountId: ledgerId,
        journalId: id(17),
        postedBy: userId,
        postedAt: date,
        supersedesProofId: null,
      };
    else if (path.endsWith(`/${migrationId}`)) response = current;
    else throw new Error(`Unexpected path: ${path}`);
    return new Response(JSON.stringify(response), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  return {
    posts,
    fetcher,
    get current() {
      return current;
    },
  };
}
const props = {
  bookId,
  bookName: 'Personal book',
  role: 'administrator',
  accounts: [{ id: ledgerId, code: '3000', name: 'Opening equity' }],
};
async function inspectAndSelect() {
  await screen.findByRole('option', { name: 'My private Finance' });
  fireEvent.change(screen.getByLabelText('Private Finance source'), {
    target: { value: sourceSpaceId },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect selected source' }),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Review Legacy bank' }),
  );
  fireEvent.change(screen.getByLabelText('Target financial account'), {
    target: { value: accountId },
  });
  fireEvent.change(screen.getByLabelText('Review reason'), {
    target: { value: 'Checked against original bank statement' },
  });
  fireEvent.click(
    screen.getByLabelText(
      'I checked the source classification and selected mappings.',
    ),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  auth.sessionBinding = 'current';
  auth.csrfToken = 'current-csrf';
});
describe('Legacy Finance migration review panel', () => {
  it('completes inspect, review, backfill, comparison and separate approval with saved revisions', async () => {
    const fixtureState = fixture();
    render(
      <StrictMode>
        <FinanceLegacyMigrations {...props} />
      </StrictMode>,
    );
    await inspectAndSelect();
    fireEvent.click(screen.getByRole('button', { name: 'Save record review' }));
    await screen.findByText(
      'Review saved. Recheck remaining blockers before backfill.',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Backfill reviewed records' }),
    );
    await screen.findByText(
      'Backfill saved. Compare the source and target records next.',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Compare source and target' }),
    );
    await screen.findByText('Saved comparison: passed');
    expect(
      screen.getByRole('button', { name: 'Approve cutover' }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(
        'I reviewed the saved comparison and approve this migration cutover.',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve cutover' }));
    await screen.findByText(
      'Cutover approval saved. Reader activation remains a separate controlled step.',
    );
    expect(
      fixtureState.posts.map((post) => post.path.split('/').at(-1)),
    ).toEqual(['inspect', 'review', 'backfill', 'compare', 'approve-cutover']);
    expect(fixtureState.posts[0]!.body.mapping).toEqual(emptyMapping);
    expect(fixtureState.posts[1]!.body.expectedRevision).toBe(1);
    expect(fixtureState.posts[2]!.body.expectedRevision).toBe(2);
    expect(fixtureState.posts[3]!.body.expectedRevision).toBe(3);
    expect(fixtureState.posts[4]!.body.expectedRevision).toBe(4);
    for (const post of fixtureState.posts) {
      expect(post.headers.get('x-csrf-token')).toBe('current-csrf');
      if ('idempotencyKey' in post.body)
        expect(post.body.idempotencyKey).toBe(
          post.headers.get('idempotency-key'),
        );
    }
    expect(
      screen.queryByRole('button', { name: /activate/i }),
    ).not.toBeInTheDocument();
  });
  it('reviews an opening date and evidence, then posts using saved revisions with no client amount or date', async () => {
    const fixtureState = fixture(12500);
    render(<FinanceLegacyMigrations {...props} />);
    await inspectAndSelect();
    fireEvent.change(screen.getByLabelText('Opening balance handling'), {
      target: { value: 'explicit-opening' },
    });
    fireEvent.change(
      screen.getByLabelText('Opening counterpart ledger account'),
      { target: { value: ledgerId } },
    );
    fireEvent.change(screen.getByLabelText('Opening evidence document'), {
      target: { value: evidenceId },
    });
    fireEvent.change(screen.getByLabelText('Reviewed opening effective date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save record review' }));
    await screen.findByText(
      'Review saved. Recheck remaining blockers before backfill.',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Post reviewed opening' }),
    );
    await screen.findByText(/Posted opening: CAD 125.00/);
    expect(
      fixtureState.posts.find((post) => post.path.endsWith('/review'))!.body
        .decision,
    ).toMatchObject({
      openingEffectiveOn: '2026-08-01',
      openingEvidenceId: evidenceId,
      openingLedgerAccountId: ledgerId,
      classificationConfirmed: true,
    });
    expect(Object.keys(fixtureState.posts.at(-1)!.body).sort()).toEqual([
      'expectedRecordRevision',
      'expectedRunRevision',
      'expectedSourceSnapshotHash',
      'idempotencyKey',
    ]);
    expect(fixtureState.posts.at(-1)!.body.expectedRunRevision).toBe(2);
  });
  it('permits read-only catalog access but disables migration commands for viewers', async () => {
    fixture();
    render(<FinanceLegacyMigrations {...props} role="viewer" />);
    await screen.findByRole('option', { name: 'My private Finance' });
    expect(
      screen.getByRole('button', { name: 'Inspect selected source' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Private Finance source')).toBeDisabled();
  });
  it('clears private migration content when the authenticated session changes', async () => {
    const state = fixture();
    const view = render(<FinanceLegacyMigrations {...props} />);
    await inspectAndSelect();
    auth.sessionBinding = 'replacement';
    state.fetcher.mockImplementation(
      async () => new Response('{}', { status: 403 }),
    );
    view.rerender(<FinanceLegacyMigrations {...props} />);
    await screen.findByRole('alert');
    expect(screen.queryByText('Review: Legacy bank')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save record review' }),
    ).not.toBeInTheDocument();
  });
});
