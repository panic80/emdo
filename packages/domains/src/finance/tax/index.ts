import {
  deepFreeze,
  FinanceTaxIntakeSchema,
  FinanceTaxScopeSchema,
  FinanceTaxPackageManifestSchema,
  FinanceTaxEvaluationSchema,
  FinanceTaxRunRequestSchema,
  FinanceTaxAuthoritySourceSchema,
} from '@emdo/contracts';
import type {
  DeepReadonly,
  FinanceTaxCountry,
  FinanceTaxIntake,
  FinanceTaxPackageManifest,
  FinanceTaxEvaluation,
  FinanceTaxAuthoritySource,
} from '@emdo/contracts';

/** Discovery links only. These are not captured rule documents or validated packages. */
export const FINANCE_TAX_COUNTRY_CATALOG = deepFreeze([
  {
    country: 'CA',
    authority: 'Canada Revenue Agency',
    url: 'https://www.canada.ca/en/revenue-agency.html',
    status: 'not-implemented',
  },
  {
    country: 'US',
    authority: 'Internal Revenue Service',
    url: 'https://www.irs.gov/',
    status: 'not-implemented',
  },
  {
    country: 'MX',
    authority: 'Servicio de Administración Tributaria',
    url: 'https://www.sat.gob.mx/',
    status: 'not-implemented',
  },
  {
    country: 'DE',
    authority: 'Federal Ministry of Finance',
    url: 'https://www.bundesfinanzministerium.de/Web/EN/Home/home.html',
    status: 'not-implemented',
  },
  {
    country: 'KR',
    authority: 'National Tax Service',
    url: 'https://www.nts.go.kr/english/main.do',
    status: 'not-implemented',
  },
  {
    country: 'JP',
    authority: 'National Tax Agency',
    url: 'https://www.nta.go.jp/english/',
    status: 'not-implemented',
  },
  {
    country: 'FR',
    authority: 'Direction générale des Finances publiques',
    url: 'https://www.impots.gouv.fr/',
    status: 'not-implemented',
  },
] as const);

const authorityHosts: Record<FinanceTaxCountry, readonly string[]> = {
  CA: ['canada.ca', 'laws-lois.justice.gc.ca', 'revenuquebec.ca'],
  US: ['irs.gov', 'uscode.house.gov', 'ecfr.gov'],
  MX: ['sat.gob.mx', 'dof.gob.mx'],
  DE: [
    'bundesfinanzministerium.de',
    'gesetze-im-internet.de',
    'elster.de',
    'bzst.de',
  ],
  KR: ['nts.go.kr', 'law.go.kr'],
  JP: ['nta.go.jp', 'laws.e-gov.go.jp'],
  FR: ['impots.gouv.fr', 'legifrance.gouv.fr'],
};

export type FinanceTaxIssue = { code: string; path: string; message: string };
type Manifest = DeepReadonly<FinanceTaxPackageManifest>;
type Intake = DeepReadonly<FinanceTaxIntake>;
type Evaluation = DeepReadonly<FinanceTaxEvaluation>;
export type FinanceTaxPackageFixture = {
  id: string;
  intake: FinanceTaxIntake;
  expected: FinanceTaxEvaluation;
};
/** Trusted server/build-time code, never an HTTP payload or model-authored callback. */
export type FinanceTaxPackageRegistration = {
  manifest: FinanceTaxPackageManifest;
  evaluate: (intake: Intake) => FinanceTaxEvaluation;
  fixtures: readonly FinanceTaxPackageFixture[];
};
type Entry = {
  manifest: Manifest;
  evaluate: FinanceTaxPackageRegistration['evaluate'];
  manifestHash: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
async function hash(value: unknown) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
export function financeTaxScopeKey(input: unknown): string {
  const scope = FinanceTaxScopeSchema.parse(input);
  return canonical(scope);
}
function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`finance-tax-duplicate-${label}`);
}
function isCountry(country: string): country is FinanceTaxCountry {
  return FINANCE_TAX_COUNTRY_CATALOG.some((entry) => entry.country === country);
}
function validateManifest(
  manifest: Manifest,
  sourceReviews: readonly DeepReadonly<FinanceTaxAuthoritySource>[],
) {
  if (!isCountry(manifest.scope.country))
    throw new Error('finance-tax-country-unsupported');
  unique(
    manifest.references.map((r) => r.id),
    'reference',
  );
  unique(
    manifest.rules.map((r) => r.id),
    'rule',
  );
  unique(
    manifest.forms.map((r) => r.id),
    'form',
  );
  unique(
    manifest.requiredFacts.map((r) => r.key),
    'fact',
  );
  unique(manifest.validation.fixtureIds, 'fixture');
  const references = new Set(manifest.references.map((r) => r.id));
  const rules = new Set(manifest.rules.map((r) => r.id));
  const facts = new Map(manifest.requiredFacts.map((r) => [r.key, r]));
  const validateReferences = (ids: readonly string[]) => {
    unique(ids, 'reference-link');
    if (ids.some((id) => !references.has(id)))
      throw new Error('finance-tax-reference-missing');
  };
  for (const reference of manifest.references) {
    const url = new URL(reference.url);
    const reviewedSubdivisionHost = sourceReviews.some(
      (source) =>
        source.country === manifest.scope.country &&
        source.subdivision === manifest.scope.subdivision &&
        url.hostname === source.hostname,
    );
    if (
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      (!reviewedSubdivisionHost &&
        !authorityHosts[manifest.scope.country].some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        ))
    )
      throw new Error('finance-tax-reference-not-authoritative');
  }
  const validateCondition = (condition: Manifest['forms'][number]['when']) => {
    if (!condition) return;
    const fact = facts.get(condition.factKey);
    if (
      !fact ||
      fact.when ||
      (fact.type === 'boolean') !== (typeof condition.equals === 'boolean')
    )
      throw new Error(
        'finance-tax-condition-requires-unconditional-typed-fact',
      );
  };
  for (const fact of manifest.requiredFacts) validateCondition(fact.when);
  for (const rule of manifest.rules) validateReferences(rule.referenceIds);
  for (const form of manifest.forms) {
    validateReferences(form.referenceIds);
    validateCondition(form.when);
    unique(
      form.fields.map((field) => field.key),
      'field',
    );
    for (const field of form.fields) {
      unique(field.ruleIds, 'field-rule');
      if (field.ruleIds.some((id) => !rules.has(id)))
        throw new Error('finance-tax-rule-missing');
    }
  }
  if (!manifest.forms.some((form) => !form.when))
    throw new Error('finance-tax-unconditional-return-form-required');
}

function applies(condition: Manifest['forms'][number]['when'], intake: Intake) {
  return (
    !condition ||
    intake.facts.find((fact) => fact.key === condition.factKey)?.value.value ===
      condition.equals
  );
}
function intakeIssues(intake: Intake, manifest?: Manifest): FinanceTaxIssue[] {
  const issues: FinanceTaxIssue[] = [];
  const issue = (code: string, path: string, message: string) =>
    issues.push({ code, path, message });
  const scope = FinanceTaxScopeSchema.safeParse(intake.scope);
  if (!scope.success)
    for (const entry of scope.error.issues)
      issue(
        'missing-scope',
        `scope.${entry.path.join('.')}`,
        'Exact tax return scope is required',
      );
  if (intake.scope.country && !isCountry(intake.scope.country))
    issue(
      'unsupported-country',
      'scope.country',
      'Country has no package platform coverage',
    );
  if (intake.domesticResident !== true)
    issue(
      intake.domesticResident === null ? 'missing-fact' : 'unsupported-scope',
      'domesticResident',
      'Domestic residency must be established',
    );
  if (intake.hasCrossBorderActivity !== false)
    issue(
      intake.hasCrossBorderActivity === null
        ? 'missing-fact'
        : 'unsupported-scope',
      'hasCrossBorderActivity',
      'Cross-border activity is outside this release',
    );
  if (
    intake.scope.taxpayerType === 'corporation' &&
    intake.standaloneCorporation !== true
  )
    issue(
      intake.standaloneCorporation === null
        ? 'missing-fact'
        : 'unsupported-scope',
      'standaloneCorporation',
      'Standalone corporation status must be established',
    );
  for (const feature of intake.requestedFeatures)
    if (feature !== 'income-tax-return')
      issue(
        'unsupported-feature',
        'requestedFeatures',
        `${feature} is outside this release`,
      );
  for (const fact of intake.facts)
    if (fact.reviewState !== 'reviewed')
      issue(
        'unresolved-fact',
        `facts.${fact.key}`,
        'Every supplied fact must be reviewed and undisputed',
      );
  if (manifest) {
    if (
      scope.success &&
      financeTaxScopeKey(scope.data) !== financeTaxScopeKey(manifest.scope)
    )
      issue(
        'scope-mismatch',
        'scope',
        'Package requires exact country, subdivision, taxpayer type, year, regime and form version',
      );
    const known = new Map(
      manifest.requiredFacts.map((fact) => [fact.key, fact]),
    );
    for (const fact of intake.facts)
      if (!known.has(fact.key))
        issue(
          'unsupported-fact',
          `facts.${fact.key}`,
          'Package has no declared handling for this fact',
        );
    for (const required of manifest.requiredFacts) {
      const fact = intake.facts.find((entry) => entry.key === required.key);
      if (!applies(required.when, intake)) {
        if (fact)
          issue(
            'inapplicable-fact',
            `facts.${required.key}`,
            'Fact conflicts with its applicability condition',
          );
        continue;
      }
      if (!fact)
        issue(
          'missing-fact',
          `facts.${required.key}`,
          'Required return fact is absent; zero cannot be inferred',
        );
      else if (fact.value.type !== required.type)
        issue(
          'fact-type-mismatch',
          `facts.${required.key}`,
          'Fact has the wrong declared type',
        );
    }
  }
  return issues;
}

function validateEvaluation(
  output: Evaluation,
  manifest: Manifest,
  intake: Intake,
): FinanceTaxIssue[] {
  const issues: FinanceTaxIssue[] = output.issues.map((entry) => ({
    ...entry,
    path: 'evaluation',
  }));
  const issue = (code: string, path: string) =>
    issues.push({
      code,
      path,
      message: 'Return output does not satisfy the validated package manifest',
    });
  const expected = manifest.forms.filter((form) => applies(form.when, intake));
  if (new Set(output.forms.map((form) => form.id)).size !== output.forms.length)
    issue('duplicate-form', 'forms');
  for (const actual of output.forms)
    if (!expected.some((form) => form.id === actual.id))
      issue('unexpected-form', `forms.${actual.id}`);
  for (const form of expected) {
    const actual = output.forms.find((entry) => entry.id === form.id);
    if (!actual) {
      issue('missing-form', `forms.${form.id}`);
      continue;
    }
    if (actual.version !== form.version)
      issue('form-version-mismatch', `forms.${form.id}`);
    if (
      new Set(actual.fields.map((field) => field.key)).size !==
      actual.fields.length
    )
      issue('duplicate-field', `forms.${form.id}`);
    for (const field of actual.fields)
      if (!form.fields.some((spec) => spec.key === field.key))
        issue('unexpected-field', `forms.${form.id}.${field.key}`);
    for (const field of form.fields) {
      const actualField = actual.fields.find(
        (entry) => entry.key === field.key,
      );
      const path = `forms.${form.id}.${field.key}`;
      if (!actualField) {
        issue('missing-field', path);
        continue;
      }
      if (actualField.value.type !== field.type)
        issue('field-type-mismatch', path);
      if (
        canonical([...actualField.ruleIds].sort()) !==
        canonical([...field.ruleIds].sort())
      )
        issue('field-rule-mismatch', path);
      if (
        new Set(actualField.sourceFactKeys).size !==
          actualField.sourceFactKeys.length ||
        actualField.sourceFactKeys.some(
          (key) => !intake.facts.some((fact) => fact.key === key),
        )
      )
        issue('field-source-mismatch', path);
    }
  }
  return issues;
}

function evaluate(entry: Entry, intake: Intake) {
  try {
    // Independent frozen inputs prevent callback mutation; repeated output detects observable nondeterminism.
    const first = FinanceTaxEvaluationSchema.parse(
      entry.evaluate(deepFreeze(structuredClone(intake))),
    );
    const second = FinanceTaxEvaluationSchema.parse(
      entry.evaluate(deepFreeze(structuredClone(intake))),
    );
    if (canonical(first) !== canonical(second))
      return {
        output: null,
        issues: [
          {
            code: 'non-deterministic-evaluator',
            path: 'evaluation',
            message: 'Repeated evaluation produced different return output',
          },
        ],
      };
    return {
      output: deepFreeze(first),
      issues: validateEvaluation(first, entry.manifest, intake),
    };
  } catch {
    return {
      output: null,
      issues: [
        {
          code: 'invalid-evaluation',
          path: 'evaluation',
          message: 'Package failed to produce a valid deterministic return',
        },
      ],
    };
  }
}

/** Immutable registry. Addition returns a new registry; versions are never replaced or selected implicitly. */
export class FinanceTaxPackageRegistry {
  readonly #entries: ReadonlyMap<string, Entry>;
  readonly #authoritySources: readonly DeepReadonly<FinanceTaxAuthoritySource>[];
  private constructor(
    entries: ReadonlyMap<string, Entry>,
    authoritySources: readonly DeepReadonly<FinanceTaxAuthoritySource>[],
  ) {
    this.#entries = entries;
    this.#authoritySources = authoritySources;
    Object.freeze(this);
  }
  /** Trusted source policy is established by application code, never user-controlled intake. */
  static empty(authoritySources: readonly FinanceTaxAuthoritySource[] = []) {
    return new FinanceTaxPackageRegistry(
      new Map(),
      deepFreeze(
        authoritySources.map((source) =>
          FinanceTaxAuthoritySourceSchema.parse(source),
        ),
      ),
    );
  }
  list() {
    return deepFreeze(
      [...this.#entries.values()]
        .map((entry) => entry.manifest)
        .sort((a, b) =>
          `${a.packageId}:${a.version}`.localeCompare(
            `${b.packageId}:${b.version}`,
            'en',
          ),
        ),
    );
  }
  get(packageId: string, version: string) {
    return this.#entries.get(canonical([packageId, version]))?.manifest ?? null;
  }
  async register(
    registration: FinanceTaxPackageRegistration,
  ): Promise<FinanceTaxPackageRegistry> {
    const manifest = deepFreeze(
      FinanceTaxPackageManifestSchema.parse(registration.manifest),
    );
    validateManifest(manifest, this.#authoritySources);
    const key = canonical([manifest.packageId, manifest.version]);
    if (this.#entries.has(key))
      throw new Error('finance-tax-package-version-immutable');
    const fixtures = structuredClone(registration.fixtures);
    unique(
      fixtures.map((fixture) => fixture.id),
      'fixture',
    );
    if (
      canonical(fixtures.map((fixture) => fixture.id).sort()) !==
      canonical([...manifest.validation.fixtureIds].sort())
    )
      throw new Error('finance-tax-validation-fixtures-mismatch');
    const entry = {
      manifest,
      evaluate: registration.evaluate,
      manifestHash: await hash(manifest),
    };
    for (const fixture of fixtures) {
      const intake = deepFreeze(FinanceTaxIntakeSchema.parse(fixture.intake));
      if (intakeIssues(intake, manifest).length)
        throw new Error('finance-tax-validation-intake-invalid');
      const result = evaluate(entry, intake);
      if (
        result.issues.length ||
        canonical(result.output) !==
          canonical(FinanceTaxEvaluationSchema.parse(fixture.expected))
      )
        throw new Error('finance-tax-validation-fixture-failed');
    }
    return new FinanceTaxPackageRegistry(
      new Map([...this.#entries, [key, Object.freeze(entry)]]),
      this.#authoritySources,
    );
  }
  assess(
    input: unknown,
    selection?: { packageId: string; packageVersion: string },
  ) {
    const parsed = FinanceTaxIntakeSchema.safeParse(input);
    if (!parsed.success)
      return deepFreeze({
        status: 'incomplete' as const,
        issues: parsed.error.issues.map((entry) => ({
          code: 'invalid-intake',
          path: entry.path.join('.'),
          message: entry.message,
        })),
        package: null,
      });
    const manifest = selection
      ? this.get(selection.packageId, selection.packageVersion)
      : null;
    const issues = intakeIssues(parsed.data, manifest ?? undefined);
    if (!manifest)
      issues.push({
        code: selection ? 'package-unavailable' : 'package-selection-required',
        path: 'package',
        message:
          'An explicitly selected, validated package version is required; country catalog entries are not tax support',
      });
    return deepFreeze({
      status: issues.length ? ('incomplete' as const) : ('ready' as const),
      issues,
      package: manifest,
    });
  }
  async run(input: unknown) {
    const request = deepFreeze(FinanceTaxRunRequestSchema.parse(input));
    const entry = this.#entries.get(
      canonical([request.packageId, request.packageVersion]),
    );
    const assessment = this.assess(request.intake, request);
    const result =
      entry && assessment.status === 'ready'
        ? evaluate(entry, request.intake)
        : { output: null, issues: [...assessment.issues] };
    const snapshot = {
      schemaVersion: 1 as const,
      runId: request.runId,
      createdAt: request.createdAt,
      status: result.issues.length
        ? ('incomplete' as const)
        : ('complete' as const),
      intake: request.intake,
      selectedPackage: {
        packageId: request.packageId,
        version: request.packageVersion,
      },
      packageManifest: entry?.manifest ?? null,
      packageManifestHash: entry?.manifestHash ?? null,
      authoritySourceReviews: this.#authoritySources.filter(
        (source) =>
          source.country === entry?.manifest.scope.country &&
          source.subdivision === entry?.manifest.scope.subdivision,
      ),
      inputHash: await hash(request.intake),
      output: result.output,
      issues: result.issues,
      // A complete calculation does not claim electronic filing or acceptance by a tax authority.
      filingStatus: 'not-filed' as const,
    };
    return deepFreeze({ ...snapshot, snapshotHash: await hash(snapshot) });
  }
}

/** Deliberately empty: no statutory calculation package has yet passed full-return validation. */
export const FINANCE_TAX_PACKAGE_REGISTRY = FinanceTaxPackageRegistry.empty();
