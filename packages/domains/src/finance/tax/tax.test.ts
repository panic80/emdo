import { describe, expect, it } from 'vitest';
import type {
  FinanceTaxIntake,
  FinanceTaxPackageManifest,
  FinanceTaxEvaluation,
} from '@emdo/contracts';
import { FinanceTaxIntakeSchema } from '@emdo/contracts';
import {
  FINANCE_TAX_COUNTRY_CATALOG,
  FINANCE_TAX_PACKAGE_REGISTRY,
  FinanceTaxPackageRegistry,
  financeTaxScopeKey,
} from './index.js';

// Synthetic plumbing fixtures only: these are not a CA statutory rule or real tax form.
const digest = 'a'.repeat(64);
const intake: FinanceTaxIntake = {
  schemaVersion: 1,
  caseId: '00000000-0000-4000-8000-000000000001',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  workspaceId: '00000000-0000-4000-8000-000000000003',
  taxSubjectId: '00000000-0000-4000-8000-000000000005',
  sourceBooks: [],
  revision: 1,
  scope: {
    country: 'CA',
    subdivision: 'CA-ON',
    taxpayerType: 'individual',
    year: 2025,
    regime: 'synthetic-only',
    formVersion: 'fixture-1',
  },
  domesticResident: true,
  hasCrossBorderActivity: false,
  standaloneCorporation: null,
  requestedFeatures: ['income-tax-return'],
  facts: [
    {
      key: 'declaredAmount',
      value: { type: 'decimal', value: '0' },
      reviewState: 'reviewed',
      source: {
        kind: 'declaration',
        reference: 'fixture-declaration',
        revision: 1,
        contentHash: digest,
      },
    },
  ],
};
const manifest: FinanceTaxPackageManifest = {
  packageId: 'synthetic-fixture',
  version: '1',
  scope: intake.scope as FinanceTaxPackageManifest['scope'],
  engineVersion: 'fixture-1',
  implementationHash: digest,
  coverage: 'full-return',
  references: [
    {
      id: 'fixture-ref',
      authority: 'CRA authority URL; synthetic fixture, not statutory evidence',
      url: 'https://www.canada.ca/en/revenue-agency.html',
      title: 'Synthetic fixture reference',
      retrievedAt: '2026-09-13T00:00:00Z',
      documentHash: digest,
      locator: 'synthetic-only',
    },
  ],
  rules: [{ id: 'fixture-copy', referenceIds: ['fixture-ref'] }],
  requiredFacts: [{ key: 'declaredAmount', type: 'decimal' }],
  forms: [
    {
      id: 'fixture-return',
      version: 'fixture-1',
      referenceIds: ['fixture-ref'],
      fields: [{ key: 'amount', type: 'decimal', ruleIds: ['fixture-copy'] }],
    },
  ],
  validation: {
    reviewedBy: 'synthetic-test',
    reviewedAt: '2026-09-13T00:00:00Z',
    fullReturnCoverageAttested: true,
    reportHash: digest,
    fixtureIds: ['zero-fixture'],
  },
};
const evaluator = (
  input: Readonly<FinanceTaxIntake>,
): FinanceTaxEvaluation => ({
  forms: [
    {
      id: 'fixture-return',
      version: 'fixture-1',
      fields: [
        {
          key: 'amount',
          value: structuredClone(input.facts[0]!.value),
          ruleIds: ['fixture-copy'],
          sourceFactKeys: ['declaredAmount'],
        },
      ],
    },
  ],
  issues: [],
});
const evaluate = (
  input: Parameters<
    Parameters<FinanceTaxPackageRegistry['register']>[0]['evaluate']
  >[0],
) => evaluator(input as FinanceTaxIntake);
const selection = {
  packageId: manifest.packageId,
  packageVersion: manifest.version,
};
const request = (input = intake) => ({
  runId: '00000000-0000-4000-8000-000000000004',
  createdAt: '2026-09-13T00:00:00Z',
  ...selection,
  intake: input,
});
const registration = () => ({
  manifest: structuredClone(manifest),
  evaluate,
  fixtures: [
    {
      id: 'zero-fixture',
      intake: structuredClone(intake),
      expected: evaluator(intake),
    },
  ],
});
const registry = () =>
  FinanceTaxPackageRegistry.empty().register(registration());

describe('tax package coverage and deterministic return foundation', () => {
  it('allows no-ledger personal facts and combines only explicitly pinned source books', async () => {
    const instance = await registry();
    const personal = { ...structuredClone(intake), legalEntityId: null };
    expect((await instance.run(request(personal))).status).toBe('complete');
    const bookA = '00000000-0000-4000-8000-000000000011';
    const bookB = '00000000-0000-4000-8000-000000000012';
    const combined = {
      ...personal,
      sourceBooks: [
        { bookId: bookA, snapshotRevision: 1, snapshotHash: digest },
        { bookId: bookB, snapshotRevision: 2, snapshotHash: 'b'.repeat(64) },
      ],
      facts: [
        {
          ...personal.facts[0]!,
          source: {
            ...personal.facts[0]!.source,
            kind: 'ledger-snapshot' as const,
            sourceBookId: bookA,
          },
        },
        {
          ...personal.facts[0]!,
          key: 'secondAmount',
          source: {
            ...personal.facts[0]!.source,
            kind: 'ledger-snapshot' as const,
            sourceBookId: bookB,
            revision: 2,
            contentHash: 'b'.repeat(64),
          },
        },
      ],
    };
    const input = registration();
    input.manifest.requiredFacts.push({ key: 'secondAmount', type: 'decimal' });
    input.fixtures[0]!.intake = combined;
    const multiBookRegistry =
      await FinanceTaxPackageRegistry.empty().register(input);
    const run = await multiBookRegistry.run(request(combined));
    expect(run.status).toBe('complete');
    expect(run.intake.sourceBooks).toHaveLength(2);
    // Sharing a workspace does not add a book to the selected source boundary.
    expect(
      multiBookRegistry.assess(
        { ...combined, sourceBooks: [combined.sourceBooks[0]] },
        selection,
      ).status,
    ).toBe('incomplete');
    const stale = structuredClone(combined);
    stale.sourceBooks[1]!.snapshotRevision = 3;
    expect(FinanceTaxIntakeSchema.safeParse(stale).success).toBe(false);
  });
  it('ships all seven countries as unavailable with zero enabled packages', () => {
    expect(FINANCE_TAX_COUNTRY_CATALOG.map((entry) => entry.country)).toEqual([
      'CA',
      'US',
      'MX',
      'DE',
      'KR',
      'JP',
      'FR',
    ]);
    expect(
      FINANCE_TAX_COUNTRY_CATALOG.every(
        (entry) => entry.status === 'not-implemented',
      ),
    ).toBe(true);
    expect(FINANCE_TAX_PACKAGE_REGISTRY.list()).toEqual([]);
    expect(FINANCE_TAX_PACKAGE_REGISTRY.assess(intake, selection).status).toBe(
      'incomplete',
    );
  });
  it('registers a validated synthetic package without mutating the previous registry', async () => {
    const original = FinanceTaxPackageRegistry.empty();
    const input = registration();
    const next = await original.register(input);
    input.manifest.forms[0]!.version = 'changed';
    expect(original.list()).toEqual([]);
    expect(
      next.get(selection.packageId, selection.packageVersion)?.forms[0]
        ?.version,
    ).toBe('fixture-1');
    await expect(next.register(registration())).rejects.toThrow(
      'version-immutable',
    );
    expect(() => {
      (next.list()[0] as FinanceTaxPackageManifest).version = 'changed';
    }).toThrow();
  });
  it.each([
    ['country', 'US'],
    ['subdivision', 'CA-QC'],
    ['taxpayerType', 'sole-proprietor'],
    ['year', 2024],
    ['regime', 'other'],
    ['formVersion', 'fixture-2'],
  ])('requires exact %s coverage and blocks execution', async (key, value) => {
    const instance = await registry();
    const result = await instance.run(
      request({ ...intake, scope: { ...intake.scope, [key]: value } }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.output).toBeNull();
    expect(result.issues.some((entry) => entry.code === 'scope-mismatch')).toBe(
      true,
    );
  });
  it('requires explicit scope values and a package version, never latest fallback', async () => {
    const instance = await registry();
    expect(
      instance
        .assess({ ...intake, scope: {} }, selection)
        .issues.filter((entry) => entry.code === 'missing-scope'),
    ).toHaveLength(6);
    expect(instance.assess(intake).status).toBe('incomplete');
    expect(
      instance.assess(intake, { ...selection, packageVersion: 'latest' })
        .status,
    ).toBe('incomplete');
    expect(financeTaxScopeKey(intake.scope)).toBe(
      financeTaxScopeKey({ ...intake.scope }),
    );
  });
  it('requires facts including explicit zero and reviewed provenance', async () => {
    const instance = await registry();
    expect(instance.assess({ ...intake, facts: [] }, selection).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing-fact',
          path: 'facts.declaredAmount',
        }),
      ]),
    );
    const changed = structuredClone(intake);
    changed.facts[0]!.reviewState = 'disputed';
    expect(instance.assess(changed, selection).status).toBe('incomplete');
    changed.facts[0]!.reviewState = 'reviewed';
    changed.facts[0]!.value = { type: 'text', value: 'zero' };
    expect(
      instance
        .assess(changed, selection)
        .issues.some((entry) => entry.code === 'fact-type-mismatch'),
    ).toBe(true);
    expect(instance.assess(intake, selection).status).toBe('ready');
    expect(
      FinanceTaxIntakeSchema.safeParse({
        ...intake,
        facts: [intake.facts[0], intake.facts[0]],
      }).success,
    ).toBe(false);
  });
  it('blocks missing residency, cross-border cases, unsupported features and unknown facts', async () => {
    const instance = await registry();
    for (const patch of [
      { domesticResident: null },
      { domesticResident: false },
      { hasCrossBorderActivity: true },
      { hasCrossBorderActivity: null },
      { requestedFeatures: ['payroll'] },
      { requestedFeatures: ['electronic-filing'] },
      { requestedFeatures: ['consolidation'] },
      {
        facts: [
          ...intake.facts,
          { ...intake.facts[0], key: 'unhandledIncome' },
        ],
      },
    ]) {
      expect(instance.assess({ ...intake, ...patch }, selection).status).toBe(
        'incomplete',
      );
    }
    expect(
      instance
        .assess(
          {
            ...intake,
            scope: { ...intake.scope, taxpayerType: 'corporation' },
          },
          selection,
        )
        .issues.some((entry) => entry.path === 'standaloneCorporation'),
    ).toBe(true);
  });
  it('pins historical facts, source hashes, package, references and output in an immutable snapshot', async () => {
    const instance = await registry();
    const input = structuredClone(intake);
    const first = await instance.run(request(input));
    expect(first.status).toBe('complete');
    expect(first.output?.forms[0]?.fields[0]?.value.value).toBe('0');
    expect(first.filingStatus).toBe('not-filed');
    expect(first.packageManifest?.references[0]?.documentHash).toBe(digest);
    expect(first.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toEqual(await instance.run(request(input)));
    input.facts[0]!.value = { type: 'decimal', value: '15' };
    const second = await instance.run(request(input));
    expect(first.intake.facts[0]?.value.value).toBe('0');
    expect(second.inputHash).not.toBe(first.inputHash);
    expect(second.snapshotHash).not.toBe(first.snapshotHash);
    expect(() => {
      (first.output as FinanceTaxEvaluation).forms[0]!.fields[0]!.key =
        'mutated';
    }).toThrow();
    const versionTwo = registration();
    versionTwo.manifest.version = '2';
    const next = await instance.register(versionTwo);
    expect(await next.run(request(intake))).toEqual(first);
  });
  it('rejects invalid reference links and spoofed authority hosts', async () => {
    for (const url of [
      'https://www.canada.ca.evil.example/fake',
      'https://evil.example/',
      'https://secret@www.canada.ca/',
    ]) {
      const input = registration();
      input.manifest.references[0]!.url = url;
      await expect(
        FinanceTaxPackageRegistry.empty().register(input),
      ).rejects.toThrow('reference-not-authoritative');
    }
    const input = registration();
    input.manifest.rules[0]!.referenceIds = ['missing'];
    await expect(
      FinanceTaxPackageRegistry.empty().register(input),
    ).rejects.toThrow('reference-missing');
  });
  it('accepts explicitly reviewed subdivision authorities without treating the URL as rule validation', async () => {
    const input = registration();
    input.manifest.scope.country = 'US';
    input.manifest.scope.subdivision = 'US-NY';
    input.manifest.references[0]!.url = 'https://www.tax.ny.gov/';
    input.fixtures[0]!.intake.scope = structuredClone(input.manifest.scope);
    await expect(
      FinanceTaxPackageRegistry.empty().register(input),
    ).rejects.toThrow('reference-not-authoritative');
    const source = {
      country: 'US' as const,
      subdivision: 'US-NY',
      hostname: 'www.tax.ny.gov',
      authority: 'Synthetic review fixture only',
      reviewedBy: 'fixture-reviewer',
      reviewedAt: '2026-09-13T00:00:00Z',
      rationale: 'Synthetic host-policy test; not a review of statutory rules',
    };
    const configured = FinanceTaxPackageRegistry.empty([source]);
    const instance = await configured.register(input);
    const run = await instance.run(request(input.fixtures[0]!.intake));
    expect(run.status).toBe('complete');
    expect(run.authoritySourceReviews).toEqual([source]);
    const wrongSubdivision = FinanceTaxPackageRegistry.empty([
      { ...source, subdivision: 'US-CA' },
    ]);
    await expect(wrongSubdivision.register(input)).rejects.toThrow(
      'reference-not-authoritative',
    );
    const withoutRuleCapture = registration();
    withoutRuleCapture.manifest.references[0]!.documentHash = '';
    await expect(configured.register(withoutRuleCapture)).rejects.toThrow();
  });
  it('rejects nominal validation with absent fixtures or incorrect expected output', async () => {
    const absent = registration();
    absent.fixtures = [];
    await expect(
      FinanceTaxPackageRegistry.empty().register(absent),
    ).rejects.toThrow('fixtures-mismatch');
    const incorrect = registration();
    incorrect.fixtures[0]!.expected.forms[0]!.fields[0]!.value = {
      type: 'decimal',
      value: '999',
    };
    await expect(
      FinanceTaxPackageRegistry.empty().register(incorrect),
    ).rejects.toThrow('fixture-failed');
  });
  it('blocks malformed, nondeterministic and missing-field output even after valid fixtures', async () => {
    const changed = structuredClone(intake);
    changed.facts[0]!.value = { type: 'decimal', value: '5' };
    for (const failure of [
      'missing-field',
      'non-deterministic-evaluator',
      'invalid-evaluation',
    ]) {
      const input = registration();
      let counter = 0;
      input.evaluate = (facts) => {
        const output = evaluate(facts);
        if (facts.facts[0]!.value.value !== '0') {
          if (failure === 'missing-field') output.forms[0]!.fields = [];
          if (failure === 'non-deterministic-evaluator')
            output.forms[0]!.fields[0]!.value = {
              type: 'decimal',
              value: String(counter++),
            };
          if (failure === 'invalid-evaluation')
            throw new Error('sensitive-detail');
        }
        return output;
      };
      const instance = await FinanceTaxPackageRegistry.empty().register(input);
      const result = await instance.run(request(changed));
      expect(result.status).toBe('incomplete');
      expect(result.issues.some((entry) => entry.code === failure)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('sensitive-detail');
    }
  });
  it('requires conditional schedule facts and schedule outputs when applicable', async () => {
    const input = registration();
    input.manifest.requiredFacts.push(
      { key: 'hasSchedule', type: 'boolean' },
      {
        key: 'scheduleAmount',
        type: 'decimal',
        when: { factKey: 'hasSchedule', equals: true },
      },
    );
    input.manifest.forms.push({
      ...structuredClone(manifest.forms[0]!),
      id: 'fixture-schedule',
      when: { factKey: 'hasSchedule', equals: true },
    });
    const flag = {
      ...structuredClone(intake.facts[0]!),
      key: 'hasSchedule',
      value: { type: 'boolean' as const, value: false },
    };
    input.fixtures[0]!.intake.facts.push(flag);
    const instance = await FinanceTaxPackageRegistry.empty().register(input);
    const changed = structuredClone(input.fixtures[0]!.intake);
    changed.facts[1]!.value = { type: 'boolean', value: true };
    expect(
      instance
        .assess(changed, selection)
        .issues.some((entry) => entry.path === 'facts.scheduleAmount'),
    ).toBe(true);
    changed.facts.push({
      ...structuredClone(intake.facts[0]!),
      key: 'scheduleAmount',
    });
    const result = await instance.run(request(changed));
    expect(result.status).toBe('incomplete');
    expect(result.issues.some((entry) => entry.code === 'missing-form')).toBe(
      true,
    );
  });
});
