import { readdir, readFile } from 'node:fs/promises';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  encryptedGoogleCalendarGrants,
  financeImportFingerprints,
  financeImportPlans,
  financeImportReceipts,
  financeSpecialistRecordReceipts,
  googleOAuthAuthorizationStarts,
  googleOAuthDisconnectOperations,
} from './schema.js';

const metadataUrl = new URL('../drizzle/meta/', import.meta.url);

interface Snapshot {
  readonly id: string;
  readonly prevId: string;
  readonly tables: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

const readJson = async <Value>(url: URL): Promise<Value> =>
  JSON.parse(await readFile(url, 'utf8')) as Value;

const readSnapshot = (index: number): Promise<Snapshot> =>
  readJson(
    new URL(`${index.toString().padStart(4, '0')}_snapshot.json`, metadataUrl),
  );

const tableDelta = (previous: Snapshot, current: Snapshot) => {
  const previousNames = new Set(Object.keys(previous.tables));
  const currentNames = new Set(Object.keys(current.tables));
  return {
    added: [...currentNames].filter((name) => !previousNames.has(name)).sort(),
    changed: [...currentNames]
      .filter(
        (name) =>
          previousNames.has(name) &&
          JSON.stringify(previous.tables[name]) !==
            JSON.stringify(current.tables[name]),
      )
      .sort(),
    removed: [...previousNames]
      .filter((name) => !currentNames.has(name))
      .sort(),
  };
};

const snapshotColumns = (
  snapshot: Snapshot,
  table: string,
): readonly string[] =>
  Object.keys(
    (snapshot.tables[table] as { readonly columns: Record<string, unknown> })
      .columns,
  );

describe('ordered migration snapshot chain', () => {
  it('has one continuous snapshot for every exact journal entry', async () => {
    const [journal, files] = await Promise.all([
      readJson<{
        readonly entries: readonly {
          readonly idx: number;
          readonly tag: string;
        }[];
      }>(new URL('_journal.json', metadataUrl)),
      readdir(metadataUrl),
    ]);
    expect(journal.entries.map(({ idx }) => idx)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21,
    ]);
    expect(journal.entries.map(({ tag }) => tag)).toEqual([
      '0000_household_foundation',
      '0001_identity_onboarding',
      '0002_owner_bootstrap',
      '0003_durable_runtime_repositories',
      '0004_audio_request_receipts',
      '0005_household_administration',
      '0006_sync_conflict_outcomes',
      '0007_experience_notification_preferences',
      '0008_finance_import_receipts',
      '0009_google_oauth_authorization_starts',
      '0010_google_oauth_disconnect_operations',
      '0011_finance_import_retention_runner',
      '0012_google_oauth_disconnect_reconciliation_runner',
      '0013_google_oauth_disconnect_retention_runner',
      '0014_audio_spend_readiness',
      '0015_single_household_session_activation',
      '0016_finance_document_knowledge',
      '0017_approval_resume_public_events',
      '0018_finance_guarded_proposal_authority',
      '0019_manager_turn_spend_warning',
      '0020_manager_specialist_disclosure',
      '0021_blocked_visual_decision_claim',
    ]);
    expect(
      files.filter((file) => /^\d{4}_snapshot\.json$/u.test(file)).sort(),
    ).toEqual(
      Array.from(
        { length: 22 },
        (_, index) => `${index.toString().padStart(4, '0')}_snapshot.json`,
      ),
    );

    const snapshots = await Promise.all(
      Array.from({ length: 22 }, (_, index) => readSnapshot(index)),
    );
    expect(snapshots[0]?.prevId).toBe('00000000-0000-0000-0000-000000000000');
    for (let index = 1; index < snapshots.length; index += 1) {
      expect(snapshots[index]?.prevId).toBe(snapshots[index - 1]?.id);
    }
    expect(tableDelta(snapshots[16]!, snapshots[17]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[17]!, snapshots[18]!)).toEqual({
      added: [],
      changed: ['emdo.action_proposals'],
      removed: [],
    });
    expect(tableDelta(snapshots[18]!, snapshots[19]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[19]!, snapshots[20]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[20]!, snapshots[21]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    for (const snapshot of [snapshots[16]!, snapshots[17]!]) {
      expect(snapshotColumns(snapshot, 'emdo.finance_documents')).toEqual(
        expect.arrayContaining([
          'deletion_proposal_id',
          'deletion_decision_id',
          'deletion_target_binding_hash',
          'deletion_execution_binding_hash',
        ]),
      );
      expect(
        snapshotColumns(snapshot, 'emdo.finance_document_chunks'),
      ).not.toEqual(expect.arrayContaining(['deletion_proposal_id']));
      expect(
        snapshotColumns(snapshot, 'emdo.finance_document_evidence'),
      ).not.toEqual(expect.arrayContaining(['deletion_proposal_id']));
    }
  });

  it('keeps audio, household, sync, and preference structures in their owned boundary', async () => {
    const [
      snapshot2,
      snapshot3,
      snapshot4,
      snapshot5,
      snapshot6,
      snapshot7,
      snapshot8,
      snapshot9,
    ] = await Promise.all([2, 3, 4, 5, 6, 7, 8, 9].map(readSnapshot));

    expect(tableDelta(snapshot2, snapshot3).added).toEqual(
      expect.arrayContaining([
        'emdo.manager_turn_operations',
        'emdo.manager_turns',
      ]),
    );

    expect(tableDelta(snapshot3, snapshot4)).toEqual({
      added: [
        'emdo.audio_request_claim_outcomes',
        'emdo.audio_request_receipt_operations',
        'emdo.audio_request_receipts',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshot4, snapshot5)).toEqual({
      added: [
        'emdo.household_administration_commands',
        'emdo.invitation_delivery_secrets',
        'emdo.invitation_redemption_commands',
      ],
      changed: ['emdo.invitations', 'emdo.worker_operation_outbox'],
      removed: [],
    });
    expect(tableDelta(snapshot5, snapshot6)).toEqual({
      added: ['emdo.sync_api_request_receipts', 'emdo.sync_entity_revisions'],
      changed: ['emdo.sync_operation_receipts'],
      removed: [],
    });
    expect(tableDelta(snapshot6, snapshot7)).toEqual({
      added: [
        'emdo.notification_preference_commands',
        'emdo.notification_preferences',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshot7, snapshot8)).toEqual({
      added: [
        'emdo.finance_import_fingerprints',
        'emdo.finance_import_plans',
        'emdo.finance_import_receipts',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshot8, snapshot9)).toEqual({
      added: ['emdo.google_oauth_authorization_starts'],
      changed: [],
      removed: [],
    });
    const snapshot10 = await readSnapshot(10);
    expect(tableDelta(snapshot9, snapshot10)).toEqual({
      added: ['emdo.google_oauth_disconnect_operations'],
      changed: [],
      removed: [],
    });
    const snapshot11 = await readSnapshot(11);
    expect(tableDelta(snapshot10, snapshot11)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    const snapshot12 = await readSnapshot(12);
    expect(tableDelta(snapshot11, snapshot12)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    const snapshot13 = await readSnapshot(13);
    expect(tableDelta(snapshot12, snapshot13)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    const snapshot14 = await readSnapshot(14);
    expect(tableDelta(snapshot13, snapshot14)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    const snapshot15 = await readSnapshot(15);
    expect(tableDelta(snapshot14, snapshot15)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    const snapshot16 = await readSnapshot(16);
    expect(tableDelta(snapshot15, snapshot16)).toEqual({
      added: [
        'emdo.finance_document_chunks',
        'emdo.finance_document_evidence',
        'emdo.finance_document_extractions',
        'emdo.finance_document_matches',
        'emdo.finance_document_review_batches',
        'emdo.finance_documents',
        'emdo.finance_specialist_record_receipts',
      ],
      changed: [],
      removed: [],
    });
  });

  it('keeps 0008 finance foreign keys and checks fully represented before the additive OAuth snapshot', async () => {
    const [snapshot8, files] = await Promise.all([
      readSnapshot(8),
      readdir(metadataUrl),
    ]);
    const plans = snapshot8.tables['emdo.finance_import_plans'] as {
      readonly indexes: Readonly<Record<string, unknown>>;
      readonly foreignKeys: Readonly<Record<string, unknown>>;
      readonly uniqueConstraints: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    const fingerprints = snapshot8.tables[
      'emdo.finance_import_fingerprints'
    ] as {
      readonly indexes: Readonly<Record<string, unknown>>;
      readonly uniqueConstraints: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    const receipts = snapshot8.tables['emdo.finance_import_receipts'] as {
      readonly indexes: Readonly<Record<string, unknown>>;
      readonly uniqueConstraints: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(plans.foreignKeys).sort()).toEqual([
      'finance_import_plans_household_space_fk',
      'finance_import_plans_owner_membership_fk',
    ]);
    for (const [snapshotTable, schemaTable] of [
      [plans, financeImportPlans],
      [fingerprints, financeImportFingerprints],
      [receipts, financeImportReceipts],
    ] as const) {
      const config = getTableConfig(schemaTable);
      expect(Object.keys(snapshotTable.indexes).sort()).toEqual(
        config.indexes.map((index) => index.config.name).sort(),
      );
      expect(Object.keys(snapshotTable.uniqueConstraints).sort()).toEqual(
        config.uniqueConstraints.map((constraint) => constraint.name).sort(),
      );
    }
    expect(Object.keys(plans.checkConstraints).sort()).toEqual(
      getTableConfig(financeImportPlans)
        .checks.map((check) => check.name)
        .sort(),
    );
    expect(Object.keys(fingerprints.checkConstraints).sort()).toEqual(
      getTableConfig(financeImportFingerprints)
        .checks.map((check) => check.name)
        .sort(),
    );
    expect(Object.keys(receipts.checkConstraints).sort()).toEqual(
      getTableConfig(financeImportReceipts)
        .checks.map((check) => check.name)
        .sort(),
    );
    expect(files).toContain('0009_snapshot.json');
    expect(files).toContain('0010_snapshot.json');
  });

  it('keeps the 0009 OAuth start table exactly aligned with the schema', async () => {
    const snapshot9 = await readSnapshot(9);
    const stored = snapshot9.tables[
      'emdo.google_oauth_authorization_starts'
    ] as {
      readonly indexes: Readonly<Record<string, unknown>>;
      readonly foreignKeys: Readonly<Record<string, unknown>>;
      readonly uniqueConstraints: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    const config = getTableConfig(googleOAuthAuthorizationStarts);

    expect(Object.keys(stored.indexes).sort()).toEqual(
      config.indexes.map((index) => index.config.name).sort(),
    );
    expect(Object.keys(stored.foreignKeys).sort()).toEqual(
      config.foreignKeys.map((key) => key.reference().name).sort(),
    );
    expect(Object.keys(stored.uniqueConstraints).sort()).toEqual(
      config.uniqueConstraints.map((constraint) => constraint.name).sort(),
    );
    expect(Object.keys(stored.checkConstraints).sort()).toEqual(
      config.checks.map((check) => check.name).sort(),
    );
  });

  it('keeps the 0010 OAuth disconnect table exactly aligned with the schema', async () => {
    const snapshot10 = await readSnapshot(10);
    const stored = snapshot10.tables[
      'emdo.google_oauth_disconnect_operations'
    ] as {
      readonly indexes: Readonly<Record<string, unknown>>;
      readonly foreignKeys: Readonly<Record<string, unknown>>;
      readonly uniqueConstraints: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    const config = getTableConfig(googleOAuthDisconnectOperations);

    expect(Object.keys(stored.indexes).sort()).toEqual(
      config.indexes.map((index) => index.config.name).sort(),
    );
    expect(Object.keys(stored.foreignKeys).sort()).toEqual(
      config.foreignKeys.map((key) => key.reference().name).sort(),
    );
    expect(Object.keys(stored.uniqueConstraints).sort()).toEqual(
      config.uniqueConstraints.map((constraint) => constraint.name).sort(),
    );
    expect(Object.keys(stored.checkConstraints).sort()).toEqual(
      config.checks.map((check) => check.name).sort(),
    );
  });

  it('keeps the 0016 Finance specialist receipt snapshot aligned with its narrow durable schema', async () => {
    const snapshot16 = await readSnapshot(16);
    const stored = snapshot16.tables[
      'emdo.finance_specialist_record_receipts'
    ] as {
      readonly indexes: Readonly<Record<string, unknown>>;
      readonly foreignKeys: Readonly<Record<string, unknown>>;
      readonly uniqueConstraints: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    const config = getTableConfig(financeSpecialistRecordReceipts);

    expect(Object.keys(stored.indexes).sort()).toEqual(
      config.indexes.map((index) => index.config.name).sort(),
    );
    expect(Object.keys(stored.foreignKeys).sort()).toEqual(
      config.foreignKeys.map((key) => key.reference().name).sort(),
    );
    expect(Object.keys(stored.uniqueConstraints).sort()).toEqual(
      config.uniqueConstraints.map((constraint) => constraint.name).sort(),
    );
    expect(Object.keys(stored.checkConstraints).sort()).toEqual(
      config.checks.map((check) => check.name).sort(),
    );
  });

  it('keeps the encrypted Calendar grant checks aligned from their 0003 owner onward', async () => {
    const expectedChecks = getTableConfig(encryptedGoogleCalendarGrants)
      .checks.map((check) => check.name)
      .sort();
    for (let index = 3; index <= 9; index += 1) {
      const snapshot = await readSnapshot(index);
      const stored = snapshot.tables[
        'emdo.encrypted_google_calendar_grants'
      ] as {
        readonly checkConstraints: Readonly<Record<string, unknown>>;
      };
      expect(Object.keys(stored.checkConstraints).sort()).toEqual(
        expectedChecks,
      );
    }
  });
});
