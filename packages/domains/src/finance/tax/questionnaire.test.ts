import { describe, expect, it } from 'vitest';
import type {
  FinanceTaxIntake,
  FinanceTaxPackageManifest,
} from '@emdo/contracts';
import {
  FinanceTaxPackageRegistry,
  FINANCE_TAX_PACKAGE_REGISTRY,
} from './index.js';
import {
  createFinanceTaxQuestionnaire,
  saveFinanceTaxQuestionnaireAnswer,
  reviewFinanceTaxQuestionnaireAnswer,
  assessFinanceTaxQuestionnaire,
  withdrawFinanceTaxQuestionnaireAnswer,
} from './questionnaire.js';

const id = (suffix: number) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const digest = 'a'.repeat(64),
  timestamp = '2026-09-14T00:00:00Z';
const identity = { caseId: id(1), workspaceId: id(2), taxSubjectId: id(3) };
const source = {
  kind: 'declaration' as const,
  reference: 'private-declaration',
  revision: 1,
  contentHash: digest,
};
const intake: FinanceTaxIntake = {
  schemaVersion: 1,
  ...identity,
  legalEntityId: null,
  sourceBooks: [],
  revision: 1,
  scope: {
    country: 'CA',
    subdivision: 'CA-ON',
    taxpayerType: 'individual',
    year: 2025,
    regime: 'questionnaire-fixture',
    formVersion: 'fixture-1',
  },
  domesticResident: true,
  hasCrossBorderActivity: false,
  standaloneCorporation: null,
  requestedFeatures: ['income-tax-return'],
  facts: [],
};
const requiredFacts = [
  { key: 'residencyConfirmed', type: 'boolean' as const },
  { key: 'hasDependant', type: 'boolean' as const },
  {
    key: 'dependantName',
    type: 'text' as const,
    when: { factKey: 'hasDependant', equals: true },
  },
  { key: 'electionChosen', type: 'boolean' as const },
  { key: 'priorBalance', type: 'decimal' as const },
];
const manifest: FinanceTaxPackageManifest = {
  packageId: 'questionnaire-fixture',
  version: '1',
  scope: intake.scope as FinanceTaxPackageManifest['scope'],
  engineVersion: 'fixture-engine-1',
  implementationHash: digest,
  coverage: 'full-return',
  references: [
    {
      id: 'fixture-source',
      authority: 'Synthetic source fixture',
      url: 'https://www.canada.ca/en/revenue-agency.html',
      title: 'Synthetic source fixture; not statutory coverage',
      retrievedAt: timestamp,
      documentHash: digest,
      locator: 'fixture-only',
    },
  ],
  rules: [{ id: 'fixture-rule', referenceIds: ['fixture-source'] }],
  requiredFacts,
  forms: [
    {
      id: 'fixture-form',
      version: 'fixture-1',
      referenceIds: ['fixture-source'],
      fields: [{ key: 'balance', type: 'decimal', ruleIds: ['fixture-rule'] }],
    },
  ],
  validation: {
    reviewedBy: 'fixture',
    reviewedAt: timestamp,
    fullReturnCoverageAttested: true,
    reportHash: digest,
    fixtureIds: ['fixture'],
  },
};
const fact = (key: string, value: string | boolean) => ({
  key,
  value:
    typeof value === 'boolean'
      ? { type: 'boolean' as const, value }
      : key === 'priorBalance'
        ? { type: 'decimal' as const, value }
        : { type: 'text' as const, value },
  reviewState: 'reviewed' as const,
  source,
});
const baselineFacts = [
  fact('residencyConfirmed', true),
  fact('hasDependant', false),
  fact('electionChosen', false),
  fact('priorBalance', '0'),
];
const access = {
  ...identity,
  actorId: id(4),
  bookAuthorizations: [],
  availableSources: [source],
};
const createRequest = {
  intake,
  packageId: manifest.packageId,
  packageVersion: manifest.version,
  questionMetadata: [
    {
      factKey: 'residencyConfirmed',
      category: 'residency',
      label: 'Residency confirmation',
    },
    {
      factKey: 'hasDependant',
      category: 'dependants',
      label: 'Dependent applicability',
    },
    {
      factKey: 'dependantName',
      category: 'dependants',
      label: 'Dependent name',
    },
    {
      factKey: 'electionChosen',
      category: 'elections',
      label: 'Election decision',
    },
    {
      factKey: 'priorBalance',
      category: 'prior-balances',
      label: 'Prior balance',
    },
  ],
  relatedParties: [
    {
      id: id(5),
      relationship: 'dependant',
      displayName: 'Private dependent fixture',
    },
  ],
};
async function registry() {
  return FinanceTaxPackageRegistry.empty().register({
    manifest,
    evaluate: (value) => ({
      forms: [
        {
          id: 'fixture-form',
          version: 'fixture-1',
          fields: [
            {
              key: 'balance',
              value: structuredClone(
                value.facts.find((entry) => entry.key === 'priorBalance')!
                  .value,
              ),
              ruleIds: ['fixture-rule'],
              sourceFactKeys: ['priorBalance'],
            },
          ],
        },
      ],
      issues: [],
    }),
    fixtures: [
      {
        id: 'fixture',
        intake: { ...intake, facts: baselineFacts },
        expected: {
          forms: [
            {
              id: 'fixture-form',
              version: 'fixture-1',
              fields: [
                {
                  key: 'balance',
                  value: { type: 'decimal', value: '0' },
                  ruleIds: ['fixture-rule'],
                  sourceFactKeys: ['priorBalance'],
                },
              ],
            },
          ],
          issues: [],
        },
      },
    ],
  });
}
type State = Awaited<ReturnType<typeof createFinanceTaxQuestionnaire>>;
async function save(
  state: State,
  entry: ReturnType<typeof fact>,
  overrides = {},
) {
  return saveFinanceTaxQuestionnaireAnswer(
    state,
    {
      ...identity,
      expectedCaseRevision: state.intake.revision,
      expectedAnswerRevision:
        state.answers.find((answer) => answer.fact.key === entry.key)
          ?.revision ?? null,
      fact: entry,
      relatedPartyId: entry.key === 'dependantName' ? id(5) : null,
      updatedAt: timestamp,
      ...overrides,
    },
    access,
  );
}
async function review(state: State, key: string) {
  return reviewFinanceTaxQuestionnaireAnswer(
    state,
    {
      ...identity,
      expectedCaseRevision: state.intake.revision,
      expectedAnswerRevision: state.answers.find(
        (answer) => answer.fact.key === key,
      )!.revision,
      factKey: key,
      decision: 'reviewed',
      reviewedAt: timestamp,
    },
    access,
  );
}
async function answered() {
  const instance = await registry();
  let state = await createFinanceTaxQuestionnaire(
    createRequest,
    access,
    instance,
  );
  for (const entry of baselineFacts)
    state = await review(await save(state, entry), entry.key);
  return { state, instance };
}

describe('private tax questionnaire orchestration', () => {
  it('derives requirements only from the immutable selected package and needs no personal ledger', async () => {
    const instance = await registry();
    const state = await createFinanceTaxQuestionnaire(
      createRequest,
      access,
      instance,
    );
    expect(state.visibility).toBe('private');
    expect(state.intake.legalEntityId).toBeNull();
    expect(state.intake.sourceBooks).toEqual([]);
    expect(state.binding.manifest?.forms[0]?.version).toBe('fixture-1');
    expect(state.binding.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state.questions.map((question) => question.category)).toEqual([
      'residency',
      'dependants',
      'dependants',
      'elections',
      'prior-balances',
    ]);
    const result = await assessFinanceTaxQuestionnaire(state, access, instance);
    expect(result.status).toBe('incomplete');
    expect(result.issues.some((issue) => issue.code === 'missing-fact')).toBe(
      true,
    );
    await expect(
      createFinanceTaxQuestionnaire(
        {
          ...createRequest,
          questionMetadata: [
            ...createRequest.questionMetadata,
            {
              factKey: 'inventedRequirement',
              category: 'general',
              label: 'Invented',
            },
          ],
        },
        access,
        instance,
      ),
    ).rejects.toThrow('metadata-not-in-package');
  });
  it('keeps every production country unavailable without inventing a questionnaire', async () => {
    for (const country of ['CA', 'US', 'MX', 'DE', 'KR', 'JP', 'FR']) {
      const state = await createFinanceTaxQuestionnaire(
        {
          ...createRequest,
          intake: { ...intake, scope: { ...intake.scope, country } },
          questionMetadata: [],
        },
        access,
        FINANCE_TAX_PACKAGE_REGISTRY,
      );
      const result = await assessFinanceTaxQuestionnaire(
        state,
        access,
        FINANCE_TAX_PACKAGE_REGISTRY,
      );
      expect(result.status).toBe('incomplete');
      expect(result.complete).toBe(false);
      expect(result.issues[0]?.code).toBe('package-unavailable');
      expect(result.intake).toBeNull();
    }
  });
  it('requires explicit reviewed zeros and elections before producing canonical intake for actual evaluation', async () => {
    const { state, instance } = await answered();
    const result = await assessFinanceTaxQuestionnaire(state, access, instance);
    expect(result.status).toBe('ready-for-calculation');
    expect(result.complete).toBe(false);
    expect(
      result.intake?.facts.find((entry) => entry.key === 'priorBalance')?.value
        .value,
    ).toBe('0');
    expect(
      result.questions.find((question) => question.factKey === 'dependantName'),
    ).toMatchObject({ applicability: 'not-applicable' });
    const run = await instance.run({
      runId: id(10),
      createdAt: timestamp,
      packageId: manifest.packageId,
      packageVersion: manifest.version,
      intake: result.intake,
    });
    expect(run.status).toBe('complete'); // Synthetic evaluator only; the questionnaire itself never claims completion.
  });
  it('new answers cannot self-approve and changed prior balances invalidate their review without rewriting history', async () => {
    const { state, instance } = await answered();
    const updated = await save(state, fact('priorBalance', '100'));
    expect(updated.intake.revision).toBe(state.intake.revision + 1);
    expect(
      updated.answers.find((answer) => answer.fact.key === 'priorBalance'),
    ).toMatchObject({ fact: { reviewState: 'unreviewed' }, review: null });
    expect(
      updated.answers.find((answer) => answer.fact.key === 'priorBalance')
        ?.previousRevisionHash,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      state.answers.find((answer) => answer.fact.key === 'priorBalance')?.fact
        .value.value,
    ).toBe('0');
    expect(
      (await assessFinanceTaxQuestionnaire(updated, access, instance)).status,
    ).toBe('incomplete');
    expect(
      (
        await assessFinanceTaxQuestionnaire(
          await review(updated, 'priorBalance'),
          access,
          instance,
        )
      ).status,
    ).toBe('ready-for-calculation');
  });
  it('blocks stale case/answer revisions and reopens conditional dependent requirements after an election change', async () => {
    const { state, instance } = await answered();
    await expect(
      save(state, fact('priorBalance', '100'), { expectedCaseRevision: 1 }),
    ).rejects.toThrow('case-revision-conflict');
    await expect(
      save(state, fact('priorBalance', '100'), { expectedAnswerRevision: 999 }),
    ).rejects.toThrow('answer-revision-conflict');
    const changed = await review(
      await save(state, fact('hasDependant', true)),
      'hasDependant',
    );
    const result = await assessFinanceTaxQuestionnaire(
      changed,
      access,
      instance,
    );
    expect(result.status).toBe('incomplete');
    expect(
      result.issues.some((issue) => issue.path === 'facts.dependantName'),
    ).toBe(true);
    expect(
      (
        await assessFinanceTaxQuestionnaire(
          await review(
            await save(changed, fact('dependantName', 'Fixture')),
            'dependantName',
          ),
          access,
          instance,
        )
      ).status,
    ).toBe('ready-for-calculation');
  });
  it('withdraws a now-inapplicable answer without erasing history or resetting its revision on re-entry', async () => {
    const { state, instance } = await answered();
    let withDependent = await review(
      await save(state, fact('hasDependant', true)),
      'hasDependant',
    );
    withDependent = await review(
      await save(withDependent, fact('dependantName', 'Fixture')),
      'dependantName',
    );
    const withoutDependent = await review(
      await save(withDependent, fact('hasDependant', false)),
      'hasDependant',
    );
    expect(
      (await assessFinanceTaxQuestionnaire(withoutDependent, access, instance))
        .status,
    ).toBe('incomplete');
    const previous = withoutDependent.answers.find(
      (answer) => answer.fact.key === 'dependantName',
    )!;
    const withdrawn = await withdrawFinanceTaxQuestionnaireAnswer(
      withoutDependent,
      {
        ...identity,
        expectedCaseRevision: withoutDependent.intake.revision,
        factKey: 'dependantName',
        expectedAnswerRevision: previous.revision,
        withdrawnAt: timestamp,
      },
      access,
    );
    expect(
      (await assessFinanceTaxQuestionnaire(withdrawn, access, instance)).status,
    ).toBe('ready-for-calculation');
    expect(withdrawn.withdrawnAnswers[0]?.answer).toEqual(previous);
    expect(Object.isFrozen(withdrawn.withdrawnAnswers[0]?.answer)).toBe(true);
    const reentered = await save(
      withdrawn,
      fact('dependantName', 'New fixture'),
      { expectedAnswerRevision: previous.revision },
    );
    expect(
      reentered.answers.find((answer) => answer.fact.key === 'dependantName')
        ?.revision,
    ).toBe(previous.revision + 1);
    expect(
      reentered.answers.find((answer) => answer.fact.key === 'dependantName')
        ?.fact.reviewState,
    ).toBe('unreviewed');
  });
  it('rejects cross-taxpayer or cross-case facts despite sharing a workspace', async () => {
    const { state, instance } = await answered();
    await expect(
      save(state, fact('priorBalance', '1'), { taxSubjectId: id(999) }),
    ).rejects.toThrow('identity-mismatch');
    await expect(
      createFinanceTaxQuestionnaire(
        createRequest,
        { ...access, taxSubjectId: id(999) },
        instance,
      ),
    ).rejects.toThrow('identity-mismatch');
    const copied = structuredClone(state) as unknown as {
      answers: { taxSubjectId: string }[];
    };
    copied.answers[0]!.taxSubjectId = id(999);
    expect(
      (await assessFinanceTaxQuestionnaire(copied, access, instance)).issues[0]
        ?.code,
    ).toContain('identity-mismatch');
    expect(
      (
        await assessFinanceTaxQuestionnaire(
          state,
          { ...access, caseId: id(999) },
          instance,
        )
      ).status,
    ).toBe('incomplete');
  });
  it('pins exact authorized book snapshots and rejects changed authorization revisions, new snapshots or implicit workspace access', async () => {
    const instance = await registry();
    const book = { bookId: id(30), snapshotRevision: 4, snapshotHash: digest };
    const authorization = {
      ...book,
      authorizationId: id(31),
      authorizationRevision: 2,
    };
    const authorized = { ...access, bookAuthorizations: [authorization] };
    const request = {
      ...createRequest,
      intake: { ...intake, sourceBooks: [book] },
    };
    await expect(
      createFinanceTaxQuestionnaire(request, access, instance),
    ).rejects.toThrow('authorization-changed');
    const state = await createFinanceTaxQuestionnaire(
      request,
      authorized,
      instance,
    );
    for (const patch of [
      { authorizationRevision: 3 },
      { snapshotRevision: 5 },
      { snapshotHash: 'b'.repeat(64) },
    ]) {
      const result = await assessFinanceTaxQuestionnaire(
        state,
        { ...authorized, bookAuthorizations: [{ ...authorization, ...patch }] },
        instance,
      );
      expect(result.issues[0]?.code).toContain('authorization-changed');
    }
  });
  it('blocks source evidence changes even when a previously reviewed fact value is unchanged', async () => {
    const { state, instance } = await answered();
    const currentAccess = {
      ...access,
      availableSources: [{ ...source, revision: 2 }],
    };
    expect(
      (await assessFinanceTaxQuestionnaire(state, currentAccess, instance))
        .issues[0]?.code,
    ).toContain('source-revision-unavailable');
  });
  it('detects changed rule/form binding rather than silently adopting a package or year', async () => {
    const { state, instance } = await answered();
    const copied = JSON.parse(JSON.stringify(state));
    copied.binding.manifest.forms[0].version = 'fixture-2';
    expect(
      (await assessFinanceTaxQuestionnaire(copied, access, instance)).issues[0]
        ?.code,
    ).toContain('package-binding-changed');
    copied.binding.scope.year = 2026;
    expect(
      (await assessFinanceTaxQuestionnaire(copied, access, instance)).issues[0]
        ?.code,
    ).toContain('scope-binding-changed');
    await expect(
      createFinanceTaxQuestionnaire(
        {
          ...createRequest,
          intake: { ...intake, scope: { ...intake.scope, year: 2026 } },
        },
        access,
        instance,
      ),
    ).rejects.toThrow('package-scope-mismatch');
    expect(Object.isFrozen(state.binding.manifest?.forms)).toBe(true);
  });
});
