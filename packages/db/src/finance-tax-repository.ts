import {
  US_PRIVATE_PACKAGE_VERSION,
  US_PRIVATE_PACKAGE_HASH,
  US_PRIVATE_QUESTIONS,
  runPrivateUsWorkingPapers,
  exportPrivateUsWorkingPapers,
  type PrivateUsWageEvidence,
} from './finance-tax-us-adapter.js';
import {
  CORPORATE_WORKING_OUTPUT_VERSION,
  runPrivateCorporateWorkingPapers,
  exportPrivateCorporateWorkingPapers,
} from './finance-tax-corporate-adapter.js';
import {
  MEXICO_WORKING_OUTPUT_VERSION,
  runPrivateMexicoWorkingPapers,
  exportPrivateMexicoWorkingPapers,
} from './finance-tax-mexico-adapter.js';
import {
  NY_PRIVATE_PACKAGE_HASH,
  NY_PRIVATE_PACKAGE_VERSION,
  NY_PRIVATE_QUESTIONS,
  NY_PRIVATE_SCOPE,
  NY_PRIVATE_WORKFLOW_ID,
  runPrivateNewYorkWorkingPapers,
  exportPrivateNewYorkWorkingPapers,
} from './finance-tax-ny-adapter.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  UuidSchema,
  FinanceTaxWageEvidencePreparationSchema,
  FinanceTaxWageExtractionSchema,
  ReviewPrivateTaxWageEvidenceSchema,
  FinanceTaxWageEvidenceReviewSchema,
  CreatePrivateTaxCalculationRunSchema,
  ReviewPrivateTaxWorkingInputsSchema,
  ReviewPrivateTaxCalculationRunSchema,
  FinanceTaxCalculationRunSummarySchema,
  FinanceTaxCalculationRunDetailSchema,
  FinanceTaxRunFieldSchema,
  FinanceTaxWorkingPaperPreparationSchema,
  FinanceTaxFormAuditSummarySchema,
  CreatePrivateTaxCaseSchema,
  BindPrivateTaxLegalEntitySchema,
  RecordPrivateTaxDeclarationSchema,
  SavePrivateTaxAnswerSchema,
  ReviewPrivateTaxAnswerSchema,
  WithdrawPrivateTaxAnswerSchema,
  GrantPrivateTaxCaseSchema,
  RevokePrivateTaxCaseGrantSchema,
  AuthorizePrivateTaxBookSourceSchema,
  ResetPrivateTaxInputsSchema,
  WorkspaceContextSchema,
  FinanceTaxQuestionnaireSchema,
  FinanceTaxIntakeSchema,
  FinanceTaxDeclaredInputSchema,
  FINANCE_TAX_INTAKE_ONLY_BINDING,
  type WorkspaceContext,
  type FinanceTaxQuestionnaire,
  type FinanceTaxIntake,
  type FinanceTaxDeclaredInput,
  type FinanceTaxQuestionnaireAccess,
} from '@emdo/contracts';
import {
  US_2025_CANDIDATE,
  MEXICO_2025_VERSION,
  MEXICO_2025_PRIVATE_ADAPTER_VERSION,
  MEXICO_2025_PRIVATE_QUESTIONNAIRES,
  MEXICO_2025_SOURCES,
  mexico2025ReportHash,
  usReviewContentHash,
  prepareUs2025ReviewBundle,
  type UsReviewedWageArtifact,
  CORPORATE_PRIVATE_SCOPE,
  CORPORATE_PRIVATE_QUESTIONS,
  CORPORATE_PRIVATE_ADAPTER_VERSION,
  CANADA_CORPORATE_2025_PACKAGE_VERSION,
  CANADA_CORPORATE_2025_DEFINITION_HASH,
  FINANCE_TAX_PACKAGE_REGISTRY,
  CANADA_ON_2025_PERSONAL_CANDIDATE,
  CANADA_ON_2025_PERSONAL_QUESTIONS,
  CANADA_ON_2025_PERSONAL_PACKAGE_VERSION,
  PERSONAL_PAPER_REPORTING_POLICY_VERSION,
  PERSONAL_FORM_APPLICABILITY_VERSION,
  PERSONAL_REQUIRED_FORM_FACTS,
  PERSONAL_REQUIRED_BUSINESS_FORM_FACTS,
  auditCanadaOntario2025PersonalFormApplicability,
  runCanadaOntario2025PersonalWorkflow,
  exportCanadaOntario2025PersonalSchedules,
  type CanadaOntario2025PersonalRun,
  createFinanceTaxQuestionnaire,
  saveFinanceTaxQuestionnaireAnswer,
  reviewFinanceTaxQuestionnaireAnswer,
  withdrawFinanceTaxQuestionnaireAnswer,
  assessFinanceTaxQuestionnaire,
} from '@emdo/domains/finance';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';
import { withDurableTransaction } from './durable/scoped-transaction.js';

const Revision = z.number().int().positive().max(2147483647);
const Key = z.string().min(1).max(160);
export {
  CreatePrivateTaxCaseSchema,
  RecordPrivateTaxDeclarationSchema,
  SavePrivateTaxAnswerSchema,
  ReviewPrivateTaxAnswerSchema,
  WithdrawPrivateTaxAnswerSchema,
  GrantPrivateTaxCaseSchema,
  RevokePrivateTaxCaseGrantSchema,
  AuthorizePrivateTaxBookSourceSchema,
  ResetPrivateTaxInputsSchema,
} from '@emdo/contracts';
export class FinanceTaxPersistenceError extends Error {
  constructor(
    readonly code:
      'forbidden' | 'conflict' | 'invalid-input' | 'source-revoked',
    message: string,
  ) {
    super(message);
    this.name = 'FinanceTaxPersistenceError';
  }
}
const fail = (
  code: FinanceTaxPersistenceError['code'],
  message: string,
): never => {
  throw new FinanceTaxPersistenceError(code, `finance-tax-${message}`);
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const parseWageExtraction = (value: unknown) => {
  try {
    return FinanceTaxWageExtractionSchema.parse(
      JSON.parse(z.string().max(2000).parse(value)),
    );
  } catch {
    throw new FinanceTaxPersistenceError(
      'invalid-input',
      'finance-tax-invalid-wage-extraction',
    );
  }
};
type CaseRow = {
  id: string;
  workspace_id: string;
  tax_subject_id: string;
  current_revision: number;
  title: string;
  status: string;
  case_role: 'owner' | 'preparer' | 'reviewer' | 'viewer';
};
const Roles = {
  read: ['owner', 'preparer', 'reviewer', 'viewer'],
  edit: ['owner', 'preparer'],
  review: ['owner', 'reviewer'],
  owner: ['owner'],
};

const WorkingWorkflowId = 'ca-on-2025-personal-working-papers' as const;
const privateBusinessFormLabel = (key: string): string | undefined => {
  if (key === 'businessIdentity.preparerNameAndAddress')
    return 'Name and address of the person or firm preparing this business statement';
  if (key === 'businessIdentity.hasProgramAccount')
    return 'Does this business have a CRA program account number?';
  if (key === 'businessIdentity.programAccountNumber')
    return 'CRA program account number, if applicable (15 characters)';
  if (key === 'businessIdentity.lastBusinessYear')
    return 'Was 2025 the last year of this business?';
  const site = /^businessIdentity\.internetSite([1-5])$/.exec(key);
  return site
    ? `Income-generating website ${site[1]} (up to five websites, highest income first)`
    : undefined;
};
const privateFormQuestions = (taxpayerType: string | undefined) =>
  [
    ...PERSONAL_REQUIRED_FORM_FACTS,
    ...(taxpayerType === 'sole-proprietor'
      ? PERSONAL_REQUIRED_BUSINESS_FORM_FACTS
      : []),
  ].map((f) => ({
    key: f.key,
    type: f.type,
    label:
      privateBusinessFormLabel(f.key) ??
      f.key
        .replace(/^identity\./, 'Personal: ')
        .replace(/^businessIdentity\./, 'Business: ')
        .replace(/([a-z])([A-Z])/g, '$1 $2'),
    required:
      ![
        'identity.email',
        'identity.electionsCanadaAuthorization',
        'businessIdentity.programAccountNumber',
      ].includes(f.key) && !/^businessIdentity\.internetSite[1-5]$/.test(f.key),
    locator: `2025 CRA form field: ${f.path}`,
  }));
const workingQuestions = (taxpayerType: string | undefined) => [
  ...CANADA_ON_2025_PERSONAL_QUESTIONS.filter(
    (q) =>
      taxpayerType === 'sole-proprietor' ||
      ![
        'business.incomeKind',
        'business.reportingMethod',
        'business.methodChanged',
        'business.amountsOnSelectedBasis',
      ].includes(q.key),
  ),
  ...privateFormQuestions(taxpayerType),
];
const WorkingPackageHash = hash({
  candidate: CANADA_ON_2025_PERSONAL_CANDIDATE,
  questions: CANADA_ON_2025_PERSONAL_QUESTIONS,
  reportingPolicyVersion: PERSONAL_PAPER_REPORTING_POLICY_VERSION,
  formApplicabilityVersion: PERSONAL_FORM_APPLICABILITY_VERSION,
  privateFormFacts: [
    PERSONAL_REQUIRED_FORM_FACTS,
    PERSONAL_REQUIRED_BUSINESS_FORM_FACTS,
  ],
});
const CorporateWorkflowId = 'ca-on-2025-corporate-working-papers' as const;
const CorporatePackageHash = hash({
  outputAdapterVersion: CORPORATE_WORKING_OUTPUT_VERSION,
  definitionHash: CANADA_CORPORATE_2025_DEFINITION_HASH,
  adapterVersion: CORPORATE_PRIVATE_ADAPTER_VERSION,
  questions: CORPORATE_PRIVATE_QUESTIONS,
});
const UsWorkflowId = 'us-fed-2025-working-papers' as const;
const MexicoWorkflowId = 'mx-fed-2025-working-papers' as const;
const MexicoPackageHash = hash({
  outputAdapterVersion: MEXICO_WORKING_OUTPUT_VERSION,
  adapterVersion: MEXICO_2025_PRIVATE_ADAPTER_VERSION,
  packageVersion: MEXICO_2025_VERSION,
  questionnaires: MEXICO_2025_PRIVATE_QUESTIONNAIRES,
  sources: MEXICO_2025_SOURCES,
});
const mexicoAdapter = (taxpayerType: string | undefined) => {
  const candidate =
    MEXICO_2025_PRIVATE_QUESTIONNAIRES.find(
      (entry) => entry.scope.taxpayerType === taxpayerType,
    ) ?? MEXICO_2025_PRIVATE_QUESTIONNAIRES[0]!;
  return {
    workflowId: MexicoWorkflowId,
    packageVersion: MEXICO_2025_VERSION,
    packageHash: MexicoPackageHash,
    scopes: [candidate.scope],
    questions: candidate.questions.map(
      ({ key, label, type, required, locator }) => ({
        key,
        label,
        type,
        required,
        locator,
      }),
    ),
  };
};
const NewYorkFederalPrefix = 'federal.';
const NewYorkStatePrefix = 'newYork.';
const NewYorkWageFactKey = 'wageEvidence.documents';
const NewYorkQuestions = [
  ...US_PRIVATE_QUESTIONS.filter(
    (question) => question.key !== NewYorkWageFactKey,
  ).map((question) => ({
    ...question,
    key: `${NewYorkFederalPrefix}${question.key}`,
    label: `Federal / ${question.label}`,
  })),
  ...NY_PRIVATE_QUESTIONS.filter(
    (question) => question.key !== NewYorkWageFactKey,
  ).map((question) => ({
    ...question,
    key: `${NewYorkStatePrefix}${question.key}`,
    label: `New York / ${question.label}`,
  })),
  NY_PRIVATE_QUESTIONS.find((question) => question.key === NewYorkWageFactKey)!,
];
const workingAdapter = (
  taxpayerType: string | undefined,
  country?: string,
  subdivision?: string,
) =>
  country === 'MX'
    ? mexicoAdapter(taxpayerType)
    : subdivision === 'US-NY'
      ? {
          workflowId: NY_PRIVATE_WORKFLOW_ID,
          packageVersion: NY_PRIVATE_PACKAGE_VERSION,
          packageHash: NY_PRIVATE_PACKAGE_HASH,
          scopes: [NY_PRIVATE_SCOPE],
          questions: NewYorkQuestions,
        }
      : country === 'US'
        ? {
            workflowId: UsWorkflowId,
            packageVersion: US_PRIVATE_PACKAGE_VERSION,
            packageHash: US_PRIVATE_PACKAGE_HASH,
            scopes: [US_2025_CANDIDATE.scope],
            questions: US_PRIVATE_QUESTIONS,
          }
        : taxpayerType === 'corporation'
          ? {
              workflowId: CorporateWorkflowId,
              packageVersion: CANADA_CORPORATE_2025_PACKAGE_VERSION,
              packageHash: CorporatePackageHash,
              scopes: [CORPORATE_PRIVATE_SCOPE],
              questions: CORPORATE_PRIVATE_QUESTIONS,
            }
          : {
              workflowId: WorkingWorkflowId,
              packageVersion: CANADA_ON_2025_PERSONAL_PACKAGE_VERSION,
              packageHash: WorkingPackageHash,
              scopes: CANADA_ON_2025_PERSONAL_CANDIDATE.scopes,
              questions: workingQuestions(taxpayerType),
            };
const materializedFact = (
  input: FinanceTaxDeclaredInput,
  reviews: readonly {
    sourceId: string;
    sourceRevision: number;
    contentHash: string;
  }[],
  prefix: string,
) => {
  const factKey = input.factKey.startsWith(prefix)
    ? input.factKey.slice(prefix.length)
    : input.factKey;
  return {
    key: factKey,
    value: input.value,
    reviewState: reviews.some(
      (review) =>
        review.sourceId === input.sourceId &&
        review.sourceRevision === input.sourceRevision &&
        review.contentHash === input.contentHash,
    )
      ? ('reviewed' as const)
      : ('unreviewed' as const),
    source: {
      kind: 'declaration' as const,
      reference: `declaration:${input.sourceId}`,
      revision: input.sourceRevision,
      contentHash: input.contentHash,
    },
  };
};
const projectNewYorkFederalIntake = (
  base: FinanceTaxIntake,
  declaredInputs: readonly FinanceTaxDeclaredInput[],
  reviews: readonly {
    sourceId: string;
    sourceRevision: number;
    contentHash: string;
  }[],
) =>
  FinanceTaxIntakeSchema.parse({
    ...base,
    scope: US_2025_CANDIDATE.scope,
    standaloneCorporation: null,
    facts: declaredInputs
      .filter(
        (input) =>
          input.factKey.startsWith(NewYorkFederalPrefix) ||
          input.factKey === NewYorkWageFactKey,
      )
      .map((input) => materializedFact(input, reviews, NewYorkFederalPrefix)),
  });
const projectNewYorkStateIntake = (
  base: FinanceTaxIntake,
  declaredInputs: readonly FinanceTaxDeclaredInput[],
  reviews: readonly {
    sourceId: string;
    sourceRevision: number;
    contentHash: string;
  }[],
  federalInputHash?: string,
) =>
  FinanceTaxIntakeSchema.parse({
    ...base,
    scope: NY_PRIVATE_SCOPE,
    standaloneCorporation: null,
    facts: declaredInputs
      .filter((input) => input.factKey.startsWith(NewYorkStatePrefix))
      .map((input) => {
        const fact = materializedFact(input, reviews, NewYorkStatePrefix);
        // This is a dependency binding, not a taxpayer amount. Resolve it
        // from the exact projected federal component after declarations are
        // loaded; the declaration remains required and reviewed.
        return input.factKey === `${NewYorkStatePrefix}federalInputHash` &&
          federalInputHash
          ? {
              ...fact,
              value: { type: 'text' as const, value: federalInputHash },
            }
          : fact;
      }),
  });
type StoredSchedule = {
  formId: string;
  contentHash: string;
  content: Array<{
    ordinal: number;
    field: z.infer<typeof FinanceTaxRunFieldSchema>;
  }>;
};
type StoredRunOutput = (
  | Omit<CanadaOntario2025PersonalRun, 'fields'>
  | Omit<ReturnType<typeof runPrivateCorporateWorkingPapers>, 'fields'>
  | Omit<ReturnType<typeof runPrivateUsWorkingPapers>, 'fields'>
  | Omit<ReturnType<typeof runPrivateNewYorkWorkingPapers>, 'fields'>
  | Omit<ReturnType<typeof runPrivateMexicoWorkingPapers>, 'fields'>
) & {
  scheduleManifest: Array<{ formId: string; contentHash: string }>;
  formAudit?: ReturnType<
    typeof auditCanadaOntario2025PersonalFormApplicability
  >;
};
const formAuditSummary = (audit: NonNullable<StoredRunOutput['formAudit']>) =>
  FinanceTaxFormAuditSummarySchema.parse({
    version: audit.version,
    runHash: audit.runHash,
    packageVersion: audit.packageVersion,
    formDataReady: audit.formDataReady,
    fieldCount: audit.fieldCount,
    unresolvedCount: audit.unresolvedCount,
    signature: audit.signature,
    requirements: audit.requirements.map(
      ({ key, type, required, satisfied, sourceId, sourceBinding }) => ({
        key,
        type,
        required,
        satisfied,
        sourceId,
        sourceBinding,
      }),
    ),
    issues: audit.issues,
    remainingProof: audit.remainingProof,
  });
const exportFormAudit = (
  audit: NonNullable<StoredRunOutput['formAudit']>,
  facts: Array<{
    key: string;
    value: { type: string; value: unknown };
    reviewState: string;
  }>,
) => {
  const quote = (v: unknown) => {
    const s = String(v);
    return (
      '"' + (/^[\s]*[=+@-]/.test(s) ? "'" : '') + s.replaceAll('"', '""') + '"'
    );
  };
  return [
    'Required form data: incomplete; taxpayer signature/date remain manual and unperformed',
    `Form audit version,${quote(audit.version)}`,
    'Input,Required,Validated,Reviewed value',
    ...audit.requirements.map((r) =>
      [
        r.key,
        r.required,
        r.satisfied,
        r.satisfied
          ? (facts.find((f) => f.key === r.key && f.reviewState === 'reviewed')
              ?.value.value ?? '')
          : 'MISSING OR UNREVIEWED',
      ]
        .map(quote)
        .join(','),
    ),
    ...audit.issues.map((i) => 'Form issue,' + quote(i)),
    `Unresolved form fields,${audit.unresolvedCount}`,
  ].join('\n');
};
const summaryFromRow = (row: Record<string, unknown>) =>
  FinanceTaxCalculationRunSummarySchema.parse({
    runId: row.id,
    caseId: row.case_id,
    taxSubjectId: row.tax_subject_id,
    snapshotRevision: row.snapshot_revision,
    snapshotHash: row.snapshot_hash,
    workflowId: row.workflow_id,
    packageVersion: row.package_version,
    packageHash: row.package_hash,
    inputHash: row.input_hash,
    outputHash: row.output_hash,
    status: row.status,
    complete: row.complete,
    createdBy: row.created_by,
    createdAt: new Date(String(row.created_at)).toISOString(),
  });
/** Trusted authenticated WorkspaceContext only. No method accepts a grant context or a replacement questionnaire. */
export class PostgresFinanceTaxRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: {
      evidenceCipher?: {
        decrypt(
          encrypted: unknown,
          scope: { workspaceId: string; bookId: string; documentId: string },
        ): Promise<unknown>;
      };
    } = {},
  ) {}
  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "select count(*)=12 and bool_and(c.relrowsecurity and c.relforcerowsecurity) as ready from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname=any($1::text[])",
        [
          [
            'finance_tax_subjects',
            'finance_tax_cases',
            'finance_tax_case_grants',
            'finance_tax_case_snapshots',
            'finance_tax_book_sources',
            'finance_tax_fact_sources',
            'finance_tax_receipts',
            'finance_tax_calculation_runs',
            'finance_tax_working_input_reviews',
            'finance_tax_run_schedules',
            'finance_tax_run_reviews',
            'finance_tax_wage_reviews',
          ],
        ],
      );
      const role = await client.query(
        'select rolbypassrls,rolsuper from pg_roles where rolname=current_user',
      );
      const functions = await client.query(
        "select to_regprocedure('emdo.tax_case_recovery_seed(uuid,uuid,integer)') is not null and to_regprocedure('emdo.lock_tax_case(uuid,uuid,text[],boolean)') is not null and to_regprocedure('emdo.next_tax_book_source_versions(uuid,uuid,uuid)') is not null and to_regprocedure('emdo.lock_tax_run_snapshot(uuid,uuid,integer)') is not null and to_regprocedure('emdo.tax_working_package_scope_supported(text,jsonb)') is not null and to_regprocedure('emdo.tax_wage_original(uuid,uuid,integer,uuid,uuid)') is not null and to_regprocedure('emdo.tax_wage_correction_schema_version()') is not null as ready",
      );
      return (
        result.rows[0]?.ready === true &&
        functions.rows[0]?.ready === true &&
        role.rows[0]?.rolbypassrls === false &&
        role.rows[0]?.rolsuper === false
      );
    } finally {
      client.release();
    }
  }
  private async transaction<T>(
    contextInput: WorkspaceContext,
    work: (client: DatabaseClient, context: WorkspaceContext) => Promise<T>,
  ): Promise<T> {
    const context = WorkspaceContextSchema.parse(contextInput);
    try {
      return await withDurableTransaction(
        this.pool,
        { ...context, householdId: context.workspaceId },
        { householdId: context.workspaceId },
        (client) => work(client, context),
      );
    } catch (error) {
      if (error instanceof FinanceTaxPersistenceError) throw error;
      const code =
        error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code === '42501' || code === 'authorization-revoked')
        fail('forbidden', 'case-forbidden');
      if (['23505', '23514', '40P01', '55P03'].includes(code))
        fail('conflict', 'revision-or-constraint-conflict');
      if (['23503', '23502', '22P02', '22003'].includes(code))
        fail('invalid-input', 'invalid-input');
      throw error;
    }
  }
  private async lockCase(
    client: DatabaseClient,
    context: WorkspaceContext,
    caseId: string,
    roles: string[],
    inputs = true,
  ): Promise<CaseRow> {
    UuidSchema.parse(caseId);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `tax-case:${context.workspaceId}:${caseId}`,
    ]);
    const allowed = (
      await client.query(
        'select emdo.lock_tax_case($1,$2,$3::text[],$4) as allowed',
        [context.workspaceId, caseId, roles, inputs],
      )
    ).rows[0]?.allowed;
    if (allowed !== true) fail('forbidden', 'case-or-source-forbidden');
    const row = (
      await client.query(
        'select c.id,c.workspace_id,c.tax_subject_id,c.current_revision,c.title,c.status,g.role as case_role from emdo.finance_tax_cases c join emdo.finance_tax_case_grants g on g.workspace_id=c.workspace_id and g.case_id=c.id and g.user_id=$3 and g.revoked_at is null where c.workspace_id=$1 and c.id=$2',
        [context.workspaceId, caseId, context.userId],
      )
    ).rows[0];
    if (!row) fail('forbidden', 'case-forbidden');
    return row as CaseRow;
  }
  private async snapshot(
    client: DatabaseClient,
    row: CaseRow,
    revision = row.current_revision,
  ) {
    const found = (
      await client.query(
        'select questionnaire,snapshot_hash from emdo.finance_tax_case_snapshots where workspace_id=$1 and case_id=$2 and revision=$3',
        [row.workspace_id, row.id, revision],
      )
    ).rows[0];
    if (!found) fail('forbidden', 'snapshot-forbidden');
    const questionnaire = FinanceTaxQuestionnaireSchema.parse(
      found.questionnaire,
    );
    if (hash(questionnaire) !== found.snapshot_hash)
      fail('conflict', 'snapshot-integrity');
    return { questionnaire, snapshotHash: String(found.snapshot_hash) };
  }
  private async declaredInputs(
    client: DatabaseClient,
    row: CaseRow,
    state: FinanceTaxQuestionnaire,
  ): Promise<{
    declaredInputs: FinanceTaxDeclaredInput[];
    declarationBindingStatus: 'bound' | 'legacy-unbound';
  }> {
    const bindings = state.declarationSourceBindings;
    if (bindings === undefined)
      return {
        declaredInputs: [],
        declarationBindingStatus: 'legacy-unbound' as const,
      };
    const result = await client.query(
      'select s.id as "sourceId",s.revision as "sourceRevision",s.fact_key as "factKey",s.category,s.value,s.content_hash as "contentHash" from emdo.finance_tax_fact_sources s join jsonb_to_recordset($3::jsonb) as b("sourceId" uuid,"sourceRevision" integer,"contentHash" text) on s.id=b."sourceId" and s.revision=b."sourceRevision" and s.content_hash=b."contentHash" where s.workspace_id=$1 and s.case_id=$2 and s.tax_subject_id=$4 order by s.id',
      [row.workspace_id, row.id, JSON.stringify(bindings), row.tax_subject_id],
    );
    if (result.rows.length !== bindings.length)
      fail('conflict', 'declaration-binding-integrity');
    const declaredInputs = result.rows.map((source) => {
      const parsed = FinanceTaxDeclaredInputSchema.parse({
        ...source,
        reviewState: 'unreviewed',
      });
      if (
        hash({
          factKey: parsed.factKey,
          category: parsed.category,
          value: parsed.value,
        }) !== parsed.contentHash
      )
        fail('conflict', 'declaration-content-integrity');
      return parsed;
    });
    return { declaredInputs, declarationBindingStatus: 'bound' as const };
  }
  private async access(
    client: DatabaseClient,
    context: WorkspaceContext,
    row: CaseRow,
  ): Promise<FinanceTaxQuestionnaireAccess> {
    const books = (
      await client.query(
        "select b.* from emdo.finance_tax_book_sources b join emdo.finance_tax_cases c on c.workspace_id=b.workspace_id and c.id=b.case_id join emdo.finance_tax_case_snapshots s on s.workspace_id=c.workspace_id and s.case_id=c.id and s.revision=c.current_revision where b.workspace_id=$1 and b.case_id=$2 and exists(select 1 from jsonb_array_elements(s.questionnaire->'sourceAuthorizationBindings') a where a->>'authorizationId'=b.id::text) order by b.book_id",
        [context.workspaceId, row.id],
      )
    ).rows;
    const sources = (
      await client.query(
        'select distinct on(id) id,revision,content_hash from emdo.finance_tax_fact_sources where workspace_id=$1 and case_id=$2 order by id,revision desc',
        [context.workspaceId, row.id],
      )
    ).rows;
    return {
      caseId: row.id,
      workspaceId: context.workspaceId,
      taxSubjectId: row.tax_subject_id,
      actorId: context.userId,
      bookAuthorizations: books.map((b) => ({
        authorizationId: String(b.id),
        authorizationRevision: Number(b.authorization_revision),
        bookId: String(b.book_id),
        snapshotRevision: Number(b.snapshot_revision),
        snapshotHash: String(b.snapshot_hash),
      })),
      availableSources: [
        ...sources.map((s) => ({
          kind: 'declaration' as const,
          reference: `declaration:${s.id}`,
          revision: Number(s.revision),
          contentHash: String(s.content_hash),
        })),
        ...books.map((b) => ({
          kind: 'ledger-snapshot' as const,
          reference: `tax-book-snapshot:${b.id}`,
          revision: Number(b.snapshot_revision),
          contentHash: String(b.snapshot_hash),
          sourceBookId: String(b.book_id),
        })),
      ],
    };
  }
  private async writeSnapshot(
    client: DatabaseClient,
    context: WorkspaceContext,
    row: CaseRow,
    state: unknown,
    previousHash: string | null,
  ) {
    const questionnaire = FinanceTaxQuestionnaireSchema.parse(state);
    if (questionnaire.intake.revision !== row.current_revision + 1)
      fail('conflict', 'case-revision-conflict');
    const snapshotHash = hash(questionnaire);
    await client.query(
      'insert into emdo.finance_tax_case_snapshots(workspace_id,case_id,tax_subject_id,revision,questionnaire,snapshot_hash,previous_snapshot_hash,created_by) values($1,$2,$3,$4,$5::jsonb,$6,$7,$8)',
      [
        context.workspaceId,
        row.id,
        row.tax_subject_id,
        questionnaire.intake.revision,
        JSON.stringify(questionnaire),
        snapshotHash,
        previousHash,
        context.userId,
      ],
    );
    const updated = await client.query(
      'update emdo.finance_tax_cases set current_revision=$3 where workspace_id=$1 and id=$2 and current_revision=$4 returning current_revision',
      [
        context.workspaceId,
        row.id,
        questionnaire.intake.revision,
        row.current_revision,
      ],
    );
    if (updated.rows.length !== 1) fail('conflict', 'case-revision-conflict');
    return {
      caseId: row.id,
      taxSubjectId: row.tax_subject_id,
      revision: questionnaire.intake.revision,
      snapshotHash,
      status: 'incomplete' as const,
    };
  }
  private async receipt<T>(
    client: DatabaseClient,
    context: WorkspaceContext,
    key: string,
    command: unknown,
    work: () => Promise<{ caseId: string } & T>,
  ): Promise<{ caseId: string } & T> {
    Key.parse(key);
    const commandHash = hash(command);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `tax-receipt:${context.workspaceId}:${context.userId}:${key}`,
    ]);
    const prior = (
      await client.query(
        'select command_hash,response from emdo.finance_tax_receipts where workspace_id=$1 and user_id=$2 and idempotency_key=$3',
        [context.workspaceId, context.userId, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.command_hash !== commandHash)
        fail('conflict', 'idempotency-conflict');
      return prior.response as { caseId: string } & T;
    }
    const response = await work();
    await client.query(
      'insert into emdo.finance_tax_receipts(workspace_id,user_id,idempotency_key,case_id,command_hash,response) values($1,$2,$3,$4,$5,$6::jsonb)',
      [
        context.workspaceId,
        context.userId,
        key,
        response.caseId,
        commandHash,
        JSON.stringify(response),
      ],
    );
    return response;
  }
  private async assertLegalEntityAccess(
    client: DatabaseClient,
    scope: WorkspaceContext,
    legalEntityId: string,
  ) {
    const book = (
      await client.query(
        `select b.id from emdo.finance_entities e
         join emdo.finance_books b on b.workspace_id=e.workspace_id and b.entity_id=e.id
         where e.workspace_id=$1 and e.id=$2
           and emdo.finance_book_access(b.workspace_id,b.id)
         order by b.id limit 1`,
        [scope.workspaceId, legalEntityId],
      )
    ).rows[0];
    if (!book) fail('forbidden', 'tax-legal-entity-forbidden');
    const locked = (
      await client.query(
        'select emdo.lock_finance_book_grant($1,$2) as allowed',
        [scope.workspaceId, book.id],
      )
    ).rows[0];
    if (locked?.allowed !== true)
      fail('forbidden', 'tax-legal-entity-forbidden');
  }
  async createCase(context: WorkspaceContext, key: string, raw: unknown) {
    const input = CreatePrivateTaxCaseSchema.parse(raw);
    const intakeOnly = 'mode' in input && input.mode === 'intake-only';
    const packageBinding =
      'packageId' in input ? input : FINANCE_TAX_INTAKE_ONLY_BINDING;
    return this.transaction(context, (client, scope) =>
      this.receipt(
        client,
        scope,
        key,
        { operation: 'create-case', input },
        async () => {
          if (input.legalEntityId) {
            await this.assertLegalEntityAccess(
              client,
              scope,
              input.legalEntityId,
            );
          }
          const caseId = randomUUID(),
            taxSubjectId = randomUUID();
          await client.query(
            'insert into emdo.finance_tax_subjects(id,workspace_id,display_name,taxpayer_type,created_by) values($1,$2,$3,$4,$5)',
            [
              taxSubjectId,
              scope.workspaceId,
              input.taxSubjectName,
              input.scope.taxpayerType,
              scope.userId,
            ],
          );
          await client.query(
            'insert into emdo.finance_tax_cases(id,workspace_id,tax_subject_id,title,created_by) values($1,$2,$3,$4,$5)',
            [
              caseId,
              scope.workspaceId,
              taxSubjectId,
              input.title,
              scope.userId,
            ],
          );
          const row = await this.lockCase(client, scope, caseId, Roles.owner);
          const questionnaire = await createFinanceTaxQuestionnaire(
            {
              intake: {
                schemaVersion: 1,
                caseId,
                workspaceId: scope.workspaceId,
                taxSubjectId,
                legalEntityId: input.legalEntityId ?? null,
                sourceBooks: [],
                revision: 1,
                scope: input.scope,
                domesticResident: input.domesticResident,
                hasCrossBorderActivity: input.hasCrossBorderActivity,
                standaloneCorporation: input.standaloneCorporation,
                requestedFeatures: ['income-tax-return'],
                facts: [],
              },
              packageId: packageBinding.packageId,
              packageVersion: packageBinding.packageVersion,
              questionMetadata: [],
              relatedParties: input.relatedParties,
            },
            await this.access(client, scope, row),
            FINANCE_TAX_PACKAGE_REGISTRY,
          );
          return this.writeSnapshot(
            client,
            scope,
            row,
            intakeOnly
              ? {
                  ...questionnaire,
                  binding: {
                    ...questionnaire.binding,
                    ...FINANCE_TAX_INTAKE_ONLY_BINDING,
                  },
                }
              : questionnaire,
            null,
          );
        },
      ),
    );
  }
  async bindLegalEntity(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    raw: unknown,
  ) {
    const input = BindPrivateTaxLegalEntitySchema.parse(raw);
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.owner);
      // Recheck access even for a receipt replay; binding never grants access to book facts.
      await this.assertLegalEntityAccess(client, scope, input.legalEntityId);
      return this.receipt(
        client,
        scope,
        key,
        { operation: 'bind-legal-entity', caseId, input },
        async () => {
          if (row.current_revision !== input.expectedCaseRevision)
            fail('conflict', 'case-revision-conflict');
          const saved = await this.snapshot(client, row);
          if (saved.questionnaire.intake.legalEntityId !== null)
            fail('conflict', 'tax-legal-entity-already-bound');
          // A new taxpayer/entity binding invalidates prior review decisions,
          // while the preceding immutable snapshot retains those decisions.
          const answers = saved.questionnaire.answers.map((answer) => ({
            ...answer,
            fact: { ...answer.fact, reviewState: 'unreviewed' as const },
            revision: answer.revision + 1,
            updatedAt: new Date().toISOString(),
            previousRevisionHash: hash(answer),
            review: null,
          }));
          return this.writeSnapshot(
            client,
            scope,
            row,
            {
              ...saved.questionnaire,
              answers,
              intake: {
                ...saved.questionnaire.intake,
                revision: row.current_revision + 1,
                legalEntityId: input.legalEntityId,
                facts: saved.questionnaire.intake.facts.map((fact) => ({
                  ...fact,
                  reviewState: 'unreviewed' as const,
                })),
              },
            },
            saved.snapshotHash,
          );
        },
      );
    });
  }
  async resetInputsAfterSourceRevocation(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    raw: unknown,
  ) {
    const input = ResetPrivateTaxInputsSchema.parse(raw);
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(
        client,
        scope,
        caseId,
        Roles.owner,
        false,
      );
      return this.receipt(
        client,
        scope,
        key,
        { operation: 'reset-inputs-after-source-revocation', caseId, input },
        async () => {
          const seed = (
            await client.query(
              'select * from emdo.tax_case_recovery_seed($1,$2,$3)',
              [scope.workspaceId, caseId, input.expectedCaseRevision],
            )
          ).rows[0];
          if (!seed) fail('forbidden', 'recovery-forbidden');
          return this.writeSnapshot(
            client,
            scope,
            row,
            seed.questionnaire,
            String(seed.previous_hash),
          );
        },
      );
    });
  }
  async listCases(context: WorkspaceContext, offset = 0, limit = 50) {
    z.number().int().min(0).max(100000).parse(offset);
    z.number().int().min(1).max(100).parse(limit);
    return this.transaction(
      context,
      async (client, scope) =>
        (
          await client.query(
            'select c.id as "caseId",c.tax_subject_id as "taxSubjectId",c.title,c.current_revision as revision,c.status,s.display_name as "taxSubjectName",g.role as "caseRole" from emdo.finance_tax_cases c join emdo.finance_tax_subjects s on s.workspace_id=c.workspace_id and s.id=c.tax_subject_id join emdo.finance_tax_case_grants g on g.workspace_id=c.workspace_id and g.case_id=c.id and g.user_id=$4 and g.revoked_at is null where c.workspace_id=$1 order by c.created_at desc,c.id offset $2 limit $3',
            [scope.workspaceId, offset, limit, scope.userId],
          )
        ).rows,
    );
  }
  async getCase(context: WorkspaceContext, caseId: string, revision?: number) {
    if (revision !== undefined) Revision.parse(revision);
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.read);
      const saved = await this.snapshot(client, row, revision);
      return {
        ...saved,
        ...(await this.declaredInputs(client, row, saved.questionnaire)),
        caseId: row.id,
        taxSubjectId: row.tax_subject_id,
        currentRevision: row.current_revision,
        caseRole: row.case_role,
        status: 'incomplete' as const,
      };
    });
  }
  async assessCase(context: WorkspaceContext, caseId: string) {
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.read);
      const saved = await this.snapshot(client, row);
      const assessment = await assessFinanceTaxQuestionnaire(
        saved.questionnaire,
        await this.access(client, scope, row),
        FINANCE_TAX_PACKAGE_REGISTRY,
      );
      return {
        ...assessment,
        caseId: row.id,
        taxSubjectId: row.tax_subject_id,
        snapshotRevision: row.current_revision,
        snapshotHash: saved.snapshotHash,
      };
    });
  }
  async listCaseGrants(context: WorkspaceContext, caseId: string) {
    return this.transaction(context, async (client, scope) => {
      await this.lockCase(client, scope, caseId, Roles.owner, false);
      return (
        await client.query(
          'select user_id as "userId",role,revision,revoked_at as "revokedAt",case when revoked_at is null then \'active\' else \'revoked\' end as status from emdo.finance_tax_case_grants where workspace_id=$1 and case_id=$2 order by user_id',
          [scope.workspaceId, caseId],
        )
      ).rows;
    });
  }
  async grantCaseAccess(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    raw: unknown,
  ) {
    const input = GrantPrivateTaxCaseSchema.parse(raw);
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(
        client,
        scope,
        caseId,
        Roles.owner,
        false,
      );
      return this.receipt(
        client,
        scope,
        key,
        { operation: 'grant-case', caseId, input },
        async () => {
          if (input.userId === scope.userId)
            fail('invalid-input', 'owner-grant-immutable');
          const member = (
            await client.query(
              'select emdo.tax_case_grantee_current($1,$2,$3) as allowed',
              [scope.workspaceId, caseId, input.userId],
            )
          ).rows[0];
          if (member?.allowed !== true)
            fail('invalid-input', 'grant-member-required');
          const existing = (
            await client.query(
              'select revision from emdo.finance_tax_case_grants where workspace_id=$1 and case_id=$2 and user_id=$3',
              [scope.workspaceId, caseId, input.userId],
            )
          ).rows[0];
          if (
            (existing ? Number(existing.revision) : null) !==
            input.expectedGrantRevision
          )
            fail('conflict', 'grant-revision-conflict');
          const values = [scope.workspaceId, caseId, input.userId, input.role];
          const result = existing
            ? await client.query(
                'update emdo.finance_tax_case_grants set role=$4,revoked_at=null where workspace_id=$1 and case_id=$2 and user_id=$3 returning revision',
                values,
              )
            : await client.query(
                'insert into emdo.finance_tax_case_grants(workspace_id,case_id,user_id,role,tax_subject_id) values($1,$2,$3,$4,$5) returning revision',
                [...values, row.tax_subject_id],
              );
          return { caseId, revision: Number(result.rows[0]!.revision) };
        },
      );
    });
  }
  async revokeCaseAccess(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    raw: unknown,
  ) {
    const input = RevokePrivateTaxCaseGrantSchema.parse(raw);
    return this.transaction(context, async (client, scope) => {
      await this.lockCase(client, scope, caseId, Roles.owner, false);
      return this.receipt(
        client,
        scope,
        key,
        { operation: 'revoke-case', caseId, input },
        async () => {
          if (input.userId === scope.userId)
            fail('invalid-input', 'owner-grant-immutable');
          const result = await client.query(
            'update emdo.finance_tax_case_grants set revoked_at=clock_timestamp() where workspace_id=$1 and case_id=$2 and user_id=$3 and revision=$4 and revoked_at is null returning revision',
            [
              scope.workspaceId,
              caseId,
              input.userId,
              input.expectedGrantRevision,
            ],
          );
          if (!result.rows.length) fail('conflict', 'grant-revision-conflict');
          return { caseId, revision: Number(result.rows[0]!.revision) };
        },
      );
    });
  }
  async recordDeclaration(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    raw: unknown,
  ) {
    const input = RecordPrivateTaxDeclarationSchema.parse(raw);
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.edit);
      return this.receipt(
        client,
        scope,
        key,
        { operation: 'record-declaration', caseId, input },
        async () => {
          if (row.current_revision !== input.expectedCaseRevision)
            fail('conflict', 'case-revision-conflict');
          const sourceId = input.sourceId ?? randomUUID();
          const prior = input.sourceId
            ? (
                await client.query(
                  'select revision,fact_key from emdo.finance_tax_fact_sources where workspace_id=$1 and case_id=$2 and id=$3 order by revision desc limit 1',
                  [scope.workspaceId, caseId, sourceId],
                )
              ).rows[0]
            : null;
          if (
            (prior ? Number(prior.revision) : null) !==
              input.expectedSourceRevision ||
            (!!input.sourceId && !prior)
          )
            fail('conflict', 'source-revision-conflict');
          if (prior && prior.fact_key !== input.factKey)
            fail('invalid-input', 'source-fact-key-immutable');
          const sourceRevision = (prior ? Number(prior.revision) : 0) + 1,
            contentHash = hash({
              factKey: input.factKey,
              category: input.category,
              value: input.value,
            });
          await client.query(
            'insert into emdo.finance_tax_fact_sources(id,workspace_id,case_id,tax_subject_id,revision,fact_key,category,value,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)',
            [
              sourceId,
              scope.workspaceId,
              caseId,
              row.tax_subject_id,
              sourceRevision,
              input.factKey,
              input.category,
              JSON.stringify(input.value),
              contentHash,
              scope.userId,
            ],
          );
          const saved = await this.snapshot(client, row);
          const next = {
            ...saved.questionnaire,
            declarationSourceBindings: [
              ...(saved.questionnaire.declarationSourceBindings ?? []).filter(
                (b) => b.sourceId !== sourceId,
              ),
              { sourceId, sourceRevision, contentHash },
            ],
            intake: {
              ...saved.questionnaire.intake,
              revision: row.current_revision + 1,
            },
          };
          return {
            ...(await this.writeSnapshot(
              client,
              scope,
              row,
              next,
              saved.snapshotHash,
            )),
            sourceId,
            sourceRevision,
            contentHash,
          };
        },
      );
    });
  }
  async listDeclarations(context: WorkspaceContext, caseId: string) {
    return this.transaction(context, async (client, scope) => {
      await this.lockCase(client, scope, caseId, Roles.read);
      return (
        await client.query(
          'select distinct on(id) id as "sourceId",revision as "sourceRevision",fact_key as "factKey",category,value,content_hash as "contentHash" from emdo.finance_tax_fact_sources where workspace_id=$1 and case_id=$2 order by id,revision desc',
          [scope.workspaceId, caseId],
        )
      ).rows;
    });
  }
  async authorizeBookSource(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    raw: unknown,
  ) {
    const input = AuthorizePrivateTaxBookSourceSchema.parse(raw);
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.owner);
      return this.receipt(
        client,
        scope,
        key,
        { operation: 'authorize-book-source', caseId, input },
        async () => {
          if (row.current_revision !== input.expectedCaseRevision)
            fail('conflict', 'case-revision-conflict');
          const allowed = (
            await client.query(
              'select emdo.lock_finance_book_grant($1,$2) as allowed',
              [scope.workspaceId, input.bookId],
            )
          ).rows[0]?.allowed;
          if (allowed !== true) fail('forbidden', 'book-forbidden');
          await client.query(
            'select pg_advisory_xact_lock(hashtextextended($1,0))',
            [`${scope.workspaceId}:${input.bookId}`],
          );
          const grant = (
            await client.query(
              'select revision from emdo.finance_book_grants where workspace_id=$1 and book_id=$2 and user_id=$3 and revoked_at is null',
              [scope.workspaceId, input.bookId, scope.userId],
            )
          ).rows[0];
          if (!grant) fail('forbidden', 'book-forbidden');
          const versions = (
            await client.query(
              'select * from emdo.next_tax_book_source_versions($1,$2,$3)',
              [scope.workspaceId, caseId, input.bookId],
            )
          ).rows[0];
          if (!versions) fail('forbidden', 'book-source-version-forbidden');
          const authorizationRevision = Number(versions.authorization_revision),
            snapshotRevision = Number(versions.snapshot_revision);
          const journals = (
            await client.query(
              "select j.id,j.effective_on::text,j.description,coalesce((select jsonb_agg(jsonb_build_object('accountId',l.account_id,'side',l.side,'amount',l.amount::text,'currency',l.currency,'nativeAmount',l.native_amount::text,'fxRate',l.fx_rate::text) order by l.line_number) from emdo.finance_journal_lines l where l.journal_id=j.id),'[]'::jsonb) as lines from emdo.finance_journals j where j.workspace_id=$1 and j.book_id=$2 and j.status='posted' order by j.effective_on,j.id limit 10001",
              [scope.workspaceId, input.bookId],
            )
          ).rows;
          if (journals.length > 10000)
            fail('invalid-input', 'source-snapshot-too-large');
          const snapshot = {
              kind: 'posted-ledger-input-snapshot',
              bookId: input.bookId,
              journals,
            },
            snapshotHash = hash(snapshot),
            authorizationId = randomUUID();
          if (Buffer.byteLength(JSON.stringify(snapshot)) > 8_000_000)
            fail('invalid-input', 'source-snapshot-too-large');
          await client.query(
            'insert into emdo.finance_tax_book_sources(id,workspace_id,case_id,tax_subject_id,book_id,authorized_by,book_grant_revision,snapshot_hash,snapshot,authorization_revision,snapshot_revision) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)',
            [
              authorizationId,
              scope.workspaceId,
              caseId,
              row.tax_subject_id,
              input.bookId,
              scope.userId,
              grant.revision,
              snapshotHash,
              JSON.stringify(snapshot),
              authorizationRevision,
              snapshotRevision,
            ],
          );
          const saved = await this.snapshot(client, row),
            book = { bookId: input.bookId, snapshotRevision, snapshotHash };
          const next = {
            ...saved.questionnaire,
            intake: {
              ...saved.questionnaire.intake,
              revision: row.current_revision + 1,
              sourceBooks: [...saved.questionnaire.intake.sourceBooks, book],
            },
            sourceAuthorizationBindings: [
              ...saved.questionnaire.sourceAuthorizationBindings,
              { ...book, authorizationId, authorizationRevision },
            ],
          };
          return {
            ...(await this.writeSnapshot(
              client,
              scope,
              row,
              next,
              saved.snapshotHash,
            )),
            authorizationId,
            authorizationRevision,
            snapshotRevision,
          };
        },
      );
    });
  }
  async revokeBookSource(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    authorizationId: string,
    expectedAuthorizationRevision: number,
  ) {
    UuidSchema.parse(authorizationId);
    Revision.parse(expectedAuthorizationRevision);
    return this.transaction(context, async (client, scope) => {
      await this.lockCase(client, scope, caseId, Roles.owner, false);
      return this.receipt(
        client,
        scope,
        key,
        {
          operation: 'revoke-book-source',
          caseId,
          authorizationId,
          expectedAuthorizationRevision,
        },
        async () => {
          const changed = await client.query(
            'update emdo.finance_tax_book_sources set revoked_at=clock_timestamp() where workspace_id=$1 and case_id=$2 and id=$3 and authorization_revision=$4 and revoked_at is null returning authorization_revision',
            [
              scope.workspaceId,
              caseId,
              authorizationId,
              expectedAuthorizationRevision,
            ],
          );
          if (!changed.rows.length)
            fail('conflict', 'source-revision-conflict');
          return {
            caseId,
            authorizationRevision: Number(
              changed.rows[0]!.authorization_revision,
            ),
          };
        },
      );
    });
  }
  async saveAnswer(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    raw: unknown,
  ) {
    const input = SavePrivateTaxAnswerSchema.parse(raw);
    return this.editAnswer(
      context,
      caseId,
      key,
      'save-answer',
      input,
      Roles.edit,
      async (client, scope, row, state, access) => {
        const source = (
          await client.query(
            'select * from emdo.finance_tax_fact_sources where workspace_id=$1 and case_id=$2 and id=$3 order by revision desc limit 1',
            [scope.workspaceId, caseId, input.sourceId],
          )
        ).rows[0];
        if (!source || Number(source.revision) !== input.expectedSourceRevision)
          fail('conflict', 'source-revision-conflict');
        return saveFinanceTaxQuestionnaireAnswer(
          state,
          {
            caseId,
            workspaceId: scope.workspaceId,
            taxSubjectId: row.tax_subject_id,
            expectedCaseRevision: input.expectedCaseRevision,
            expectedAnswerRevision: input.expectedAnswerRevision,
            relatedPartyId: input.relatedPartyId,
            updatedAt: new Date().toISOString(),
            fact: {
              key: source.fact_key,
              value: source.value,
              reviewState: 'unreviewed',
              source: {
                kind: 'declaration',
                reference: `declaration:${source.id}`,
                revision: Number(source.revision),
                contentHash: source.content_hash,
              },
            },
          },
          access,
        );
      },
    );
  }
  async reviewAnswer(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    raw: unknown,
  ) {
    const input = ReviewPrivateTaxAnswerSchema.parse(raw);
    return this.editAnswer(
      context,
      caseId,
      key,
      'review-answer',
      input,
      Roles.review,
      async (_client, scope, row, state, access) =>
        reviewFinanceTaxQuestionnaireAnswer(
          state,
          {
            ...input,
            caseId,
            workspaceId: scope.workspaceId,
            taxSubjectId: row.tax_subject_id,
            reviewedAt: new Date().toISOString(),
          },
          access,
        ),
    );
  }
  async withdrawAnswer(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    raw: unknown,
  ) {
    const input = WithdrawPrivateTaxAnswerSchema.parse(raw);
    return this.editAnswer(
      context,
      caseId,
      key,
      'withdraw-answer',
      input,
      Roles.edit,
      async (_client, scope, row, state, access) =>
        withdrawFinanceTaxQuestionnaireAnswer(
          state,
          {
            ...input,
            caseId,
            workspaceId: scope.workspaceId,
            taxSubjectId: row.tax_subject_id,
            withdrawnAt: new Date().toISOString(),
          },
          access,
        ),
    );
  }
  private async editAnswer(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    operation: string,
    input: { expectedCaseRevision: number },
    roles: string[],
    work: (
      client: DatabaseClient,
      context: WorkspaceContext,
      row: CaseRow,
      state: FinanceTaxQuestionnaire,
      access: FinanceTaxQuestionnaireAccess,
    ) => Promise<unknown>,
  ) {
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, roles);
      return this.receipt(
        client,
        scope,
        key,
        { operation, caseId, input },
        async () => {
          if (input.expectedCaseRevision !== row.current_revision)
            fail('conflict', 'case-revision-conflict');
          const saved = await this.snapshot(client, row);
          const state = await work(
            client,
            scope,
            row,
            saved.questionnaire,
            await this.access(client, scope, row),
          );
          return this.writeSnapshot(
            client,
            scope,
            row,
            state,
            saved.snapshotHash,
          );
        },
      );
    });
  }

  private async lockRunSnapshot(
    client: DatabaseClient,
    scope: WorkspaceContext,
    caseId: string,
    revision: number,
  ) {
    const allowed = (
      await client.query(
        'select emdo.lock_tax_run_snapshot($1,$2,$3) as allowed',
        [scope.workspaceId, caseId, revision],
      )
    ).rows[0]?.allowed;
    if (allowed !== true) fail('source-revoked', 'run-source-forbidden');
  }
  private assertWorkingPackage(input: {
    workflowId: string;
    expectedPackageVersion: string;
  }) {
    if (
      ![
        workingAdapter('individual'),
        workingAdapter('corporation'),
        workingAdapter('sole-proprietor', 'US'),
        workingAdapter('sole-proprietor', 'US', 'US-NY'),
        workingAdapter('individual', 'MX', 'MX-FED'),
      ].some(
        (a) =>
          a.workflowId === input.workflowId &&
          a.packageVersion === input.expectedPackageVersion,
      )
    )
      fail('conflict', 'working-package-version-conflict');
  }
  private async workingInputReviews(
    client: DatabaseClient,
    row: CaseRow,
    revision: number,
    packageHash = WorkingPackageHash,
  ) {
    return (
      await client.query(
        'select source_id as "sourceId",source_revision as "sourceRevision",source_hash as "contentHash",created_by as "reviewedBy",created_at as "reviewedAt" from emdo.finance_tax_working_input_reviews where workspace_id=$1 and case_id=$2 and snapshot_revision=$3 and package_hash=$4 order by source_id',
        [row.workspace_id, row.id, revision, packageHash],
      )
    ).rows.map((r) => ({
      sourceId: String(r.sourceId),
      sourceRevision: Number(r.sourceRevision),
      contentHash: String(r.contentHash),
      reviewedBy: String(r.reviewedBy),
      reviewedAt: new Date(String(r.reviewedAt)).toISOString(),
    }));
  }
  async getWorkingPaperPreparation(context: WorkspaceContext, caseId: string) {
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.read);
      const saved = await this.snapshot(client, row);
      const adapter = workingAdapter(
        saved.questionnaire.intake.scope.taxpayerType,
        saved.questionnaire.intake.scope.country,
        saved.questionnaire.intake.scope.subdivision,
      );
      return FinanceTaxWorkingPaperPreparationSchema.parse({
        scopeSupported: adapter.scopes.some(
          (s) => hash(s) === hash(saved.questionnaire.intake.scope),
        ),
        supportedScopes: adapter.scopes,
        caseId,
        taxSubjectId: row.tax_subject_id,
        snapshotRevision: row.current_revision,
        snapshotHash: saved.snapshotHash,
        workflowId: adapter.workflowId,
        packageVersion: adapter.packageVersion,
        packageHash: adapter.packageHash,
        complete: false,
        questions: adapter.questions,
        inputReviews: await this.workingInputReviews(
          client,
          row,
          row.current_revision,
          adapter.packageHash,
        ),
      });
    });
  }
  async reviewWorkingPaperInputs(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    raw: unknown,
  ) {
    const input = ReviewPrivateTaxWorkingInputsSchema.parse(raw);
    input.inputs.sort((a, b) =>
      a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0,
    );
    this.assertWorkingPackage(input);
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.review);
      await this.lockRunSnapshot(
        client,
        scope,
        caseId,
        input.expectedCaseRevision,
      );
      return this.receipt(
        client,
        scope,
        key,
        { operation: 'review-working-inputs', caseId, input },
        async () => {
          if (row.current_revision !== input.expectedCaseRevision)
            fail('conflict', 'case-revision-conflict');
          const saved = await this.snapshot(client, row);
          const adapter = workingAdapter(
            saved.questionnaire.intake.scope.taxpayerType,
            saved.questionnaire.intake.scope.country,
            saved.questionnaire.intake.scope.subdivision,
          );
          if (input.workflowId !== adapter.workflowId)
            fail('invalid-input', 'working-case-package-mismatch');
          if (saved.snapshotHash !== input.expectedSnapshotHash)
            fail('conflict', 'snapshot-hash-conflict');
          if (
            !adapter.scopes.some(
              (s) => hash(s) === hash(saved.questionnaire.intake.scope),
            )
          )
            fail('invalid-input', 'unsupported-working-scope');
          const declared = await this.declaredInputs(
            client,
            row,
            saved.questionnaire,
          );
          for (const binding of input.inputs) {
            const fact = declared.declaredInputs.find(
              (f) =>
                f.sourceId === binding.sourceId &&
                f.sourceRevision === binding.sourceRevision &&
                f.contentHash === binding.contentHash,
            );
            const question = adapter.questions.find(
              (q) => q.key === fact?.factKey,
            );
            if (!fact || !question || question.type !== fact.value.type)
              fail(
                'invalid-input',
                'working-input-source-or-question-mismatch',
              );
            await client.query(
              'insert into emdo.finance_tax_working_input_reviews(workspace_id,case_id,tax_subject_id,snapshot_revision,source_id,source_revision,source_hash,snapshot_hash,workflow_id,package_version,package_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing',
              [
                scope.workspaceId,
                caseId,
                row.tax_subject_id,
                row.current_revision,
                binding.sourceId,
                binding.sourceRevision,
                binding.contentHash,
                saved.snapshotHash,
                adapter.workflowId,
                adapter.packageVersion,
                adapter.packageHash,
                scope.userId,
              ],
            );
          }
          return {
            caseId,
            snapshotRevision: row.current_revision,
            snapshotHash: saved.snapshotHash,
            reviewedInputCount: input.inputs.length,
            complete: false,
          };
        },
      );
    });
  }
  async getWageEvidencePreparation(context: WorkspaceContext, caseId: string) {
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.read),
        saved = await this.snapshot(client, row);
      const adapter = workingAdapter(
        saved.questionnaire.intake.scope.taxpayerType,
        saved.questionnaire.intake.scope.country,
        saved.questionnaire.intake.scope.subdivision,
      );
      const wagePackageHash =
        adapter.workflowId === NY_PRIVATE_WORKFLOW_ID
          ? NY_PRIVATE_PACKAGE_HASH
          : US_PRIVATE_PACKAGE_HASH;
      const documents = (
        await client.query(
          'select emdo.tax_wage_documents($1,$2,$3) as documents',
          [scope.workspaceId, caseId, row.current_revision],
        )
      ).rows[0]?.documents;
      const r = (
        await client.query(
          'select * from emdo.finance_tax_wage_reviews where workspace_id=$1 and case_id=$2 and snapshot_revision=$3 and package_hash=$4 order by created_at desc,id desc limit 1',
          [scope.workspaceId, caseId, row.current_revision, wagePackageHash],
        )
      ).rows[0];
      return FinanceTaxWageEvidencePreparationSchema.parse({
        caseId,
        snapshotRevision: row.current_revision,
        snapshotHash: saved.snapshotHash,
        documents,
        review: r
          ? {
              reviewId: r.id,
              caseId,
              snapshotRevision: r.snapshot_revision,
              snapshotHash: r.snapshot_hash,
              sourceId: r.source_id,
              sourceRevision: r.source_revision,
              contentHash: r.source_hash,
              manifestHash: r.manifest_hash,
              documentCount: (r.manifest as { artifacts: unknown[] }).artifacts
                .length,
              reviewedBy: r.created_by,
              reviewedAt: new Date(String(r.created_at)).toISOString(),
            }
          : null,
      });
    });
  }
  async getWageOriginal(
    context: WorkspaceContext,
    caseId: string,
    bookId: string,
    evidenceId: string,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(evidenceId);
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.read);
      const original = await this.wageOriginal(
        client,
        scope,
        caseId,
        row.current_revision,
        bookId,
        evidenceId,
      );
      return {
        filename: original.filename,
        format: original.format,
        contentHash: original.contentHash,
        sourceBase64: original.bytes.toString('base64'),
      };
    });
  }

  private async wageOriginal(
    client: DatabaseClient,
    scope: WorkspaceContext,
    caseId: string,
    revision: number,
    bookId: string,
    evidenceId: string,
  ) {
    const raw = (
      await client.query(
        'select emdo.tax_wage_original($1,$2,$3,$4,$5) as original',
        [scope.workspaceId, caseId, revision, bookId, evidenceId],
      )
    ).rows[0]?.original;
    const original = z
      .strictObject({
        encryptedOriginal: z.unknown(),
        contentHash: z.string(),
        byteSize: z.number(),
        format: z.string(),
        filename: z.string(),
      })
      .parse(raw);
    const cipher = this.options.evidenceCipher;
    if (!cipher) fail('conflict', 'wage-original-decryption-unavailable');
    const decoded = await cipher!.decrypt(original.encryptedOriginal, {
      workspaceId: scope.workspaceId,
      bookId,
      documentId: evidenceId,
    });
    const data = z
      .strictObject({ sourceBase64: z.string().max(2796204) })
      .parse(decoded);
    const bytes = Buffer.from(data.sourceBase64, 'base64');
    if (
      bytes.toString('base64') !== data.sourceBase64 ||
      bytes.length !== original.byteSize ||
      createHash('sha256').update(bytes).digest('hex') !== original.contentHash
    )
      fail('conflict', 'wage-original-integrity');
    return { ...original, bytes };
  }
  async reviewWageEvidence(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    raw: unknown,
  ) {
    const input = ReviewPrivateTaxWageEvidenceSchema.parse(raw);
    this.assertWorkingPackage(input);
    if (
      input.workflowId !== UsWorkflowId &&
      input.workflowId !== NY_PRIVATE_WORKFLOW_ID
    )
      fail('invalid-input', 'wage-package-unsupported');
    const isNewYork = input.workflowId === NY_PRIVATE_WORKFLOW_ID;
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.review);
      return this.receipt(
        client,
        scope,
        key,
        { operation: 'review-wage-evidence', caseId, input },
        async () => {
          const saved = await this.snapshot(client, row);
          if (
            row.current_revision !== input.expectedCaseRevision ||
            saved.snapshotHash !== input.expectedSnapshotHash
          )
            fail('conflict', 'wage-snapshot-conflict');
          const expectedScope = isNewYork
            ? NY_PRIVATE_SCOPE
            : US_2025_CANDIDATE.scope;
          const wagePackageHash = isNewYork
            ? NY_PRIVATE_PACKAGE_HASH
            : US_PRIVATE_PACKAGE_HASH;
          if (hash(saved.questionnaire.intake.scope) !== hash(expectedScope))
            fail('invalid-input', 'wage-scope-unsupported');
          await this.lockRunSnapshot(
            client,
            scope,
            caseId,
            row.current_revision,
          );
          const { declaredInputs } = await this.declaredInputs(
            client,
            row,
            saved.questionnaire,
          );
          const source = declaredInputs.find(
            (f) =>
              f.sourceId === input.input.sourceId &&
              f.sourceRevision === input.input.sourceRevision &&
              f.contentHash === input.input.contentHash &&
              f.factKey === 'wageEvidence.documents',
          );
          const reviews = await this.workingInputReviews(
            client,
            row,
            row.current_revision,
            wagePackageHash,
          );
          if (
            !source ||
            source.value.type !== 'text' ||
            !reviews.some(
              (r) =>
                r.sourceId === source.sourceId &&
                r.sourceRevision === source.sourceRevision &&
                r.contentHash === source.contentHash,
            )
          )
            fail('conflict', 'wage-extraction-exact-review-required');
          const extraction = parseWageExtraction(source!.value.value);
          const reviewId = randomUUID(),
            reviewedAt = new Date().toISOString();
          const artifacts: Omit<UsReviewedWageArtifact, 'bytes'>[] = [];
          const trustedArtifacts: UsReviewedWageArtifact[] = [];
          for (const d of extraction.documents) {
            if (
              extraction.schemaVersion === 1 &&
              (d.form !== 'W-2' || d.originalEvidenceId !== null)
            )
              fail('invalid-input', 'wage-correction-extraction-not-supported');
            const original = await this.wageOriginal(
              client,
              scope,
              caseId,
              row.current_revision,
              d.bookId,
              d.evidenceId,
            );
            const metadata: Omit<UsReviewedWageArtifact, 'bytes'> = {
              artifactId: d.evidenceId,
              workspaceId: scope.workspaceId,
              caseId,
              taxSubjectId: row.tax_subject_id,
              revision: source!.sourceRevision,
              contentHash: original.contentHash,
              form: d.form,
              taxYear: 2025,
              originalArtifactId: d.originalEvidenceId,
              ...('supersedesEvidenceId' in d
                ? {
                    supersedesArtifactId: d.supersedesEvidenceId,
                    corrections: d.corrections,
                  }
                : {}),
              reviewedBy: scope.userId,
              reviewedAt,
              boxes: d.boxes,
            };
            artifacts.push(metadata);
            trustedArtifacts.push({ ...metadata, bytes: original.bytes });
          }
          artifacts.sort((a, b) =>
            a.artifactId < b.artifactId
              ? -1
              : a.artifactId > b.artifactId
                ? 1
                : 0,
          );
          const manifest = {
            reference: `tax-wage-review:${reviewId}`,
            revision: source!.sourceRevision,
            artifacts,
          };
          const federalIntake = isNewYork
            ? projectNewYorkFederalIntake(
                saved.questionnaire.intake,
                declaredInputs,
                reviews,
              )
            : saved.questionnaire.intake;
          try {
            prepareUs2025ReviewBundle(
              federalIntake,
              {
                workspaceId: scope.workspaceId,
                caseId,
                taxSubjectId: row.tax_subject_id,
                snapshotRevision: row.current_revision,
                snapshotHash: saved.snapshotHash,
                intakeHash: usReviewContentHash(federalIntake),
                wageManifestReference: manifest.reference,
                wageManifestRevision: manifest.revision,
              },
              trustedArtifacts,
            );
          } catch {
            fail('invalid-input', 'wage-correction-chain-invalid');
          }
          const manifestHash = usReviewContentHash(manifest);
          await client.query(
            'insert into emdo.finance_tax_wage_reviews(workspace_id,case_id,tax_subject_id,snapshot_revision,id,snapshot_hash,source_id,source_revision,source_hash,package_hash,manifest,manifest_hash,created_by,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)',
            [
              scope.workspaceId,
              caseId,
              row.tax_subject_id,
              row.current_revision,
              reviewId,
              saved.snapshotHash,
              source!.sourceId,
              source!.sourceRevision,
              source!.contentHash,
              wagePackageHash,
              JSON.stringify(manifest),
              manifestHash,
              scope.userId,
              reviewedAt,
            ],
          );
          return FinanceTaxWageEvidenceReviewSchema.parse({
            reviewId,
            caseId,
            snapshotRevision: row.current_revision,
            snapshotHash: saved.snapshotHash,
            sourceId: source!.sourceId,
            sourceRevision: source!.sourceRevision,
            contentHash: source!.contentHash,
            manifestHash,
            documentCount: artifacts.length,
            reviewedBy: scope.userId,
            reviewedAt,
          });
        },
      );
    });
  }
  private async usWageEvidence(
    client: DatabaseClient,
    scope: WorkspaceContext,
    row: CaseRow,
    questionnaire: FinanceTaxQuestionnaire,
    snapshotHash: string,
    packageHash: string,
  ): Promise<PrivateUsWageEvidence | undefined> {
    const r = (
      await client.query(
        'select * from emdo.finance_tax_wage_reviews where workspace_id=$1 and case_id=$2 and snapshot_revision=$3 and snapshot_hash=$4 and package_hash=$5 order by created_at desc,id desc limit 1',
        [
          scope.workspaceId,
          row.id,
          questionnaire.intake.revision,
          snapshotHash,
          packageHash,
        ],
      )
    ).rows[0];
    if (!r) return undefined;
    if (hash(r.manifest) !== r.manifest_hash)
      fail('conflict', 'wage-manifest-integrity');
    const { declaredInputs } = await this.declaredInputs(
      client,
      row,
      questionnaire,
    );
    const source = declaredInputs.find(
      (f) =>
        f.sourceId === r.source_id &&
        f.sourceRevision === r.source_revision &&
        f.contentHash === r.source_hash &&
        f.factKey === 'wageEvidence.documents',
    );
    if (!source || source.value.type !== 'text')
      fail('conflict', 'wage-source-binding');
    const extraction = parseWageExtraction(source!.value.value);
    const manifest = r.manifest as {
      reference: string;
      revision: number;
      artifacts: Omit<UsReviewedWageArtifact, 'bytes'>[];
    };
    const artifacts: UsReviewedWageArtifact[] = [];
    if (
      manifest.artifacts.length !== extraction.documents.length ||
      new Set(manifest.artifacts.map((a) => a.artifactId)).size !==
        manifest.artifacts.length
    )
      fail('conflict', 'wage-extraction-binding');
    for (const metadata of manifest.artifacts) {
      const d = extraction.documents.find(
        (d) => d.evidenceId === metadata.artifactId,
      );
      if (
        !d ||
        hash(d.boxes) !== hash(metadata.boxes) ||
        d.form !== metadata.form ||
        d.originalEvidenceId !== metadata.originalArtifactId ||
        hash(
          'supersedesEvidenceId' in d && 'corrections' in d
            ? {
                supersedesArtifactId: d.supersedesEvidenceId,
                corrections: d.corrections,
              }
            : {},
        ) !==
          hash({
            ...('supersedesArtifactId' in metadata
              ? { supersedesArtifactId: metadata.supersedesArtifactId }
              : {}),
            ...('corrections' in metadata
              ? { corrections: metadata.corrections }
              : {}),
          })
      )
        fail('conflict', 'wage-extraction-binding');
      const original = await this.wageOriginal(
        client,
        scope,
        row.id,
        questionnaire.intake.revision,
        d!.bookId,
        d!.evidenceId,
      );
      if (original.contentHash !== metadata.contentHash)
        fail('conflict', 'wage-original-hash');
      artifacts.push({ ...metadata, bytes: original.bytes });
    }
    return {
      reference: manifest.reference,
      revision: manifest.revision,
      artifacts,
    };
  }

  async createCalculationRun(
    context: WorkspaceContext,
    caseId: string,
    key: string,
    raw: unknown,
  ) {
    const input = CreatePrivateTaxCalculationRunSchema.parse(raw);
    this.assertWorkingPackage(input);
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.edit);
      const receipt = await this.receipt(
        client,
        scope,
        key,
        { operation: 'create-calculation-run', caseId, input },
        async () => {
          if (row.current_revision !== input.expectedCaseRevision)
            fail('conflict', 'case-revision-conflict');
          const saved = await this.snapshot(client, row);
          const adapter = workingAdapter(
            saved.questionnaire.intake.scope.taxpayerType,
            saved.questionnaire.intake.scope.country,
            saved.questionnaire.intake.scope.subdivision,
          );
          if (input.workflowId !== adapter.workflowId)
            fail('invalid-input', 'working-case-package-mismatch');
          if (saved.snapshotHash !== input.expectedSnapshotHash)
            fail('conflict', 'snapshot-hash-conflict');
          await this.lockRunSnapshot(
            client,
            scope,
            caseId,
            row.current_revision,
          );
          const { declaredInputs } = await this.declaredInputs(
            client,
            row,
            saved.questionnaire,
          );
          const reviews = await this.workingInputReviews(
            client,
            row,
            row.current_revision,
            adapter.packageHash,
          );
          if (
            new Set(declaredInputs.map((f) => f.factKey)).size !==
            declaredInputs.length
          )
            fail('invalid-input', 'ambiguous-working-input');
          const standardCalculationIntake = FinanceTaxIntakeSchema.parse({
            ...saved.questionnaire.intake,
            facts: declaredInputs.map((f) => ({
              key: f.factKey,
              value: f.value,
              reviewState: reviews.some(
                (r) =>
                  r.sourceId === f.sourceId &&
                  r.sourceRevision === f.sourceRevision &&
                  r.contentHash === f.contentHash,
              )
                ? ('reviewed' as const)
                : ('unreviewed' as const),
              source: {
                kind: 'declaration' as const,
                reference: `declaration:${f.sourceId}`,
                revision: f.sourceRevision,
                contentHash: f.contentHash,
              },
            })),
          });
          const federalCalculationIntake =
            adapter.workflowId === NY_PRIVATE_WORKFLOW_ID
              ? projectNewYorkFederalIntake(
                  saved.questionnaire.intake,
                  declaredInputs,
                  reviews,
                )
              : undefined;
          const federalComponentHash = federalCalculationIntake
            ? usReviewContentHash(federalCalculationIntake)
            : undefined;
          const calculationIntake =
            adapter.workflowId === NY_PRIVATE_WORKFLOW_ID
              ? projectNewYorkStateIntake(
                  saved.questionnaire.intake,
                  declaredInputs,
                  reviews,
                  federalComponentHash,
                )
              : standardCalculationIntake;
          const personal =
            adapter.workflowId === WorkingWorkflowId
              ? runCanadaOntario2025PersonalWorkflow(calculationIntake)
              : null;
          const calculated =
            personal ??
            (adapter.workflowId === NY_PRIVATE_WORKFLOW_ID
              ? runPrivateNewYorkWorkingPapers(
                  federalCalculationIntake!,
                  calculationIntake,
                  {
                    snapshotHash: saved.snapshotHash,
                    federalSnapshotHash: saved.snapshotHash,
                    newYorkSnapshotHash: saved.snapshotHash,
                    wageEvidence: await this.usWageEvidence(
                      client,
                      scope,
                      row,
                      saved.questionnaire,
                      saved.snapshotHash,
                      adapter.packageHash,
                    ),
                  },
                )
              : adapter.workflowId === UsWorkflowId
                ? runPrivateUsWorkingPapers(
                    calculationIntake,
                    saved.snapshotHash,
                    await this.usWageEvidence(
                      client,
                      scope,
                      row,
                      saved.questionnaire,
                      saved.snapshotHash,
                      adapter.packageHash,
                    ),
                  )
                : adapter.workflowId === MexicoWorkflowId
                  ? runPrivateMexicoWorkingPapers(
                      calculationIntake,
                      saved.snapshotHash,
                    )
                  : runPrivateCorporateWorkingPapers(
                      calculationIntake,
                      saved.snapshotHash,
                    ));
          const formAudit = personal
            ? auditCanadaOntario2025PersonalFormApplicability(personal, {
                caseId: row.id,
                taxSubjectId: row.tax_subject_id,
                revision: row.current_revision,
                runHash: calculated.runHash,
                facts: calculationIntake.facts.filter(
                  (f) =>
                    f.key.startsWith('identity.') ||
                    f.key.startsWith('businessIdentity.'),
                ),
              })
            : undefined;
          const envelope = {
            questionnaire: saved.questionnaire,
            calculationIntake,
            ...(federalCalculationIntake ? { federalCalculationIntake } : {}),
            inputReviews: reviews,
            sourceAuthorizationBindings:
              saved.questionnaire.sourceAuthorizationBindings,
            packageHash: adapter.packageHash,
          };
          const schedules: StoredSchedule[] = [
            ...new Set(calculated.fields.map((f) => f.form)),
          ]
            .sort()
            .map((formId) => {
              const content = calculated.fields.flatMap((field, ordinal) =>
                field.form === formId
                  ? [{ ordinal, field: FinanceTaxRunFieldSchema.parse(field) }]
                  : [],
              );
              return { formId, content, contentHash: hash(content) };
            });
          const { fields, ...header } = calculated;
          const output = {
            ...header,
            ...(formAudit ? { formAudit } : {}),
            scheduleManifest: schedules.map(({ formId, contentHash }) => ({
              formId,
              contentHash,
            })),
          };
          // Numeric schedules have independent hashes and ordering. Corporate runs also
          // retain the engine review artifact for complete authorized human export.
          if (
            fields.length !==
            schedules.reduce((n, s) => n + s.content.length, 0)
          )
            fail('conflict', 'schedule-normalization-conflict');
          const result = await client.query(
            'insert into emdo.finance_tax_calculation_runs(workspace_id,case_id,tax_subject_id,snapshot_revision,id,snapshot_hash,workflow_id,package_version,package_hash,input_hash,output_hash,status,complete,input,output,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13::jsonb,$14::jsonb,$15) returning *',
            [
              scope.workspaceId,
              caseId,
              row.tax_subject_id,
              row.current_revision,
              randomUUID(),
              saved.snapshotHash,
              adapter.workflowId,
              adapter.packageVersion,
              adapter.packageHash,
              hash(envelope),
              hash(output),
              calculated.status === 'blocked'
                ? 'blocked-input'
                : 'incomplete-working-papers',
              JSON.stringify(envelope),
              JSON.stringify(output),
              scope.userId,
            ],
          );
          const summary = summaryFromRow(result.rows[0]!);
          for (const schedule of schedules)
            await client.query(
              'insert into emdo.finance_tax_run_schedules(workspace_id,case_id,run_id,form_id,content,content_hash) values($1,$2,$3,$4,$5::jsonb,$6)',
              [
                scope.workspaceId,
                caseId,
                summary.runId,
                schedule.formId,
                JSON.stringify(schedule.content),
                schedule.contentHash,
              ],
            );
          return summary;
        },
      );
      await this.lockRunSnapshot(
        client,
        scope,
        caseId,
        receipt.snapshotRevision,
      );
      return receipt;
    });
  }
  async listCalculationRuns(
    context: WorkspaceContext,
    caseId: string,
    offset = 0,
    limit = 50,
  ) {
    z.number().int().min(0).max(100000).parse(offset);
    z.number().int().min(1).max(100).parse(limit);
    return this.transaction(context, async (client, scope) => {
      await this.lockCase(client, scope, caseId, Roles.read, false);
      const rows = (
        await client.query(
          'select id,case_id,tax_subject_id,snapshot_revision,snapshot_hash,workflow_id,package_version,package_hash,input_hash,output_hash,status,complete,created_by,created_at from emdo.finance_tax_calculation_runs where workspace_id=$1 and case_id=$2 order by created_at desc,id offset $3 limit $4',
          [scope.workspaceId, caseId, offset, limit],
        )
      ).rows;
      for (const r of rows)
        await this.lockRunSnapshot(
          client,
          scope,
          caseId,
          Number(r.snapshot_revision),
        );
      return rows.map(summaryFromRow);
    });
  }
  private async readCalculationRun(
    client: DatabaseClient,
    scope: WorkspaceContext,
    row: CaseRow,
    runId: string,
  ) {
    UuidSchema.parse(runId);
    const found = (
      await client.query(
        'select * from emdo.finance_tax_calculation_runs where workspace_id=$1 and case_id=$2 and id=$3',
        [scope.workspaceId, row.id, runId],
      )
    ).rows[0];
    if (!found) fail('forbidden', 'run-forbidden');
    await this.lockRunSnapshot(
      client,
      scope,
      row.id,
      Number(found.snapshot_revision),
    );
    const saved = await this.snapshot(
      client,
      row,
      Number(found.snapshot_revision),
    );
    if (
      saved.snapshotHash !== found.snapshot_hash ||
      hash(found.input) !== found.input_hash ||
      hash(found.output) !== found.output_hash
    )
      fail('conflict', 'run-integrity');
    const output = found.output as StoredRunOutput;
    if (
      output.formAudit &&
      (output.formAudit.runHash !== output.runHash ||
        output.formAudit.packageVersion !== found.package_version)
    )
      fail('conflict', 'form-audit-binding-conflict');
    if (found.workflow_id === CorporateWorkflowId) {
      if (
        !('corporateResult' in output) ||
        output.corporateResult.packageVersion !== found.package_version
      )
        fail('conflict', 'corporate-package-binding-conflict');
      const result =
        'corporateResult' in output ? output.corporateResult : undefined;
      if (!result)
        throw new FinanceTaxPersistenceError(
          'conflict',
          'corporate-package-binding-conflict',
        );
      if (
        'binding' in result &&
        (result.binding.caseId !== row.id ||
          result.binding.snapshotRevision !== Number(found.snapshot_revision) ||
          result.binding.snapshotHash !== found.snapshot_hash)
      )
        fail('conflict', 'corporate-snapshot-binding-conflict');
    }
    if (found.workflow_id === MexicoWorkflowId) {
      if (!('mexicoResult' in output))
        fail('conflict', 'mexico-package-binding-conflict');
      const mexico = 'mexicoResult' in output ? output : undefined;
      if (!mexico)
        throw new FinanceTaxPersistenceError(
          'conflict',
          'mexico-package-binding-conflict',
        );
      const { adapterHash, ...adapterBody } = mexico.mexicoResult;
      const binding = mexico.mexicoResult.binding;
      if (
        mexico.packageVersion !== found.package_version ||
        mexico2025ReportHash(adapterBody) !== adapterHash ||
        !binding ||
        binding.caseId !== row.id ||
        binding.workspaceId !== scope.workspaceId ||
        binding.taxSubjectId !== row.tax_subject_id ||
        binding.snapshotRevision !== Number(found.snapshot_revision) ||
        binding.snapshotHash !== found.snapshot_hash ||
        binding.inputHash !== mexico2025ReportHash(mexico.inputSnapshot)
      )
        fail('conflict', 'mexico-snapshot-binding-conflict');
    }
    if (found.workflow_id === UsWorkflowId) {
      if (!('usReviewBundle' in output) || !('usResult' in output))
        fail('conflict', 'us-package-binding');
      const us = 'usReviewBundle' in output ? output : undefined;
      if (!us)
        throw new FinanceTaxPersistenceError('conflict', 'us-package-binding');
      const {
        bundleHash,
        attachmentBindingsComplete,
        complete,
        status,
        ...bundleBody
      } = us.usReviewBundle;
      void attachmentBindingsComplete;
      void complete;
      void status;
      if (
        usReviewContentHash(bundleBody) !== bundleHash ||
        us.packageHash !== found.package_hash ||
        us.usReviewBundle.snapshot.snapshotHash !== found.snapshot_hash ||
        us.usReviewBundle.snapshot.caseId !== row.id ||
        us.usReviewBundle.snapshot.snapshotRevision !==
          Number(found.snapshot_revision)
      )
        fail('conflict', 'us-snapshot-bundle-binding');
    }
    if (found.workflow_id === NY_PRIVATE_WORKFLOW_ID) {
      const ny = output as Omit<
        ReturnType<typeof runPrivateNewYorkWorkingPapers>,
        'fields'
      > & { scheduleManifest: Array<{ formId: string; contentHash: string }> };
      if (ny.workflowId !== NY_PRIVATE_WORKFLOW_ID)
        fail('conflict', 'new-york-package-binding');
      if (ny.packageHash !== found.package_hash)
        fail('conflict', 'new-york-package-binding');
      if (ny.federalResult === null)
        fail('conflict', 'new-york-package-binding');
      if (ny.newYorkResult === null)
        fail('conflict', 'new-york-package-binding');
      const federalResult = ny.federalResult as NonNullable<
        typeof ny.federalResult
      >;
      const newYorkResult = ny.newYorkResult as NonNullable<
        typeof ny.newYorkResult
      >;
      if (
        ny.inputBinding.caseId !== row.id ||
        ny.inputBinding.workspaceId !== scope.workspaceId ||
        ny.inputBinding.taxSubjectId !== row.tax_subject_id ||
        ny.inputBinding.snapshotRevision !== Number(found.snapshot_revision) ||
        ny.inputBinding.federalRevision !== Number(found.snapshot_revision) ||
        ny.inputBinding.newYorkRevision !== Number(found.snapshot_revision) ||
        ny.inputBinding.snapshotHash !== found.snapshot_hash ||
        ny.inputBinding.federalSnapshotHash !== found.snapshot_hash ||
        ny.inputBinding.newYorkSnapshotHash !== found.snapshot_hash ||
        ny.sourceLineage.federalOutputHash !== federalResult.runHash ||
        ny.sourceLineage.federalDomainOutputHash !==
          federalResult.usResult.outputHash ||
        ny.sourceLineage.newYorkDomainOutputHash !== newYorkResult.outputHash
      )
        fail('conflict', 'new-york-snapshot-binding');
    }
    const schedules = (
      await client.query(
        'select form_id as "formId",content,content_hash as "contentHash" from emdo.finance_tax_run_schedules where workspace_id=$1 and case_id=$2 and run_id=$3 order by form_id',
        [scope.workspaceId, row.id, runId],
      )
    ).rows as StoredSchedule[];
    if (
      hash(
        schedules.map(({ formId, contentHash }) => ({ formId, contentHash })),
      ) !== hash(output.scheduleManifest) ||
      schedules.some((s) => hash(s.content) !== s.contentHash)
    )
      fail('conflict', 'run-schedule-integrity');
    if (
      found.workflow_id === NY_PRIVATE_WORKFLOW_ID &&
      output.status !== 'blocked'
    ) {
      const ny = output as Omit<
        ReturnType<typeof runPrivateNewYorkWorkingPapers>,
        'fields'
      > & { scheduleManifest: Array<{ formId: string; contentHash: string }> };
      const fields = schedules
        .flatMap((schedule) => schedule.content)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((schedule) => schedule.field);
      try {
        const { scheduleManifest, ...header } = ny;
        if (scheduleManifest.length !== schedules.length)
          fail('conflict', 'schedule-manifest-conflict');
        exportPrivateNewYorkWorkingPapers({ ...header, fields });
      } catch {
        fail('conflict', 'new-york-output-integrity');
      }
    }
    const reviews = (
      await client.query(
        'select id as "reviewId",output_hash as "outputHash",acknowledgement,created_by as "reviewedBy",created_at as "reviewedAt" from emdo.finance_tax_run_reviews where workspace_id=$1 and case_id=$2 and run_id=$3 order by created_at,id',
        [scope.workspaceId, row.id, runId],
      )
    ).rows.map((r) => ({
      reviewId: String(r.reviewId),
      outputHash: String(r.outputHash),
      acknowledgement: String(r.acknowledgement),
      reviewedBy: String(r.reviewedBy),
      reviewedAt: new Date(String(r.reviewedAt)).toISOString(),
    }));
    return {
      summary: summaryFromRow(found),
      input: found.input,
      output,
      schedules,
      reviews,
    };
  }
  async getCalculationRun(
    context: WorkspaceContext,
    caseId: string,
    runId: string,
  ) {
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.read, false);
      const saved = await this.readCalculationRun(client, scope, row, runId);
      const envelope = saved.input as {
        questionnaire: FinanceTaxQuestionnaire;
        inputReviews: unknown[];
      };
      const output = saved.output;
      return FinanceTaxCalculationRunDetailSchema.parse({
        summary: saved.summary,
        inputBinding: {
          snapshotRevision: saved.summary.snapshotRevision,
          snapshotHash: saved.summary.snapshotHash,
          declarations: envelope.questionnaire.declarationSourceBindings ?? [],
          inputReviews: envelope.inputReviews,
          sourceBooks: envelope.questionnaire.sourceAuthorizationBindings,
        },
        authorities: output.sources.map(
          ({ id, url, formVersion, documentHash, retrievedAt }) => ({
            id,
            url,
            formVersion,
            documentHash,
            retrievedAt,
          }),
        ),
        output: {
          status: output.status,
          complete: output.complete,
          enabled: output.enabled,
          reportable: output.reportable,
          runHash: output.runHash,
          reportingPolicyVersion: output.reportingPolicyVersion,
          issues: output.issues,
          releaseBlockers: output.releaseBlockers,
          finalAmounts: output.finalAmounts,
          ...(output.formAudit
            ? { formAudit: formAuditSummary(output.formAudit) }
            : {}),
        },
        schedules: saved.schedules,
        reviews: saved.reviews,
      });
    });
  }
  async reviewCalculationRun(
    context: WorkspaceContext,
    caseId: string,
    runId: string,
    key: string,
    raw: unknown,
  ) {
    const input = ReviewPrivateTaxCalculationRunSchema.parse(raw);
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(
        client,
        scope,
        caseId,
        Roles.review,
        false,
      );
      const run = await this.readCalculationRun(client, scope, row, runId);
      if (run.summary.outputHash !== input.expectedOutputHash)
        fail('conflict', 'run-review-hash-conflict');
      if (run.summary.status === 'blocked-input')
        fail('conflict', 'run-has-blocking-inputs');
      return this.receipt(
        client,
        scope,
        key,
        { operation: 'review-calculation-run', caseId, runId, input },
        async () => {
          const reviewId = randomUUID();
          await client.query(
            'insert into emdo.finance_tax_run_reviews(workspace_id,case_id,run_id,id,output_hash,acknowledgement,created_by) values($1,$2,$3,$4,$5,$6,$7)',
            [
              scope.workspaceId,
              caseId,
              runId,
              reviewId,
              input.expectedOutputHash,
              input.acknowledgement,
              scope.userId,
            ],
          );
          return {
            caseId,
            runId,
            reviewId,
            outputHash: run.summary.outputHash,
            complete: false,
          };
        },
      );
    });
  }
  async exportCalculationRun(
    context: WorkspaceContext,
    caseId: string,
    runId: string,
    reviewId: string,
  ) {
    UuidSchema.parse(reviewId);
    return this.transaction(context, async (client, scope) => {
      const row = await this.lockCase(client, scope, caseId, Roles.read, false);
      const saved = await this.readCalculationRun(client, scope, row, runId);
      const review = saved.reviews.find(
        (r) =>
          r.reviewId === reviewId && r.outputHash === saved.summary.outputHash,
      );
      if (!review || saved.summary.status !== 'incomplete-working-papers')
        fail('conflict', 'run-review-required');
      const { scheduleManifest, formAudit, ...header } = saved.output;
      if (scheduleManifest.length !== saved.schedules.length)
        fail('conflict', 'schedule-manifest-conflict');
      const fields = saved.schedules
        .flatMap((s) => s.content)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((s) => s.field);
      const exported =
        saved.summary.workflowId === UsWorkflowId
          ? exportPrivateUsWorkingPapers({ ...header, fields } as ReturnType<
              typeof runPrivateUsWorkingPapers
            >)
          : saved.summary.workflowId === NY_PRIVATE_WORKFLOW_ID
            ? exportPrivateNewYorkWorkingPapers({
                ...header,
                fields,
              } as ReturnType<typeof runPrivateNewYorkWorkingPapers>)
            : saved.summary.workflowId === MexicoWorkflowId
              ? exportPrivateMexicoWorkingPapers({
                  ...header,
                  fields,
                } as ReturnType<typeof runPrivateMexicoWorkingPapers>)
              : saved.summary.workflowId === CorporateWorkflowId
                ? exportPrivateCorporateWorkingPapers({
                    ...header,
                    fields,
                  } as ReturnType<typeof runPrivateCorporateWorkingPapers>)
                : exportCanadaOntario2025PersonalSchedules({
                    ...header,
                    fields,
                  } as CanadaOntario2025PersonalRun);
      const content =
        `Private incomplete working papers; NOT FILEABLE\nDurable run,${runId}\nCase snapshot,${saved.summary.snapshotHash}\nPackage hash,${saved.summary.packageHash}\nReviewed by,${review!.reviewedBy}\nReview ID,${reviewId}\n` +
        exported.content +
        (formAudit
          ? '\n' +
            exportFormAudit(
              formAudit,
              (
                saved.input as {
                  calculationIntake: {
                    facts: Array<{
                      key: string;
                      value: { type: string; value: unknown };
                      reviewState: string;
                    }>;
                  };
                }
              ).calculationIntake.facts,
            )
          : '');
      return {
        caseId,
        runId,
        reviewId,
        outputHash: saved.summary.outputHash,
        snapshotHash: saved.summary.snapshotHash,
        filename: exported.filename,
        mimeType: exported.mimeType,
        content,
        sha256: createHash('sha256').update(content).digest('hex'),
        complete: false,
      };
    });
  }
}
