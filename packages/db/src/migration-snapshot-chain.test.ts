import { readdir, readFile } from 'node:fs/promises';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  financeImportFingerprints,
  financeImportPlans,
  financeImportReceipts,
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
      0, 1, 2, 3, 4, 5, 6, 7, 8,
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
    ]);
    expect(
      files.filter((file) => /^\d{4}_snapshot\.json$/u.test(file)).sort(),
    ).toEqual(
      Array.from(
        { length: 9 },
        (_, index) => `${index.toString().padStart(4, '0')}_snapshot.json`,
      ),
    );

    const snapshots = await Promise.all(
      Array.from({ length: 9 }, (_, index) => readSnapshot(index)),
    );
    expect(snapshots[0]?.prevId).toBe('00000000-0000-0000-0000-000000000000');
    for (let index = 1; index < snapshots.length; index += 1) {
      expect(snapshots[index]?.prevId).toBe(snapshots[index - 1]?.id);
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
    ] = await Promise.all([2, 3, 4, 5, 6, 7, 8].map(readSnapshot));

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
  });

  it('keeps 0008 finance foreign keys and checks fully represented without a synthetic follow-up snapshot', async () => {
    const [snapshot8, files] = await Promise.all([
      readSnapshot(8),
      readdir(metadataUrl),
    ]);
    const plans = snapshot8.tables['emdo.finance_import_plans'] as {
      readonly foreignKeys: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    const receipts = snapshot8.tables['emdo.finance_import_receipts'] as {
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(plans.foreignKeys).sort()).toEqual([
      'finance_import_plans_household_space_fk',
      'finance_import_plans_owner_membership_fk',
    ]);
    const fingerprintChecks = (
      snapshot8.tables['emdo.finance_import_fingerprints'] as {
        readonly checkConstraints: Readonly<Record<string, unknown>>;
      }
    ).checkConstraints;
    expect(Object.keys(plans.checkConstraints).sort()).toEqual(
      getTableConfig(financeImportPlans)
        .checks.map((check) => check.name)
        .sort(),
    );
    expect(Object.keys(fingerprintChecks).sort()).toEqual(
      getTableConfig(financeImportFingerprints)
        .checks.map((check) => check.name)
        .sort(),
    );
    expect(Object.keys(receipts.checkConstraints).sort()).toEqual(
      getTableConfig(financeImportReceipts)
        .checks.map((check) => check.name)
        .sort(),
    );
    expect(files).not.toContain('0009_snapshot.json');
  });
});
