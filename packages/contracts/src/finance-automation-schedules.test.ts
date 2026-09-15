import { describe, expect, it } from 'vitest';
import { FinanceAutomationScheduleDefinitionSchema } from './finance-automation-schedules.js';

const id = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
const base = {
  workspaceId: id,
  bookId: id,
  grantId: id,
  grantRevision: 1,
  targets: [id],
  money: { currency: 'CAD' as const, amount: '0' },
  startAt: '2026-09-01T00:00:00Z',
  endAt: null,
  cadence: {
    kind: 'interval' as const,
    everySeconds: 3600,
    timeZone: 'UTC',
    clock: 'elapsed-utc' as const,
  },
  misfire: { policy: 'skip' as const, graceSeconds: 60 },
  concurrency: { policy: 'forbid' as const, onBusy: 'defer' as const },
};

const budgetPlanning = {
  schemaVersion: 1 as const,
  capability: 'finance.planning.budget-vs-actuals' as const,
  budgetId: id,
  budgetRevision: 2,
  asOf: null,
  currency: 'CAD' as const,
  itemCount: 3,
};

describe('Finance automation schedule planning intent', () => {
  it('keeps planning as a capability sibling and binds its target/currency/amount', () => {
    const schedule = FinanceAutomationScheduleDefinitionSchema.parse({
      ...base,
      capability: budgetPlanning.capability,
      planning: budgetPlanning,
    });
    expect(schedule.planning).toEqual(budgetPlanning);
  });

  it('rejects a planning schedule that changes target, amount, or currency', () => {
    for (const change of [
      { targets: ['018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71'] },
      { money: { currency: 'CAD' as const, amount: '1' } },
      { money: { currency: 'USD' as const, amount: '0' } },
    ]) {
      expect(() =>
        FinanceAutomationScheduleDefinitionSchema.parse({
          ...base,
          capability: budgetPlanning.capability,
          planning: budgetPlanning,
          ...change,
        }),
      ).toThrow();
    }
  });

  it('rejects a nonplanning schedule carrying planning intent', () => {
    expect(() =>
      FinanceAutomationScheduleDefinitionSchema.parse({
        ...base,
        capability: 'finance.reports.generate',
        planning: budgetPlanning,
      }),
    ).toThrow();
  });
});

const extraction = {
  schemaVersion: 1,
  evidenceId: id,
  expectedSourceDigest: 'a'.repeat(64),
  standardizationRunId: id,
  expectedRunRevision: 1,
  expectedExtractionRevision: 0,
};
const journal = {
  schemaVersion: 1,
  batchId: id,
  expectedBatchRevision: 2,
  expectedSnapshotHash: 'b'.repeat(64),
};

describe('Pinned recurring source intents', () => {
  it('preserves the reviewed extraction and journal source without following latest', () => {
    expect(
      FinanceAutomationScheduleDefinitionSchema.parse({
        ...base,
        capability: 'finance.documents.extract',
        extraction,
      }).extraction,
    ).toEqual(extraction);
    expect(
      FinanceAutomationScheduleDefinitionSchema.parse({
        ...base,
        capability: 'finance.journals.draft',
        journal,
        money: { currency: 'CAD', amount: '123.45' },
      }).journal,
    ).toEqual(journal);
  });
  it('requires an exclusive source intent and exact target', () => {
    for (const fields of [
      { capability: 'finance.documents.extract' },
      { capability: 'finance.journals.draft' },
      { capability: 'finance.documents.extract', extraction, journal },
      { capability: 'finance.reports.generate', extraction },
      {
        capability: 'finance.journals.draft',
        journal,
        planning: budgetPlanning,
      },
      {
        capability: 'finance.documents.extract',
        extraction,
        targets: [id, '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71'],
      },
      {
        capability: 'finance.journals.draft',
        journal,
        targets: ['018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71'],
      },
      {
        capability: 'finance.documents.extract',
        extraction,
        money: { currency: 'CAD', amount: '1' },
      },
      {
        capability: 'finance.journals.draft',
        journal: { ...journal, followLatest: true },
      },
    ])
      expect(
        FinanceAutomationScheduleDefinitionSchema.safeParse({
          ...base,
          ...fields,
        }).success,
      ).toBe(false);
  });
});
