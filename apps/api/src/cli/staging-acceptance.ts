import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  FinanceDocumentListSchema,
  FinanceDocumentDetailSchema,
  FinanceDocumentEvidenceListSchema,
  FinanceDocumentReviewDraftSchema,
  FinanceDocumentSummarySchema,
  FinanceExperienceV1Schema,
} from '@emdo/domains/finance';
import { z } from 'zod';

import { formatFinanceSyntheticStagingCommand } from '../production/finance-synthetic-staging-agent.js';
import { ApiSyntheticHttpSubsetReadinessSuccessSchema } from '../readiness-contract.js';
import {
  ActionDecisionReceiptSchema,
  HouseholdInvitationIssueResponseSchema,
  HouseholdMembershipListResponseSchema,
  InvitationRedeemResponseSchema,
  FinancePageSchema,
  ProposalApprovalViewSchema,
  RunEventSchema,
  ShoppingPageSchema,
  TurnAcceptanceSchema,
  VisualProofSchema,
} from '../schemas.js';

const AcceptanceConfigurationSchema = z.strictObject({
  apiOrigin: z
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
    .refine((value) => new URL(value).origin === value),
  environment: z.literal('staging'),
  workerProvidersEnabled: z.literal('false'),
  ownerEmail: z.email().trim().toLowerCase().max(320),
  ownerPassword: z.string().min(12).max(128),
  publicOrigin: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:')
    .refine((value) => new URL(value).origin === value),
  syntheticDataOnly: z.literal('true'),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
  workflowRunId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
});

const FinanceAcceptanceConfigurationSchema =
  AcceptanceConfigurationSchema.extend({
    financeSyntheticStaging: z.literal('true'),
  });

const ProblemResponseSchema = z.object({
  type: z.literal('about:blank'),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  code: z.string().min(1),
  detail: z.string().min(1),
  requestId: z.uuid(),
});

const ACCEPTANCE_PROPOSAL = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa1';

const PROVIDER_FREE_ACCEPTANCE_ARGS = Object.freeze([
  '--all-mvp-gates',
  '--require-synthetic',
  '--forbid-worker-provider-execution',
] as const);
const FINANCE_ACCEPTANCE_ARGS = Object.freeze([
  ...PROVIDER_FREE_ACCEPTANCE_ARGS,
  '--finance-synthetic-document-gates',
] as const);
const FINANCE_FINALIZE_ACCEPTANCE_ARGS = Object.freeze([
  ...FINANCE_ACCEPTANCE_ARGS,
  '--finance-synthetic-document-finalize',
] as const);

const FinanceStagingAcceptanceStageSchema = z.enum([
  'configuration',
  'health-and-contract',
  'owner-authentication',
  'member-invitation',
  'member-token-handoff',
  'member-redemption',
  'member-membership-readback',
  'member-authentication',
  'document-upload',
  'document-extraction-terminal',
  'document-original-readback',
  'document-review-read-edit',
  'document-direct-commit-denial',
  'guarded-review-commit',
  'guarded-review-commit:initial-turn',
  'guarded-review-commit:approval-parsing',
  'guarded-review-commit:proposal-read',
  'guarded-review-commit:visual-proof',
  'guarded-review-commit:decision-receipt',
  'guarded-review-commit:resumed-run',
  'guarded-review-commit:resumed-run-failed',
  'guarded-review-commit:resumed-run-completed',
  'guarded-review-commit:commit-readback',
  'guarded-review-commit:quota-readback',
  'guarded-delete-denial',
  'qna-and-isolation',
  'safe-write-and-handoff',
  'finalize-configuration',
  'finalize-attestation',
  'finalize-health-and-contract',
  'finalize-owner-authentication',
  'finalize-member-authentication',
  'finalize-document-and-evidence',
  'finalize-guarded-delete',
  'finalize-purge-and-revocation',
]);

type FinanceStagingAcceptanceStage = z.output<
  typeof FinanceStagingAcceptanceStageSchema
>;

const FinanceMemberInvitationDiagnosticSchema = z.enum([
  'member-invitation:request-or-network-failed',
  'member-invitation:http-401-authentication-required',
  'member-invitation:http-401-authentication-invalid',
  'member-invitation:http-400-invalid-input',
  'member-invitation:http-403-mutation-proof-invalid',
  'member-invitation:http-403-household-owner-required',
  'member-invitation:http-403-authorization-revoked',
  'member-invitation:http-409-conflict',
  'member-invitation:http-500-internal-error',
  'member-invitation:http-502-service-contract-invalid',
  'member-invitation:http-503-authentication-unavailable',
  'member-invitation:http-503-mutation-verification-unavailable',
  'member-invitation:http-503-invalid-result',
  'member-invitation:http-problem-unrecognized',
  'member-invitation:readback-invalid',
]);

type FinanceMemberInvitationDiagnostic = z.output<
  typeof FinanceMemberInvitationDiagnosticSchema
>;

const FinanceDocumentUploadDiagnosticSchema = z.enum([
  'document-upload:request-or-network-failed',
  'document-upload:http-400-request-header-invalid',
  'document-upload:http-400-idempotency-key-required',
  'document-upload:http-400-request-validation-failed',
  'document-upload:http-400-invalid-input',
  'document-upload:http-401-authentication-required',
  'document-upload:http-401-authentication-invalid',
  'document-upload:http-403-mutation-proof-invalid',
  'document-upload:http-403-authorization-revoked',
  'document-upload:http-404-document-not-found',
  'document-upload:http-409-idempotency-conflict',
  'document-upload:http-409-duplicate-document',
  'document-upload:http-409-document-state-conflict',
  'document-upload:http-413-finance-document-too-large',
  'document-upload:http-413-request-body-too-large',
  'document-upload:http-413-quota-exceeded',
  'document-upload:http-415-unsupported-media-type',
  'document-upload:http-500-internal-error',
  'document-upload:http-502-service-contract-invalid',
  'document-upload:http-503-authentication-unavailable',
  'document-upload:http-503-mutation-verification-unavailable',
  'document-upload:http-503-finance-documents-unavailable',
  'document-upload:http-problem-unrecognized',
  'document-upload:201-json-or-schema-invalid',
  'document-upload:synthetic-metadata-or-hash-mismatch',
]);

type FinanceDocumentUploadDiagnostic = z.output<
  typeof FinanceDocumentUploadDiagnosticSchema
>;

const FinanceInitialGuardedReviewDiagnosticSchema = z.enum([
  'turn-post-or-response-invalid',
  'turn-acceptance-json-or-schema-invalid',
  'initial-sse-request-failed',
  'initial-sse-http-or-content-type-invalid',
  'initial-sse-byte-or-framing-invalid',
  'initial-sse-event-schema-run-or-sequence-invalid',
  'initial-sse-terminal-run-failed',
  'initial-sse-terminal-run-indeterminate',
  'initial-sse-terminal-other-or-cardinality-invalid',
  'approval-terminal-invalid',
]);

type FinanceInitialGuardedReviewDiagnostic = z.output<
  typeof FinanceInitialGuardedReviewDiagnosticSchema
>;

const FinanceRecognizedRunnerSafeErrorCodeSchema = z.enum([
  'agent-capability-budget-exceeded',
  'agent-model-escalation-not-allowed',
  'agent-model-fallback-not-allowed',
  'agent-model-unavailable',
  'agent-token-budget-exceeded',
  'approval-checkpoint-already-consumed',
  'approval-checkpoint-expired',
  'approval-checkpoint-invalid',
  'approval-checkpoint-mismatch',
  'approval-checkpoint-not-found',
  'approval-checkpoint-persistence-failed',
  'approval-interruption-audit-failed',
  'approval-rejected',
  'approval-rejection-failed',
  'approval-rejection-result-invalid',
  'approved-action-outcome-unknown',
  'approved-action-result-invalid',
  'conversation-memory-unavailable',
  'conversation-persistence-failed',
  'invalid-approval-channel',
  'invalid-manager-input',
  'invalid-manager-plan',
  'invalid-provider-write-approval-interruption',
  'invalid-resume-turn-input',
  'manager-execution-failed',
  'manager-output-validation-failed',
  'manager-synthesis-failed',
  'model-disclosure-denied',
  'model-routing-failed',
  'model-spend-authorization-failed',
  'monthly-ai-spend-limit-reached',
  'multiple-provider-writes-require-separate-turns',
  'provider-write-proposal-finalization-pending',
  'required-agent-model-unavailable',
  'specialist-dependency-failed',
  'specialist-execution-failed',
  'specialist-output-validation-failed',
  'specialist-result-processing-failed',
]);

const FinanceResumedRunFailureDiagnosticSchema = z.enum([
  'guarded-review-commit:resumed-run-failed outcome=approval-resume-binding-invalid',
  'guarded-review-commit:resumed-run-failed outcome=approval-resume-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-agent-capability-budget-exceeded',
  'guarded-review-commit:resumed-run-failed outcome=runner-agent-model-escalation-not-allowed',
  'guarded-review-commit:resumed-run-failed outcome=runner-agent-model-fallback-not-allowed',
  'guarded-review-commit:resumed-run-failed outcome=runner-agent-model-unavailable',
  'guarded-review-commit:resumed-run-failed outcome=runner-agent-token-budget-exceeded',
  'guarded-review-commit:resumed-run-failed outcome=runner-approval-checkpoint-already-consumed',
  'guarded-review-commit:resumed-run-failed outcome=runner-approval-checkpoint-expired',
  'guarded-review-commit:resumed-run-failed outcome=runner-approval-checkpoint-invalid',
  'guarded-review-commit:resumed-run-failed outcome=runner-approval-checkpoint-mismatch',
  'guarded-review-commit:resumed-run-failed outcome=runner-approval-checkpoint-not-found',
  'guarded-review-commit:resumed-run-failed outcome=runner-approval-checkpoint-persistence-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-approval-interruption-audit-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-approval-rejected',
  'guarded-review-commit:resumed-run-failed outcome=runner-approval-rejection-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-approval-rejection-result-invalid',
  'guarded-review-commit:resumed-run-failed outcome=runner-approved-action-outcome-unknown',
  'guarded-review-commit:resumed-run-failed outcome=runner-approved-action-result-invalid',
  'guarded-review-commit:resumed-run-failed outcome=runner-conversation-memory-unavailable',
  'guarded-review-commit:resumed-run-failed outcome=runner-conversation-persistence-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-invalid-approval-channel',
  'guarded-review-commit:resumed-run-failed outcome=runner-invalid-manager-input',
  'guarded-review-commit:resumed-run-failed outcome=runner-invalid-manager-plan',
  'guarded-review-commit:resumed-run-failed outcome=runner-invalid-provider-write-approval-interruption',
  'guarded-review-commit:resumed-run-failed outcome=runner-invalid-resume-turn-input',
  'guarded-review-commit:resumed-run-failed outcome=runner-manager-execution-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-manager-output-validation-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-manager-synthesis-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-model-disclosure-denied',
  'guarded-review-commit:resumed-run-failed outcome=runner-model-routing-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-model-spend-authorization-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-monthly-ai-spend-limit-reached',
  'guarded-review-commit:resumed-run-failed outcome=runner-multiple-provider-writes-require-separate-turns',
  'guarded-review-commit:resumed-run-failed outcome=runner-provider-write-proposal-finalization-pending',
  'guarded-review-commit:resumed-run-failed outcome=runner-required-agent-model-unavailable',
  'guarded-review-commit:resumed-run-failed outcome=runner-specialist-dependency-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-specialist-execution-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-specialist-output-validation-failed',
  'guarded-review-commit:resumed-run-failed outcome=runner-specialist-result-processing-failed',
  'guarded-review-commit:resumed-run-failed outcome=unrecognized',
  'guarded-review-commit:resumed-run-failed outcome=invalid',
]);

type FinanceResumedRunFailureDiagnostic = z.output<
  typeof FinanceResumedRunFailureDiagnosticSchema
>;

type FinanceStagingAcceptanceProgress =
  | FinanceStagingAcceptanceStage
  | FinanceMemberInvitationDiagnostic
  | FinanceDocumentUploadDiagnostic
  | FinanceInitialGuardedReviewDiagnostic
  | FinanceResumedRunFailureDiagnostic;

const FinanceMemberInvitationOutcome = Object.freeze({
  'member-invitation:request-or-network-failed': 'request-or-network-failed',
  'member-invitation:http-401-authentication-required':
    'http-401-authentication-required',
  'member-invitation:http-401-authentication-invalid':
    'http-401-authentication-invalid',
  'member-invitation:http-400-invalid-input': 'http-400-invalid-input',
  'member-invitation:http-403-mutation-proof-invalid':
    'http-403-mutation-proof-invalid',
  'member-invitation:http-403-household-owner-required':
    'http-403-household-owner-required',
  'member-invitation:http-403-authorization-revoked':
    'http-403-authorization-revoked',
  'member-invitation:http-409-conflict': 'http-409-conflict',
  'member-invitation:http-500-internal-error': 'http-500-internal-error',
  'member-invitation:http-502-service-contract-invalid':
    'http-502-service-contract-invalid',
  'member-invitation:http-503-authentication-unavailable':
    'http-503-authentication-unavailable',
  'member-invitation:http-503-mutation-verification-unavailable':
    'http-503-mutation-verification-unavailable',
  'member-invitation:http-503-invalid-result': 'http-503-invalid-result',
  'member-invitation:http-problem-unrecognized': 'http-problem-unrecognized',
  'member-invitation:readback-invalid': 'readback-invalid',
} satisfies Record<FinanceMemberInvitationDiagnostic, string>);

export const formatStagingAcceptanceFailure = (
  progress: FinanceStagingAcceptanceProgress | undefined,
): string => {
  const diagnostic =
    FinanceMemberInvitationDiagnosticSchema.safeParse(progress);
  if (diagnostic.success) {
    return `Staging acceptance failed at stage=member-invitation outcome=${FinanceMemberInvitationOutcome[diagnostic.data]}.\n`;
  }
  const uploadDiagnostic =
    FinanceDocumentUploadDiagnosticSchema.safeParse(progress);
  if (uploadDiagnostic.success) {
    return `Staging acceptance failed at stage=document-upload outcome=${uploadDiagnostic.data.slice('document-upload:'.length)}.\n`;
  }
  const initialGuardedReviewDiagnostic =
    FinanceInitialGuardedReviewDiagnosticSchema.safeParse(progress);
  if (initialGuardedReviewDiagnostic.success) {
    return `Staging acceptance failed at stage=guarded-review-commit:initial-turn outcome=${initialGuardedReviewDiagnostic.data}.\n`;
  }
  const resumedRunFailureDiagnostic =
    FinanceResumedRunFailureDiagnosticSchema.safeParse(progress);
  if (resumedRunFailureDiagnostic.success) {
    return `Staging acceptance failed at stage=${resumedRunFailureDiagnostic.data}.\n`;
  }
  const stage = FinanceStagingAcceptanceStageSchema.safeParse(progress);
  return stage.success
    ? `Staging acceptance failed at stage=${stage.data}.\n`
    : 'Staging acceptance failed.\n';
};

const FINANCE_DOCUMENT_FILENAME = 'emdo-synthetic-staging.pdf';
const FINANCE_REVIEW_ISSUER = 'Boreal Quasar Ledger';
const FINANCE_REVIEW_EVIDENCE_FIELD = 'synthetic-source-proof';
const FINANCE_REVIEW_EVIDENCE_EXCERPT = 'Cobalt Lantern Receipt';
const FINANCE_SYNTHETIC_MEMBER_EMAIL = 'finance-staging-member@emdo.invalid';
const FINANCE_SYNTHETIC_MEMBER_NAME = 'Finance Staging Member';
const FINANCE_EXTRACTION_MAX_POLLS = 90;
const FINANCE_EXTRACTION_POLL_INTERVAL_MS = 1_000;
const FINANCE_SSE_MAXIMUM_BYTES = 256 * 1024;
const FINANCE_SSE_MAXIMUM_FRAMES = 128;
const FINANCE_STAGING_MANUAL_TRANSACTION_ID =
  'finance-synthetic-staging-manual-transaction-v1';
const FINANCE_STAGING_MANUAL_TRANSACTION_ACCOUNT_ID =
  'synthetic-finance-account-v1';
const FINANCE_STAGING_MANUAL_TRANSACTION_DESCRIPTION =
  'EMDO synthetic staging manual transaction';
const FINANCE_STAGING_MANUAL_TRANSACTION_DATE = '2026-08-12';
const FINANCE_STAGING_MANUAL_TRANSACTION_AMOUNT_CAD_MINOR = -123;
const FINANCE_RESTORE_VERIFIER_HANDOFF_PATH =
  '/run/emdo/finance-restore/finance-staging-restore-verifier-input.env';
const FINANCE_RESTORE_VERIFIER_HANDOFF_SCHEMA =
  'emdo-finance-staging-restore-verifier-input-v1';
const FINANCE_FINALIZE_INPUT_SCHEMA = 'emdo-finance-staging-finalize-input-v1';
const FINANCE_RESTORE_VERIFIER_COOKIE_PATTERN =
  /^[A-Za-z0-9_.-]+=[A-Za-z0-9_.=-]+(?:; [A-Za-z0-9_.-]+=[A-Za-z0-9_.=-]+)*$/u;

const FinanceRestoreVerifierHandoffSchema = z.strictObject({
  documentId: z.uuid(),
  evidenceId: z.uuid(),
  expectedPlaintextSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  memberCookie: z.string().regex(FINANCE_RESTORE_VERIFIER_COOKIE_PATTERN),
  ownerCookie: z.string().regex(FINANCE_RESTORE_VERIFIER_COOKIE_PATTERN),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
  workflowRunId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
});

export type FinanceRestoreVerifierHandoff = Readonly<
  z.output<typeof FinanceRestoreVerifierHandoffSchema>
>;

const FinanceStagingPhase2RootAttestationSchema = z.strictObject({
  schema: z.literal(FINANCE_FINALIZE_INPUT_SCHEMA),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
  workflowRunId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
  documentId: z.uuid(),
  evidenceId: z.uuid(),
  backupRestoreReceiptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

/**
 * Root-only phase-2 seam. It contains neither a session nor document content;
 * root validates the independent restore receipt before rewriting the mounted
 * handoff file for the ephemeral finalizer to consume exactly once.
 */
export type FinanceStagingPhase2RootAttestation = Readonly<{
  readonly sourceSha: string;
  readonly workflowRunId: string;
  readonly documentId: string;
  readonly evidenceId: string;
  readonly backupRestoreReceiptSha256: string;
}>;

/**
 * Writes the only bearer-bearing staging handoff. The root lifecycle creates
 * the exact file first and claims it after the short-lived acceptance process
 * exits, so a partial write is never accepted as verifier material.
 */
export const writeFinanceRestoreVerifierHandoff = async (
  input: FinanceRestoreVerifierHandoff,
  path = FINANCE_RESTORE_VERIFIER_HANDOFF_PATH,
): Promise<void> => {
  const value = FinanceRestoreVerifierHandoffSchema.parse(input);
  if (value.ownerCookie === value.memberCookie) {
    throw new Error('Finance restore verifier requires distinct sessions');
  }
  const file = await lstat(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.uid !== 10001 ||
    file.gid !== 10001 ||
    (file.mode & 0o777) !== 0o600 ||
    file.nlink !== 1 ||
    file.size !== 0
  ) {
    throw new Error(
      'Finance restore verifier handoff is not the pre-created file',
    );
  }
  const payload = [
    `schema=${FINANCE_RESTORE_VERIFIER_HANDOFF_SCHEMA}`,
    `source_sha=${value.sourceSha}`,
    `workflow_run_id=${value.workflowRunId}`,
    `document_id=${value.documentId}`,
    `evidence_id=${value.evidenceId}`,
    `expected_plaintext_sha256=${value.expectedPlaintextSha256}`,
    `owner_cookie=${value.ownerCookie}`,
    `member_cookie=${value.memberCookie}`,
    '',
  ].join('\n');
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
  );
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const isFinanceFinalizeInputFile = (file: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
}): boolean =>
  file.isFile() &&
  !file.isSymbolicLink() &&
  file.uid === 10001 &&
  file.gid === 10001 &&
  (file.mode & 0o777) === 0o600 &&
  file.nlink === 1 &&
  file.size > 0 &&
  file.size <= 2_048;

const parseFinanceFinalizeInput = (
  payload: string,
): FinanceStagingPhase2RootAttestation => {
  if (
    payload.length === 0 ||
    payload.length > 2_048 ||
    payload.includes('\r')
  ) {
    throw new Error('Finance staging finalization input is invalid');
  }
  const lines = payload.split('\n');
  const keys = [
    'schema',
    'source_sha',
    'workflow_run_id',
    'document_id',
    'evidence_id',
    'backup_restore_receipt_sha256',
  ] as const;
  if (lines.length !== keys.length + 1 || lines.at(-1) !== '') {
    throw new Error('Finance staging finalization input is invalid');
  }
  const values: Record<(typeof keys)[number], string> = {
    schema: '',
    source_sha: '',
    workflow_run_id: '',
    document_id: '',
    evidence_id: '',
    backup_restore_receipt_sha256: '',
  };
  for (const [index, key] of keys.entries()) {
    const line = lines[index];
    if (line === undefined || !line.startsWith(`${key}=`)) {
      throw new Error('Finance staging finalization input is invalid');
    }
    const value = line.slice(key.length + 1);
    if (value.length === 0 || value.includes('=')) {
      throw new Error('Finance staging finalization input is invalid');
    }
    values[key] = value;
  }
  const parsed = FinanceStagingPhase2RootAttestationSchema.safeParse({
    schema: values.schema,
    sourceSha: values.source_sha,
    workflowRunId: values.workflow_run_id,
    documentId: values.document_id,
    evidenceId: values.evidence_id,
    backupRestoreReceiptSha256: values.backup_restore_receipt_sha256,
  });
  if (!parsed.success) {
    throw new Error('Finance staging finalization input is invalid');
  }
  return Object.freeze({
    sourceSha: parsed.data.sourceSha,
    workflowRunId: parsed.data.workflowRunId,
    documentId: parsed.data.documentId,
    evidenceId: parsed.data.evidenceId,
    backupRestoreReceiptSha256: parsed.data.backupRestoreReceiptSha256,
  });
};

/**
 * Consumes the root-rewritten finalization handoff only after validating its
 * exact mode, owner, link count, contents, and inode across both opens.
 */
export const consumeFinanceStagingPhase2RootAttestation = async (
  path = FINANCE_RESTORE_VERIFIER_HANDOFF_PATH,
): Promise<FinanceStagingPhase2RootAttestation> => {
  const linked = await lstat(path);
  if (!isFinanceFinalizeInputFile(linked)) {
    throw new Error('Finance staging finalization handoff is not pre-created');
  }
  const readHandle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let payload: string;
  try {
    const opened = await readHandle.stat();
    if (
      !isFinanceFinalizeInputFile(opened) ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) {
      throw new Error('Finance staging finalization handoff changed');
    }
    payload = await readHandle.readFile('utf8');
  } finally {
    await readHandle.close();
  }
  const attestation = parseFinanceFinalizeInput(payload);
  const truncateHandle = await open(
    path,
    constants.O_WRONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await truncateHandle.stat();
    if (
      !isFinanceFinalizeInputFile(opened) ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) {
      throw new Error('Finance staging finalization handoff changed');
    }
    await truncateHandle.truncate(0);
    await truncateHandle.sync();
  } finally {
    await truncateHandle.close();
  }
  return attestation;
};

const buildSyntheticFinancePdf = (): Buffer => {
  const content = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    '(Cobalt Lantern Receipt) Tj',
    '0 -20 Td',
    '(No real financial data) Tj',
    '0 -20 Td',
    '(Synthetic CAD 1.23) Tj',
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
};

const SYNTHETIC_FINANCE_PDF = buildSyntheticFinancePdf();
const SYNTHETIC_FINANCE_PDF_SHA256 = createHash('sha256')
  .update(SYNTHETIC_FINANCE_PDF)
  .digest('hex');

type AcceptanceFetch = (request: Request) => Promise<Response>;

type StagingAcceptanceCommandInput = {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly fetch?: AcceptanceFetch;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly financeExtractionMaxPolls?: number;
  /** CLI-only content-safe progress observer; it never receives user data. */
  readonly financeStageReporter?: (
    progress: FinanceStagingAcceptanceProgress,
  ) => void;
  /** Test-only dependency injection; production uses the protected writer. */
  readonly financeRestoreVerifierHandoffWriter?: (
    handoff: FinanceRestoreVerifierHandoff,
  ) => Promise<void>;
  /** Test-only dependency injection; production consumes the protected file. */
  readonly financePhase2RootAttestationReader?: () => Promise<FinanceStagingPhase2RootAttestation>;
};

const requiredOpenApiOperations = Object.freeze({
  '/api/auth/get-session': ['get'],
  '/api/auth/sign-in/email': ['post'],
  '/api/v1/auth/csrf': ['get'],
  '/api/v1/turns': ['post'],
  '/api/v1/runs/{id}/events': ['get'],
  '/api/v1/proposals/{id}/decision': ['post'],
  '/api/v1/experience/shopping': ['get'],
} satisfies Readonly<Record<string, readonly string[]>>);

const parseJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    throw new Error('Staging acceptance received malformed JSON');
  }
};

const requireOkJson = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new Error('Staging acceptance HTTP gate failed');
  return parseJson(response);
};

const requireResponseRequestId = (response: Response): string => {
  const parsed = z.uuid().safeParse(response.headers.get('x-request-id'));
  if (!parsed.success) {
    throw new Error('Staging acceptance response request ID is invalid');
  }
  return parsed.data;
};

const cookiesFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0]!)
    .filter(Boolean);

const parseProblem = async (response: Response) => {
  if (
    response.headers.get('content-type')?.split(';', 1)[0]?.trim() !==
    'application/problem+json'
  ) {
    throw new Error('Staging acceptance problem response is invalid');
  }
  const headerRequestId = requireResponseRequestId(response);
  const parsed = ProblemResponseSchema.safeParse(await parseJson(response));
  if (
    !parsed.success ||
    parsed.data.status !== response.status ||
    parsed.data.requestId !== headerRequestId
  ) {
    throw new Error('Staging acceptance problem response is invalid');
  }
  return parsed.data;
};

const FinanceMemberInvitationProblemDiagnostic = Object.freeze({
  '400:invalid-input': 'member-invitation:http-400-invalid-input',
  '401:authentication-required':
    'member-invitation:http-401-authentication-required',
  '401:authentication-invalid':
    'member-invitation:http-401-authentication-invalid',
  '403:mutation-proof-invalid':
    'member-invitation:http-403-mutation-proof-invalid',
  '403:household-owner-required':
    'member-invitation:http-403-household-owner-required',
  '403:authorization-revoked':
    'member-invitation:http-403-authorization-revoked',
  '409:conflict': 'member-invitation:http-409-conflict',
  '500:internal-error': 'member-invitation:http-500-internal-error',
  '502:service-contract-invalid':
    'member-invitation:http-502-service-contract-invalid',
  '503:authentication-unavailable':
    'member-invitation:http-503-authentication-unavailable',
  '503:mutation-verification-unavailable':
    'member-invitation:http-503-mutation-verification-unavailable',
  '503:invalid-result': 'member-invitation:http-503-invalid-result',
} satisfies Readonly<Record<string, FinanceMemberInvitationDiagnostic>>);

const classifyFinanceMemberInvitationProblem = async (
  response: Response,
): Promise<FinanceMemberInvitationDiagnostic> => {
  try {
    const problem = await parseProblem(response);
    const key = `${problem.status}:${problem.code}`;
    return Object.hasOwn(FinanceMemberInvitationProblemDiagnostic, key)
      ? FinanceMemberInvitationProblemDiagnostic[
          key as keyof typeof FinanceMemberInvitationProblemDiagnostic
        ]
      : 'member-invitation:http-problem-unrecognized';
  } catch {
    return 'member-invitation:http-problem-unrecognized';
  }
};

const classifyFinanceDocumentUploadProblem = async (
  response: Response,
): Promise<FinanceDocumentUploadDiagnostic> => {
  try {
    const problem = await parseProblem(response);
    const diagnostic = FinanceDocumentUploadDiagnosticSchema.safeParse(
      `document-upload:http-${problem.status}-${problem.code}`,
    );
    return diagnostic.success
      ? diagnostic.data
      : 'document-upload:http-problem-unrecognized';
  } catch {
    return 'document-upload:http-problem-unrecognized';
  }
};

const TERMINAL_RUN_EVENT_TYPES = new Set([
  'approval.required',
  'run.completed',
  'run.failed',
  'run.indeterminate',
]);

type ParsedRunEvent = z.output<typeof RunEventSchema>;

const FinanceResumedRunFailureEnvelopeSchema = z
  .object({
    safeError: z.object({ code: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const financeResumedRunFailureDiagnostic = (
  terminalData: unknown,
): FinanceResumedRunFailureDiagnostic => {
  const envelope =
    FinanceResumedRunFailureEnvelopeSchema.safeParse(terminalData);
  if (!envelope.success) {
    return 'guarded-review-commit:resumed-run-failed outcome=invalid';
  }

  const { code } = envelope.data.safeError;
  if (code === 'approval-resume-binding-invalid') {
    return 'guarded-review-commit:resumed-run-failed outcome=approval-resume-binding-invalid';
  }
  if (code === 'approval-resume-failed') {
    return 'guarded-review-commit:resumed-run-failed outcome=approval-resume-failed';
  }
  const runnerCode = FinanceRecognizedRunnerSafeErrorCodeSchema.safeParse(code);
  if (!runnerCode.success) {
    return 'guarded-review-commit:resumed-run-failed outcome=unrecognized';
  }
  return FinanceResumedRunFailureDiagnosticSchema.parse(
    `guarded-review-commit:resumed-run-failed outcome=runner-${runnerCode.data}`,
  );
};

const InitialSseFailureCategory = Object.freeze({
  httpOrContentType: 'http-or-content-type',
  byteOrFraming: 'byte-or-framing',
  eventSchemaRunOrSequence: 'event-schema-run-or-sequence',
  terminalRunFailed: 'terminal-run-failed',
  terminalRunIndeterminate: 'terminal-run-indeterminate',
  terminalOtherOrCardinality: 'terminal-other-or-cardinality',
} as const);

type InitialSseFailureCategory =
  (typeof InitialSseFailureCategory)[keyof typeof InitialSseFailureCategory];

class InitialSseReadError extends Error {
  readonly category: InitialSseFailureCategory;

  constructor(category: InitialSseFailureCategory) {
    super('Initial SSE validation failed');
    this.category = category;
  }
}

const throwSseFailure = (
  initialSseDiagnostic: boolean | undefined,
  category: InitialSseFailureCategory,
  message: string,
): never => {
  if (initialSseDiagnostic === true) {
    throw new InitialSseReadError(category);
  }
  throw new Error(message);
};

const InitialSseDiagnosticByFailure = Object.freeze({
  [InitialSseFailureCategory.httpOrContentType]:
    'initial-sse-http-or-content-type-invalid',
  [InitialSseFailureCategory.byteOrFraming]:
    'initial-sse-byte-or-framing-invalid',
  [InitialSseFailureCategory.eventSchemaRunOrSequence]:
    'initial-sse-event-schema-run-or-sequence-invalid',
  [InitialSseFailureCategory.terminalRunFailed]:
    'initial-sse-terminal-run-failed',
  [InitialSseFailureCategory.terminalRunIndeterminate]:
    'initial-sse-terminal-run-indeterminate',
  [InitialSseFailureCategory.terminalOtherOrCardinality]:
    'initial-sse-terminal-other-or-cardinality-invalid',
} satisfies Record<
  InitialSseFailureCategory,
  FinanceInitialGuardedReviewDiagnostic
>);

const initialSseDiagnosticFromError = (
  error: unknown,
): FinanceInitialGuardedReviewDiagnostic | undefined =>
  error instanceof InitialSseReadError
    ? InitialSseDiagnosticByFailure[error.category]
    : undefined;

const readBoundedSseText = async (input: {
  readonly response: Response;
  readonly initialSseDiagnostic?: boolean;
}): Promise<string> => {
  const { response } = input;
  const responseMediaType = response.headers
    .get('content-type')
    ?.split(';', 1)
    .at(0)
    ?.trim()
    .toLowerCase();
  if (
    !response.ok ||
    response.redirected ||
    responseMediaType !== 'text/event-stream'
  ) {
    throwSseFailure(
      input.initialSseDiagnostic,
      InitialSseFailureCategory.httpOrContentType,
      'Acceptance run event stream failed',
    );
  }
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) ||
      Number(declaredLength) > FINANCE_SSE_MAXIMUM_BYTES)
  ) {
    throwSseFailure(
      input.initialSseDiagnostic,
      InitialSseFailureCategory.byteOrFraming,
      'Acceptance run event stream exceeds its byte bound',
    );
  }
  const responseReader = response.body?.getReader();
  if (responseReader === undefined) {
    throwSseFailure(
      input.initialSseDiagnostic,
      InitialSseFailureCategory.byteOrFraming,
      'Acceptance run event stream is not finite',
    );
  }
  const reader = responseReader!;
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throwSseFailure(
          input.initialSseDiagnostic,
          InitialSseFailureCategory.byteOrFraming,
          'Acceptance run event stream is invalid',
        );
      }
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > FINANCE_SSE_MAXIMUM_BYTES) {
        void reader.cancel();
        throwSseFailure(
          input.initialSseDiagnostic,
          InitialSseFailureCategory.byteOrFraming,
          'Acceptance run event stream exceeds its byte bound',
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (input.initialSseDiagnostic !== true) throw error;
    if (error instanceof InitialSseReadError) throw error;
    throwSseFailure(
      input.initialSseDiagnostic,
      InitialSseFailureCategory.byteOrFraming,
      'Acceptance run event stream is unreadable',
    );
  } finally {
    reader.releaseLock();
  }
  if (Buffer.byteLength(text, 'utf8') !== receivedBytes) {
    throwSseFailure(
      input.initialSseDiagnostic,
      InitialSseFailureCategory.byteOrFraming,
      'Acceptance run event stream encoding is invalid',
    );
  }
  return text;
};

/**
 * The authenticated route exposes a finite persisted replay, not a live
 * subscription. Refuse any framing ambiguity, discontinuity, duplicate
 * terminal, or terminal followed by another event.
 */
const readFiniteRunEvents = async (input: {
  readonly response: Response;
  readonly runId: string;
  readonly afterSequence: number;
  readonly expectedTerminalType: 'approval.required' | 'run.completed';
  /** Guarded-review diagnostics may distinguish only the static failed type. */
  readonly allowRunFailedTerminal?: boolean;
  /** Only the initial guarded-review replay emits categorized diagnostics. */
  readonly initialSseDiagnostic?: boolean;
}): Promise<readonly ParsedRunEvent[]> => {
  if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
    throw new Error('Acceptance run event cursor is invalid');
  }
  const text = await readBoundedSseText({
    response: input.response,
    initialSseDiagnostic: input.initialSseDiagnostic,
  });
  if (!text.endsWith('\n\n') || text.includes('\r')) {
    throwSseFailure(
      input.initialSseDiagnostic,
      InitialSseFailureCategory.byteOrFraming,
      'Acceptance run event stream framing is invalid',
    );
  }
  const frames = text.slice(0, -2).split('\n\n');
  if (
    frames.length === 0 ||
    frames.length > FINANCE_SSE_MAXIMUM_FRAMES ||
    frames.some((frame) => frame.length === 0)
  ) {
    throwSseFailure(
      input.initialSseDiagnostic,
      InitialSseFailureCategory.byteOrFraming,
      'Acceptance run event stream frame count is invalid',
    );
  }
  let expectedSequence = input.afterSequence + 1;
  const events: ParsedRunEvent[] = [];
  for (const frame of frames) {
    const lines = frame.split('\n');
    if (
      lines.length !== 3 ||
      !lines[0]!.startsWith('id: ') ||
      !lines[1]!.startsWith('event: ') ||
      !lines[2]!.startsWith('data: ')
    ) {
      throwSseFailure(
        input.initialSseDiagnostic,
        InitialSseFailureCategory.byteOrFraming,
        'Acceptance run event stream framing is invalid',
      );
    }
    const eventId = lines[0]!.slice('id: '.length);
    const eventType = lines[1]!.slice('event: '.length);
    const serialized = lines[2]!.slice('data: '.length);
    if (
      !/^[1-9][0-9]*$/u.test(eventId) ||
      eventType.length === 0 ||
      serialized.length === 0
    ) {
      throwSseFailure(
        input.initialSseDiagnostic,
        InitialSseFailureCategory.byteOrFraming,
        'Acceptance run event stream frame is invalid',
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throwSseFailure(
        input.initialSseDiagnostic,
        InitialSseFailureCategory.eventSchemaRunOrSequence,
        'Acceptance run event stream JSON is invalid',
      );
    }
    const parsed = RunEventSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.runId !== input.runId ||
      parsed.data.type !== eventType ||
      parsed.data.sequence !== expectedSequence ||
      eventId !== String(parsed.data.sequence)
    ) {
      throwSseFailure(
        input.initialSseDiagnostic,
        InitialSseFailureCategory.eventSchemaRunOrSequence,
        'Acceptance run event sequence is invalid',
      );
    }
    events.push(parsed.data!);
    expectedSequence += 1;
  }
  const terminals = events.filter((event) =>
    TERMINAL_RUN_EVENT_TYPES.has(event.type),
  );
  const terminal = terminals[0];
  if (terminal === undefined) {
    throwSseFailure(
      input.initialSseDiagnostic,
      InitialSseFailureCategory.terminalOtherOrCardinality,
      'Acceptance run terminal event is ambiguous',
    );
  }
  const resolvedTerminal = terminal!;
  if (terminals.length !== 1 || resolvedTerminal !== events.at(-1)) {
    throwSseFailure(
      input.initialSseDiagnostic,
      InitialSseFailureCategory.terminalOtherOrCardinality,
      'Acceptance run terminal event is ambiguous',
    );
  }
  if (resolvedTerminal.type !== input.expectedTerminalType) {
    const allowsRunFailedTerminal =
      input.allowRunFailedTerminal === true &&
      input.expectedTerminalType === 'run.completed' &&
      resolvedTerminal.type === 'run.failed';
    if (allowsRunFailedTerminal) return Object.freeze(events);
    if (resolvedTerminal.type === 'run.failed') {
      throwSseFailure(
        input.initialSseDiagnostic,
        InitialSseFailureCategory.terminalRunFailed,
        'Acceptance run terminal event is ambiguous',
      );
    }
    if (resolvedTerminal.type === 'run.indeterminate') {
      throwSseFailure(
        input.initialSseDiagnostic,
        InitialSseFailureCategory.terminalRunIndeterminate,
        'Acceptance run terminal event is ambiguous',
      );
    }
    throwSseFailure(
      input.initialSseDiagnostic,
      InitialSseFailureCategory.terminalOtherOrCardinality,
      'Acceptance run terminal event is ambiguous',
    );
  }
  return Object.freeze(events);
};

const ProviderFreeShoppingResultSchema = z.object({
  status: z.literal('completed'),
  runId: z.uuid(),
  output: z.object({
    shoppingItem: z.object({
      id: z.string().trim().min(1),
      name: z.literal('Acceptance milk'),
      unit: z.literal('each'),
      quantityMinorUnits: z.literal(2_000),
    }),
  }),
  executionResolution: z.strictObject({
    status: z.literal('provider-free'),
    profile: z.literal('shopping-list-v1'),
    reason: z.literal('provider-free-mvp'),
  }),
});
const ProviderFreeShoppingCompletedEventSchema = RunEventSchema.extend({
  type: z.literal('run.completed'),
  data: ProviderFreeShoppingResultSchema,
});

const readCompletedRun = async (response: Response, runId: string) => {
  const events = await readFiniteRunEvents({
    response,
    runId,
    afterSequence: 0,
    expectedTerminalType: 'run.completed',
  });
  const terminal = ProviderFreeShoppingCompletedEventSchema.safeParse(
    events.at(-1),
  );
  if (!terminal.success || terminal.data.data.runId !== runId) {
    throw new Error(
      'Provider-free run did not complete with the exact shopping result',
    );
  }
  return terminal.data.data;
};

const runProviderFreeStagingAcceptance = async (
  input: StagingAcceptanceCommandInput,
): Promise<{
  readonly schemaVersion: 1;
  readonly evidenceClass: 'staging-http-subset-probe';
  readonly releaseEligible: false;
  readonly environment: 'staging';
  readonly sourceSha: string;
  readonly observedAt: string;
  readonly execution: {
    readonly workflow: '.github/workflows/staging.yml';
    readonly runId: string;
    readonly event: 'workflow_dispatch';
  };
  readonly proof: {
    readonly healthz: 'passed';
    readonly syntheticHttpSubsetReadiness: 'passed';
    readonly authenticatedManagerShoppingFlow: 'passed';
    readonly protectedMetrics: 'passed';
    readonly requestIds: 'passed';
    readonly problemJson: 'passed';
  };
}> => {
  const configuration = AcceptanceConfigurationSchema.safeParse({
    apiOrigin: input.environment.EMDO_STAGING_API_ORIGIN,
    environment: input.environment.EMDO_ENVIRONMENT,
    workerProvidersEnabled: input.environment.EMDO_EXTERNAL_PROVIDERS_ENABLED,
    ownerEmail: input.environment.EMDO_SYNTHETIC_OWNER_EMAIL,
    ownerPassword: input.environment.EMDO_SYNTHETIC_OWNER_PASSWORD,
    publicOrigin: input.environment.EMDO_PUBLIC_ORIGIN,
    sourceSha: input.environment.EMDO_STAGING_SOURCE_SHA,
    syntheticDataOnly: input.environment.EMDO_SYNTHETIC_DATA_ONLY,
    workflowRunId: input.environment.EMDO_STAGING_WORKFLOW_RUN_ID,
  });
  if (
    input.argv.length !== 3 ||
    input.argv[0] !== '--all-mvp-gates' ||
    input.argv[1] !== '--require-synthetic' ||
    input.argv[2] !== '--forbid-worker-provider-execution' ||
    !configuration.success
  ) {
    throw new Error('Staging acceptance configuration is invalid');
  }
  const config = configuration.data;
  const fetchRequest =
    input.fetch ?? ((request: Request) => globalThis.fetch(request));
  const send = async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, `${config.apiOrigin}/`);
    if (url.origin !== config.apiOrigin) {
      throw new Error('External network access is forbidden during acceptance');
    }
    return fetchRequest(
      new Request(url, {
        ...init,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(15_000),
      }),
    );
  };

  const healthResponse = await send('/healthz');
  requireResponseRequestId(healthResponse);
  const health = z
    .strictObject({ status: z.literal('ok') })
    .parse(await requireOkJson(healthResponse));
  if (health.status !== 'ok') throw new Error('Liveness gate failed');
  const readinessResponse = await send('/synthetic-staging/readyz');
  requireResponseRequestId(readinessResponse);
  const readiness = ApiSyntheticHttpSubsetReadinessSuccessSchema.safeParse(
    await requireOkJson(readinessResponse),
  );
  if (!readiness.success) {
    throw new Error(
      'Readiness checks do not match synthetic HTTP subset contract version 1',
    );
  }
  const metrics = await send('/metrics');
  if (metrics.status !== 404) {
    throw new Error('Protected metrics gate failed');
  }
  const openapi = z
    .object({
      openapi: z.literal('3.1.0'),
      paths: z.record(z.string(), z.unknown()),
    })
    .parse(await requireOkJson(await send('/openapi.json')));
  if (
    Object.entries(requiredOpenApiOperations).some(([path, methods]) => {
      const pathItem = openapi.paths[path];
      return (
        pathItem === null ||
        typeof pathItem !== 'object' ||
        methods.some(
          (method) =>
            !Object.hasOwn(
              pathItem as Readonly<Record<string, unknown>>,
              method,
            ),
        )
      );
    }) ||
    Object.hasOwn(openapi.paths, '/api/auth/sign-up/email')
  ) {
    throw new Error('Browser/API contract gate failed');
  }

  const signIn = await send('/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: config.publicOrigin,
      'idempotency-key': 'staging-acceptance-sign-in-v1',
    },
    body: JSON.stringify({
      email: config.ownerEmail,
      password: config.ownerPassword,
    }),
  });
  if (!signIn.ok) throw new Error('Synthetic acceptance sign-in failed');
  const cookies = [...cookiesFrom(signIn)];
  if (
    !cookies.some((cookie) => cookie.startsWith('__Secure-emdo.session_token='))
  ) {
    throw new Error('Synthetic acceptance session was not issued');
  }
  await requireOkJson(
    await send('/api/auth/get-session', {
      headers: { cookie: cookies.join('; ') },
    }),
  );
  const csrfResponse = await send('/api/v1/auth/csrf', {
    headers: { cookie: cookies.join('; ') },
  });
  const csrf = z
    .strictObject({ schemaVersion: z.literal(1), token: z.string().min(24) })
    .parse(await requireOkJson(csrfResponse));
  cookies.push(...cookiesFrom(csrfResponse));
  const mutationHeaders = {
    'content-type': 'application/json',
    cookie: cookies.join('; '),
    origin: config.publicOrigin,
    'x-csrf-token': csrf.token,
  };

  const turnResponse = await send('/api/v1/turns', {
    method: 'POST',
    headers: {
      ...mutationHeaders,
      'idempotency-key': 'staging-provider-free-shopping-v1',
    },
    body: JSON.stringify({
      schemaVersion: 1,
      message: 'add 2 each Acceptance milk to shopping list',
      routeHint: 'shopping',
    }),
  });
  if (turnResponse.status !== 202) {
    throw new Error('Provider-free manager turn was not accepted');
  }
  const turn = TurnAcceptanceSchema.parse(await requireOkJson(turnResponse));
  const completed = await readCompletedRun(
    await send(turn.eventsPath, {
      headers: {
        cookie: cookies.join('; '),
        accept: 'text/event-stream',
      },
    }),
    turn.runId,
  );
  const shopping = ShoppingPageSchema.parse(
    await requireOkJson(
      await send('/api/v1/experience/shopping?limit=50', {
        headers: { cookie: cookies.join('; ') },
      }),
    ),
  );
  const item = shopping.items.find(
    (candidate) => candidate.id === completed.output.shoppingItem.id,
  );
  if (
    item === undefined ||
    item.name !== 'Acceptance milk' ||
    item.unit !== 'each' ||
    item.quantityMinorUnits !== 2_000 ||
    item.state !== 'active'
  ) {
    throw new Error(
      'Provider-free shopping readback did not match the completed result',
    );
  }

  const decisionKey = 'staging-visual-defense-v1';
  const decision = await send(
    `/api/v1/proposals/${ACCEPTANCE_PROPOSAL}/decision`,
    {
      method: 'POST',
      headers: { ...mutationHeaders, 'idempotency-key': decisionKey },
      body: JSON.stringify({
        schemaVersion: 1,
        proposalId: ACCEPTANCE_PROPOSAL,
        payloadHash: 'a'.repeat(64),
        approvalHash: 'b'.repeat(64),
        decision: 'approved',
        idempotencyKey: decisionKey,
      }),
    },
  );
  if (
    decision.status !== 403 ||
    (await parseProblem(decision)).code !== 'visual-approval-required'
  ) {
    throw new Error('Visual approval defense gate failed');
  }

  const observedAt = (input.now?.() ?? new Date()).toISOString();
  return Object.freeze({
    schemaVersion: 1 as const,
    evidenceClass: 'staging-http-subset-probe' as const,
    releaseEligible: false as const,
    environment: 'staging' as const,
    sourceSha: config.sourceSha,
    observedAt,
    execution: Object.freeze({
      workflow: '.github/workflows/staging.yml' as const,
      runId: config.workflowRunId,
      event: 'workflow_dispatch' as const,
    }),
    proof: Object.freeze({
      healthz: 'passed' as const,
      syntheticHttpSubsetReadiness: 'passed' as const,
      authenticatedManagerShoppingFlow: 'passed' as const,
      protectedMetrics: 'passed' as const,
      requestIds: 'passed' as const,
      problemJson: 'passed' as const,
    }),
  });
};

const requiredFinanceOpenApiOperations = Object.freeze({
  '/api/auth/get-session': ['get'],
  '/api/auth/sign-in/email': ['post'],
  '/api/v1/auth/csrf': ['get'],
  '/api/v1/auth/invitations/csrf': ['get'],
  '/api/v1/auth/invitations/redeem': ['post'],
  '/api/v1/household/invitations': ['post'],
  '/api/v1/household/memberships': ['get'],
  '/api/v1/turns': ['post'],
  '/api/v1/runs/{id}/events': ['get'],
  '/api/v1/proposals/{id}': ['get'],
  '/api/v1/proposals/{id}/visual-proof': ['post'],
  '/api/v1/proposals/{id}/decision': ['post'],
  '/api/v1/finance/documents': ['get', 'post'],
  '/api/v1/finance/documents/{id}': ['get', 'delete'],
  '/api/v1/finance/documents/{id}/original': ['get'],
  '/api/v1/finance/documents/{id}/review': ['get', 'patch'],
  '/api/v1/finance/documents/{id}/review/commit': ['post'],
  '/api/v1/finance/documents/{id}/matches': ['get'],
  '/api/v1/finance/evidence/{id}': ['get'],
  '/api/v1/experience/finance': ['get'],
} satisfies Readonly<Record<string, readonly string[]>>);

const exactArguments = (
  actual: readonly string[],
  expected: readonly string[],
): boolean =>
  actual.length === expected.length &&
  actual.every((argument, index) => argument === expected[index]);

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const assertRequiredOpenApiOperations = (
  paths: Readonly<Record<string, unknown>>,
  operations: Readonly<Record<string, readonly string[]>>,
): void => {
  if (
    Object.entries(operations).some(([path, methods]) => {
      const pathItem = paths[path];
      return (
        pathItem === null ||
        typeof pathItem !== 'object' ||
        methods.some(
          (method) =>
            !Object.hasOwn(
              pathItem as Readonly<Record<string, unknown>>,
              method,
            ),
        )
      );
    }) ||
    Object.hasOwn(paths, '/api/v1/finance/chat') ||
    Object.hasOwn(paths, '/api/internal/finance-synthetic/invitation-token')
  ) {
    throw new Error('Finance staging browser/API contract gate failed');
  }
};

const FinanceApprovalInterruptionSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9._:-]+$/u),
  agentId: z.literal('finance'),
  capabilityId: z.literal('finance.records.write'),
  proposalId: z.uuid(),
  argumentsPreview: z.unknown(),
});

const FinanceNeedsApprovalTerminalSchema = z
  .object({
    status: z.literal('needs-approval'),
    runId: z.uuid(),
    interruptions: z.array(FinanceApprovalInterruptionSchema).length(1),
  })
  .passthrough();

const FinanceEmdoOutputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(12_000),
  clarificationQuestion: z.string().trim().min(1).max(500).nullable(),
  evidenceReferences: z.array(z.string().trim().min(1).max(512)).max(128),
  derivedValueReferences: z.array(z.string().trim().min(1).max(512)).max(128),
  actionProposalReferences: z.array(z.string().trim().min(1).max(512)).max(64),
});

const FinanceCompletedTerminalSchema = z
  .object({
    status: z.literal('completed'),
    runId: z.uuid(),
  })
  .passthrough();

const financeApprovalFromTerminal = (input: {
  readonly event: ParsedRunEvent | undefined;
  readonly runId: string;
  readonly documentId: string;
}) => {
  if (input.event?.type !== 'approval.required') {
    throw new Error('Finance guarded turn did not require visual approval');
  }
  const terminal = FinanceNeedsApprovalTerminalSchema.safeParse(
    input.event.data,
  );
  if (!terminal.success || terminal.data.runId !== input.runId) {
    throw new Error('Finance guarded approval terminal is invalid');
  }
  const interruption = terminal.data.interruptions[0];
  if (
    interruption === undefined ||
    interruption.proposalId.length === 0 ||
    input.documentId.length === 0
  ) {
    throw new Error('Finance guarded approval interruption is invalid');
  }
  return Object.freeze({
    interruptionId: interruption.id,
    proposalId: interruption.proposalId,
  });
};

const financeCompletedFromTerminal = (input: {
  readonly event: ParsedRunEvent | undefined;
  readonly runId: string;
}) => {
  if (input.event?.type !== 'run.completed') {
    throw new Error('Finance EMDO turn did not complete');
  }
  const terminal = FinanceCompletedTerminalSchema.safeParse(input.event.data);
  if (!terminal.success || terminal.data.runId !== input.runId) {
    throw new Error('Finance EMDO completion terminal is invalid');
  }
  return terminal.data;
};

const financeOutputFromCompletedTerminal = (input: {
  readonly event: ParsedRunEvent | undefined;
  readonly runId: string;
}) => {
  const completed = financeCompletedFromTerminal(input);
  const output = FinanceEmdoOutputSchema.safeParse(completed.output);
  if (!output.success) {
    throw new Error('Finance EMDO completion output is invalid');
  }
  return output.data;
};

type SameOriginSend = (path: string, init?: RequestInit) => Promise<Response>;

type FinanceTurnSubmissionInput = {
  readonly send: SameOriginSend;
  readonly mutationHeaders: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
  readonly message: string;
};

const submitFinanceTurn = async (input: FinanceTurnSubmissionInput) => {
  const response = await input.send('/api/v1/turns', {
    method: 'POST',
    headers: {
      ...input.mutationHeaders,
      'content-type': 'application/json',
      'idempotency-key': input.idempotencyKey,
    },
    body: JSON.stringify({
      schemaVersion: 1,
      message: input.message,
      routeHint: 'finance',
    }),
  });
  requireResponseRequestId(response);
  if (response.status !== 202) {
    throw new Error('Finance EMDO turn was not accepted');
  }
  return response;
};

const acceptFinanceTurn = async (input: FinanceTurnSubmissionInput) => {
  const response = await submitFinanceTurn(input);
  return TurnAcceptanceSchema.parse(await requireOkJson(response));
};

type FinanceTurnEventsInput = {
  readonly send: SameOriginSend;
  readonly cookie: string;
  readonly turn: z.output<typeof TurnAcceptanceSchema>;
  readonly afterSequence: number;
  readonly expectedTerminalType: 'approval.required' | 'run.completed';
  readonly allowRunFailedTerminal?: boolean;
  readonly initialSseDiagnostic?: boolean;
};

const requestFinanceTurnEvents = async (input: FinanceTurnEventsInput) => {
  return input.send(input.turn.eventsPath, {
    headers: {
      cookie: input.cookie,
      accept: 'text/event-stream',
      ...(input.afterSequence === 0
        ? {}
        : { 'last-event-id': String(input.afterSequence) }),
    },
  });
};

const parseFinanceTurnEvents = async (
  input: FinanceTurnEventsInput & { readonly response: Response },
) =>
  readFiniteRunEvents({
    response: input.response,
    runId: input.turn.runId,
    afterSequence: input.afterSequence,
    expectedTerminalType: input.expectedTerminalType,
    ...(input.allowRunFailedTerminal === undefined
      ? {}
      : { allowRunFailedTerminal: input.allowRunFailedTerminal }),
    ...(input.initialSseDiagnostic === true
      ? { initialSseDiagnostic: true }
      : {}),
  });

const readFinanceTurnEvents = async (input: FinanceTurnEventsInput) =>
  parseFinanceTurnEvents({
    ...input,
    response: await requestFinanceTurnEvents(input),
  });

const approveAndResumeFinanceTurn = async (input: {
  readonly send: SameOriginSend;
  readonly cookie: string;
  readonly mutationHeaders: Readonly<Record<string, string>>;
  readonly turn: z.output<typeof TurnAcceptanceSchema>;
  readonly initialEvents: readonly ParsedRunEvent[];
  readonly proposalId: string;
  readonly decisionIdempotencyKey: string;
  readonly allowRunFailedTerminal?: boolean;
  readonly guardedReviewStageReporter?: (
    progress: FinanceStagingAcceptanceProgress,
  ) => void;
}) => {
  const initialTerminal = input.initialEvents.at(-1);
  if (initialTerminal === undefined) {
    throw new Error('Finance guarded turn did not produce a terminal event');
  }
  input.guardedReviewStageReporter?.('guarded-review-commit:proposal-read');
  const proposalResponse = await input.send(
    `/api/v1/proposals/${encodeURIComponent(input.proposalId)}`,
    { headers: { cookie: input.cookie } },
  );
  requireResponseRequestId(proposalResponse);
  const proposal = ProposalApprovalViewSchema.parse(
    await requireOkJson(proposalResponse),
  );
  if (proposal.id !== input.proposalId || proposal.state !== 'pending') {
    throw new Error('Finance proposal approval view is invalid');
  }
  input.guardedReviewStageReporter?.('guarded-review-commit:visual-proof');
  const proofResponse = await input.send(
    `/api/v1/proposals/${encodeURIComponent(input.proposalId)}/visual-proof`,
    {
      method: 'POST',
      headers: {
        ...input.mutationHeaders,
        'content-type': 'application/json',
        'idempotency-key': `${input.decisionIdempotencyKey}:proof`,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        proposalVersion: proposal.version,
        payloadHash: proposal.payloadHash,
        approvalHash: proposal.approvalHash,
      }),
    },
  );
  requireResponseRequestId(proofResponse);
  const proof = VisualProofSchema.parse(await requireOkJson(proofResponse));
  if (
    proof.proposalId !== proposal.id ||
    proof.proposalVersion !== proposal.version ||
    proof.payloadHash !== proposal.payloadHash ||
    proof.approvalHash !== proposal.approvalHash
  ) {
    throw new Error('Finance visual proof is not bound to the proposal');
  }
  input.guardedReviewStageReporter?.('guarded-review-commit:decision-receipt');
  const decisionResponse = await input.send(
    `/api/v1/proposals/${encodeURIComponent(input.proposalId)}/decision`,
    {
      method: 'POST',
      headers: {
        ...input.mutationHeaders,
        'content-type': 'application/json',
        'idempotency-key': input.decisionIdempotencyKey,
        'x-emdo-visual-confirmation': proof.proofToken,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        proposalId: proposal.id,
        payloadHash: proposal.payloadHash,
        approvalHash: proposal.approvalHash,
        decision: 'approved',
        idempotencyKey: input.decisionIdempotencyKey,
      }),
    },
  );
  requireResponseRequestId(decisionResponse);
  const decision = ActionDecisionReceiptSchema.parse(
    await requireOkJson(decisionResponse),
  );
  if (
    decision.proposalId !== proposal.id ||
    decision.payloadHash !== proposal.payloadHash ||
    decision.approvalHash !== proposal.approvalHash ||
    decision.decision !== 'approved' ||
    decision.channel !== 'authenticated-visual' ||
    decision.idempotencyKey !== input.decisionIdempotencyKey
  ) {
    throw new Error('Finance visual approval decision is invalid');
  }
  input.guardedReviewStageReporter?.('guarded-review-commit:resumed-run');
  const resumedEvents = await readFinanceTurnEvents({
    send: input.send,
    cookie: input.cookie,
    turn: input.turn,
    afterSequence: initialTerminal.sequence,
    expectedTerminalType: 'run.completed',
    ...(input.allowRunFailedTerminal === undefined
      ? {}
      : { allowRunFailedTerminal: input.allowRunFailedTerminal }),
  });
  if (resumedEvents.at(-1)?.type === 'run.failed') {
    input.guardedReviewStageReporter?.(
      financeResumedRunFailureDiagnostic(resumedEvents.at(-1)?.data),
    );
    throw new Error('Finance guarded turn failed after approval');
  }
  return resumedEvents;
};

const financeDocumentDetailFor = async (input: {
  readonly documentId: string;
  readonly send: (path: string, init?: RequestInit) => Promise<Response>;
  readonly cookie: string;
}) => {
  const response = await input.send(
    `/api/v1/finance/documents/${encodeURIComponent(input.documentId)}`,
    { headers: { cookie: input.cookie } },
  );
  requireResponseRequestId(response);
  return FinanceDocumentDetailSchema.parse(await requireOkJson(response));
};

const requireCrossUserFinanceDenial = async (
  response: Response,
): Promise<void> => {
  requireResponseRequestId(response);
  if (response.status !== 403 && response.status !== 404) {
    throw new Error('Finance cross-user scope defense gate failed');
  }
  await parseProblem(response);
};

const waitForFinanceReview = async (input: {
  readonly documentId: string;
  readonly send: (path: string, init?: RequestInit) => Promise<Response>;
  readonly cookie: string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly maxPolls: number;
}) => {
  for (let attempt = 0; attempt < input.maxPolls; attempt += 1) {
    const detail = await financeDocumentDetailFor(input);
    if (detail.document.state === 'awaiting-review') return detail;
    if (
      detail.document.state === 'failed' ||
      detail.document.state === 'deleted' ||
      detail.document.state === 'deleting'
    ) {
      throw new Error('Finance document extraction did not reach review');
    }
    if (attempt + 1 < input.maxPolls) {
      await input.sleep(FINANCE_EXTRACTION_POLL_INTERVAL_MS);
    }
  }
  throw new Error('Finance document extraction timed out before review');
};

type FinanceStagingAcceptanceResult = Readonly<{
  readonly schemaVersion: 1;
  readonly evidenceClass: 'finance-synthetic-staging-probe';
  readonly releaseEligible: false;
  readonly outcome: 'blocked';
  readonly environment: 'staging';
  readonly sourceSha: string;
  readonly observedAt: string;
  readonly execution: Readonly<{
    readonly workflow: '.github/workflows/staging.yml';
    readonly runId: string;
    readonly event: 'workflow_dispatch';
  }>;
  readonly proof: Readonly<{
    readonly healthz: 'passed';
    readonly financeDocumentSurface: 'passed';
    readonly authenticatedSyntheticOwner: 'passed';
    readonly extractionToReview: 'passed';
    readonly encryptedOriginalHashReadback: 'passed';
    readonly reviewEdit: 'passed';
    readonly guardedReviewCommit: 'passed';
    readonly directSafeWrite: 'passed';
    readonly guardedDeleteDenial: 'passed';
    readonly unauthenticatedOriginalDenial: 'passed';
    readonly authenticatedSyntheticMember: 'passed';
    readonly crossUserScopeDenial: 'passed';
    readonly financeQnaThroughEmdo: 'passed';
    readonly citedEvidenceReadback: 'passed';
    readonly approvedDeletePurge: 'blocked';
    readonly backupRestore: 'blocked';
  }>;
  readonly blockers: readonly [
    'approved-document-purge-awaiting-backup',
    'backup-restore-awaiting-root-drill',
  ];
}>;

type FinanceStagingFinalizeResult = Readonly<{
  readonly schemaVersion: 1;
  readonly evidenceClass: 'finance-synthetic-staging-probe';
  readonly releaseEligible: false;
  readonly outcome: 'passed';
  readonly environment: 'staging';
  readonly sourceSha: string;
  readonly observedAt: string;
  readonly execution: Readonly<{
    readonly workflow: '.github/workflows/staging.yml';
    readonly runId: string;
    readonly event: 'workflow_dispatch';
  }>;
  readonly proof: Readonly<{
    readonly healthz: 'passed';
    readonly financeDocumentSurface: 'passed';
    readonly authenticatedSyntheticOwner: 'passed';
    readonly extractionToReview: 'passed';
    readonly encryptedOriginalHashReadback: 'passed';
    readonly reviewEdit: 'passed';
    readonly guardedReviewCommit: 'passed';
    readonly directSafeWrite: 'passed';
    readonly guardedDeleteDenial: 'passed';
    readonly unauthenticatedOriginalDenial: 'passed';
    readonly authenticatedSyntheticMember: 'passed';
    readonly crossUserScopeDenial: 'passed';
    readonly financeQnaThroughEmdo: 'passed';
    readonly citedEvidenceReadback: 'passed';
    readonly approvedDeletePurge: 'passed';
    readonly guardedDeleteThroughEmdo: 'passed';
    readonly deletedTombstonePurge: 'passed';
    readonly ownerContentRevocation: 'passed';
    readonly memberContentRevocation: 'passed';
    readonly backupRestore: 'passed';
  }>;
  readonly blockers: readonly [];
}>;

const runFinanceStagingAcceptance = async (
  input: StagingAcceptanceCommandInput,
): Promise<FinanceStagingAcceptanceResult> => {
  input.financeStageReporter?.('configuration');
  const configuration = FinanceAcceptanceConfigurationSchema.safeParse({
    apiOrigin: input.environment.EMDO_STAGING_API_ORIGIN,
    environment: input.environment.EMDO_ENVIRONMENT,
    financeSyntheticStaging: input.environment.EMDO_FINANCE_SYNTHETIC_STAGING,
    ownerEmail: input.environment.EMDO_SYNTHETIC_OWNER_EMAIL,
    ownerPassword: input.environment.EMDO_SYNTHETIC_OWNER_PASSWORD,
    publicOrigin: input.environment.EMDO_PUBLIC_ORIGIN,
    sourceSha: input.environment.EMDO_STAGING_SOURCE_SHA,
    syntheticDataOnly: input.environment.EMDO_SYNTHETIC_DATA_ONLY,
    workerProvidersEnabled: input.environment.EMDO_EXTERNAL_PROVIDERS_ENABLED,
    workflowRunId: input.environment.EMDO_STAGING_WORKFLOW_RUN_ID,
  });
  const maxPolls =
    input.financeExtractionMaxPolls ?? FINANCE_EXTRACTION_MAX_POLLS;
  if (
    !exactArguments(input.argv, FINANCE_ACCEPTANCE_ARGS) ||
    !configuration.success ||
    !Number.isInteger(maxPolls) ||
    maxPolls < 1 ||
    maxPolls > FINANCE_EXTRACTION_MAX_POLLS
  ) {
    throw new Error('Finance staging acceptance configuration is invalid');
  }
  const config = configuration.data;
  input.financeStageReporter?.('health-and-contract');
  const fetchRequest =
    input.fetch ?? ((request: Request) => globalThis.fetch(request));
  const send = async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, `${config.apiOrigin}/`);
    if (url.origin !== config.apiOrigin) {
      throw new Error('External network access is forbidden during acceptance');
    }
    return fetchRequest(
      new Request(url, {
        ...init,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(15_000),
      }),
    );
  };

  const healthResponse = await send('/healthz');
  requireResponseRequestId(healthResponse);
  const health = z
    .strictObject({ status: z.literal('ok') })
    .parse(await requireOkJson(healthResponse));
  if (health.status !== 'ok') throw new Error('Finance liveness gate failed');

  const openapi = z
    .object({
      openapi: z.literal('3.1.0'),
      paths: z.record(z.string(), z.unknown()),
    })
    .parse(await requireOkJson(await send('/openapi.json')));
  assertRequiredOpenApiOperations(
    openapi.paths,
    requiredFinanceOpenApiOperations,
  );

  input.financeStageReporter?.('owner-authentication');
  const signIn = await send('/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: config.publicOrigin,
      'idempotency-key': 'finance-staging-owner-sign-in-v1',
    },
    body: JSON.stringify({
      email: config.ownerEmail,
      password: config.ownerPassword,
    }),
  });
  if (!signIn.ok) throw new Error('Finance synthetic owner sign-in failed');
  const cookies = [...cookiesFrom(signIn)];
  if (
    !cookies.some((cookie) => cookie.startsWith('__Secure-emdo.session_token='))
  ) {
    throw new Error('Finance synthetic owner session was not issued');
  }
  const cookie = cookies.join('; ');
  const session = z
    .object({ user: z.object({ id: z.uuid() }) })
    .parse(
      await requireOkJson(
        await send('/api/auth/get-session', { headers: { cookie } }),
      ),
    );
  if (session.user.id.length === 0) {
    throw new Error('Finance synthetic owner session is invalid');
  }
  const csrfResponse = await send('/api/v1/auth/csrf', {
    headers: { cookie },
  });
  const csrf = z
    .strictObject({ schemaVersion: z.literal(1), token: z.string().min(24) })
    .parse(await requireOkJson(csrfResponse));
  cookies.push(...cookiesFrom(csrfResponse));
  const ownerCookie = cookies.join('; ');
  const mutationHeaders = {
    cookie: ownerCookie,
    origin: config.publicOrigin,
    'x-csrf-token': csrf.token,
  };

  input.financeStageReporter?.('member-invitation');
  let issueInvitation: Response;
  try {
    issueInvitation = await send('/api/v1/household/invitations', {
      method: 'POST',
      headers: {
        ...mutationHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'finance-staging-secondary-member-invitation-v1',
      },
      body: JSON.stringify({
        schemaVersion: 1,
        email: FINANCE_SYNTHETIC_MEMBER_EMAIL,
        role: 'member',
        expiresInSeconds: 900,
      }),
    });
  } catch (error) {
    input.financeStageReporter?.('member-invitation:request-or-network-failed');
    throw error;
  }
  if (issueInvitation.status !== 201) {
    input.financeStageReporter?.(
      await classifyFinanceMemberInvitationProblem(issueInvitation),
    );
    throw new Error('Finance synthetic member invitation was not issued');
  }
  let issuedInvitation: z.output<typeof HouseholdInvitationIssueResponseSchema>;
  try {
    requireResponseRequestId(issueInvitation);
    issuedInvitation = HouseholdInvitationIssueResponseSchema.parse(
      await requireOkJson(issueInvitation),
    );
    if (
      issuedInvitation.replayed ||
      issuedInvitation.invitation.email !== FINANCE_SYNTHETIC_MEMBER_EMAIL ||
      issuedInvitation.invitation.role !== 'member' ||
      issuedInvitation.invitation.status !== 'pending' ||
      issuedInvitation.invitation.deliveryStatus !== 'queued'
    ) {
      throw new Error(
        'Finance synthetic member invitation readback is invalid',
      );
    }
  } catch (error) {
    input.financeStageReporter?.('member-invitation:readback-invalid');
    throw error;
  }

  input.financeStageReporter?.('member-token-handoff');
  const handoffResponse = await send(
    '/api/internal/finance-synthetic/invitation-token',
    {
      method: 'POST',
      headers: {
        ...mutationHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'finance-staging-secondary-member-handoff-v1',
      },
      body: JSON.stringify({ invitationId: issuedInvitation.invitation.id }),
    },
  );
  requireResponseRequestId(handoffResponse);
  const invitationToken = z
    .strictObject({
      schemaVersion: z.literal(1),
      invitationToken: z
        .string()
        .length(43)
        .regex(/^[A-Za-z0-9_-]+$/u),
    })
    .parse(await requireOkJson(handoffResponse)).invitationToken;

  input.financeStageReporter?.('member-redemption');
  const invitationCsrfResponse = await send('/api/v1/auth/invitations/csrf');
  requireResponseRequestId(invitationCsrfResponse);
  const invitationCsrf = z
    .strictObject({ schemaVersion: z.literal(1), token: z.string().min(24) })
    .parse(await requireOkJson(invitationCsrfResponse));
  const invitationCookies = cookiesFrom(invitationCsrfResponse);
  if (invitationCookies.length === 0) {
    throw new Error('Finance synthetic invitation CSRF cookie was not issued');
  }
  const redemptionResponse = await send('/api/v1/auth/invitations/redeem', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: invitationCookies.join('; '),
      origin: config.publicOrigin,
      'x-csrf-token': invitationCsrf.token,
      'idempotency-key': 'finance-staging-secondary-member-redemption-v1',
    },
    body: JSON.stringify({
      schemaVersion: 1,
      displayName: FINANCE_SYNTHETIC_MEMBER_NAME,
      email: FINANCE_SYNTHETIC_MEMBER_EMAIL,
      invitationId: issuedInvitation.invitation.id,
      invitationToken,
      password: config.ownerPassword,
    }),
  });
  requireResponseRequestId(redemptionResponse);
  if (redemptionResponse.status !== 201) {
    throw new Error('Finance synthetic member invitation was not redeemed');
  }
  const redeemed = InvitationRedeemResponseSchema.parse(
    await requireOkJson(redemptionResponse),
  );
  if (
    redeemed.role !== 'member' ||
    redeemed.householdId.length === 0 ||
    redeemed.userId === session.user.id
  ) {
    throw new Error('Finance synthetic member redemption readback is invalid');
  }

  input.financeStageReporter?.('member-membership-readback');
  const membershipsResponse = await send('/api/v1/household/memberships', {
    headers: { cookie: ownerCookie },
  });
  requireResponseRequestId(membershipsResponse);
  const memberships = HouseholdMembershipListResponseSchema.parse(
    await requireOkJson(membershipsResponse),
  );
  if (
    !memberships.memberships.some(
      (membership) =>
        membership.userId === redeemed.userId &&
        membership.email === FINANCE_SYNTHETIC_MEMBER_EMAIL &&
        membership.role === 'member' &&
        membership.status === 'active',
    )
  ) {
    throw new Error('Finance synthetic member membership is unavailable');
  }

  input.financeStageReporter?.('member-authentication');
  const memberSignIn = await send('/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: config.publicOrigin,
      'idempotency-key': 'finance-staging-secondary-member-sign-in-v1',
    },
    body: JSON.stringify({
      email: FINANCE_SYNTHETIC_MEMBER_EMAIL,
      password: config.ownerPassword,
    }),
  });
  if (!memberSignIn.ok) {
    throw new Error('Finance synthetic member sign-in failed');
  }
  const memberCookies = cookiesFrom(memberSignIn);
  if (
    !memberCookies.some((value) =>
      value.startsWith('__Secure-emdo.session_token='),
    )
  ) {
    throw new Error('Finance synthetic member session was not issued');
  }
  const memberCookie = memberCookies.join('; ');
  const memberSession = z.object({ user: z.object({ id: z.uuid() }) }).parse(
    await requireOkJson(
      await send('/api/auth/get-session', {
        headers: { cookie: memberCookie },
      }),
    ),
  );
  if (
    memberSession.user.id !== redeemed.userId ||
    memberSession.user.id === session.user.id
  ) {
    throw new Error('Finance synthetic member session is invalid');
  }
  const memberCsrfResponse = await send('/api/v1/auth/csrf', {
    headers: { cookie: memberCookie },
  });
  requireResponseRequestId(memberCsrfResponse);
  z.strictObject({
    schemaVersion: z.literal(1),
    token: z.string().min(24),
  }).parse(await requireOkJson(memberCsrfResponse));
  const memberCookieWithCsrf = [
    ...memberCookies,
    ...cookiesFrom(memberCsrfResponse),
  ].join('; ');

  input.financeStageReporter?.('document-upload');
  const form = new FormData();
  const fixtureBytes = new Uint8Array(SYNTHETIC_FINANCE_PDF.byteLength);
  fixtureBytes.set(SYNTHETIC_FINANCE_PDF);
  form.append(
    'file',
    new Blob([fixtureBytes.buffer], { type: 'application/pdf' }),
    FINANCE_DOCUMENT_FILENAME,
  );
  let uploadResponse: Response;
  try {
    uploadResponse = await send('/api/v1/finance/documents', {
      method: 'POST',
      headers: {
        ...mutationHeaders,
        'idempotency-key': 'finance-staging-upload-v1',
      },
      body: form,
    });
  } catch (error) {
    input.financeStageReporter?.('document-upload:request-or-network-failed');
    throw error;
  }
  if (uploadResponse.status !== 201) {
    input.financeStageReporter?.(
      await classifyFinanceDocumentUploadProblem(uploadResponse),
    );
    throw new Error('Finance synthetic document was not accepted');
  }
  let uploaded: z.output<typeof FinanceDocumentSummarySchema>;
  let documentId: string;
  try {
    requireResponseRequestId(uploadResponse);
    uploaded = FinanceDocumentSummarySchema.parse(
      await requireOkJson(uploadResponse),
    );
    documentId = z.uuid().parse(uploaded.id);
  } catch (error) {
    input.financeStageReporter?.('document-upload:201-json-or-schema-invalid');
    throw error;
  }
  if (
    uploaded.displayName !== FINANCE_DOCUMENT_FILENAME ||
    uploaded.mimeType !== 'application/pdf' ||
    uploaded.byteSize !== SYNTHETIC_FINANCE_PDF.byteLength ||
    uploaded.plaintextSha256 !== SYNTHETIC_FINANCE_PDF_SHA256
  ) {
    input.financeStageReporter?.(
      'document-upload:synthetic-metadata-or-hash-mismatch',
    );
    throw new Error('Finance synthetic document upload readback is invalid');
  }

  input.financeStageReporter?.('document-extraction-terminal');
  await waitForFinanceReview({
    documentId,
    send,
    cookie: ownerCookie,
    sleep: input.sleep ?? defaultSleep,
    maxPolls,
  });

  input.financeStageReporter?.('document-original-readback');
  const original = await send(
    `/api/v1/finance/documents/${encodeURIComponent(documentId)}/original`,
    { headers: { cookie: ownerCookie } },
  );
  requireResponseRequestId(original);
  if (
    !original.ok ||
    original.headers.get('content-type') !== 'application/pdf' ||
    original.headers.get('cache-control')?.includes('no-store') !== true
  ) {
    throw new Error('Finance encrypted original readback is invalid');
  }
  const originalBytes = new Uint8Array(await original.arrayBuffer());
  if (
    originalBytes.byteLength !== SYNTHETIC_FINANCE_PDF.byteLength ||
    createHash('sha256').update(originalBytes).digest('hex') !==
      SYNTHETIC_FINANCE_PDF_SHA256
  ) {
    throw new Error('Finance encrypted original hash readback failed');
  }

  input.financeStageReporter?.('document-review-read-edit');
  const reviewResponse = await send(
    `/api/v1/finance/documents/${encodeURIComponent(documentId)}/review`,
    { headers: { cookie: ownerCookie } },
  );
  requireResponseRequestId(reviewResponse);
  const review = FinanceDocumentReviewDraftSchema.parse(
    await requireOkJson(reviewResponse),
  );
  if (review.documentId !== documentId) {
    throw new Error('Finance review document binding is invalid');
  }
  const editedEnvelope = {
    ...review.envelope,
    issuer: FINANCE_REVIEW_ISSUER,
    facts: [
      {
        field: FINANCE_REVIEW_EVIDENCE_FIELD,
        confidence: 1,
        evidence: [
          {
            page: 1,
            excerpt: FINANCE_REVIEW_EVIDENCE_EXCERPT,
            characterStart: null,
            characterEnd: null,
          },
        ],
      },
      ...review.envelope.facts.slice(0, 511),
    ],
  };
  const reviewUpdateResponse = await send(
    `/api/v1/finance/documents/${encodeURIComponent(documentId)}/review`,
    {
      method: 'PATCH',
      headers: {
        ...mutationHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'finance-staging-review-edit-v1',
      },
      body: JSON.stringify({
        schemaVersion: 1,
        expectedExtractionRevision: review.extractionRevision,
        envelope: editedEnvelope,
      }),
    },
  );
  requireResponseRequestId(reviewUpdateResponse);
  const updatedReview = FinanceDocumentReviewDraftSchema.parse(
    await requireOkJson(reviewUpdateResponse),
  );
  if (
    updatedReview.documentId !== documentId ||
    updatedReview.envelope.issuer !== FINANCE_REVIEW_ISSUER ||
    !updatedReview.envelope.facts.some(
      (fact) =>
        fact.field === FINANCE_REVIEW_EVIDENCE_FIELD &&
        fact.evidence.some(
          (evidence) =>
            evidence.page === 1 &&
            evidence.excerpt === FINANCE_REVIEW_EVIDENCE_EXCERPT,
        ),
    ) ||
    updatedReview.payloadHash === review.payloadHash
  ) {
    throw new Error('Finance review edit did not bind a new draft');
  }
  input.financeStageReporter?.('document-direct-commit-denial');
  const directCommitDenied = await send(
    `/api/v1/finance/documents/${encodeURIComponent(documentId)}/review/commit`,
    {
      method: 'POST',
      headers: {
        ...mutationHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'finance-staging-review-commit-v1',
      },
      body: JSON.stringify({
        schemaVersion: 1,
        reviewToken: updatedReview.reviewToken,
      }),
    },
  );
  requireResponseRequestId(directCommitDenied);
  if (
    directCommitDenied.status !== 409 ||
    (await parseProblem(directCommitDenied)).code !== 'approval-required'
  ) {
    throw new Error('Finance direct review commit defense gate failed');
  }

  input.financeStageReporter?.('guarded-review-commit');
  input.financeStageReporter?.('guarded-review-commit:initial-turn');
  const guardedCommitTurnInput = {
    send,
    mutationHeaders,
    idempotencyKey: 'finance-staging-guarded-review-commit-v1',
    message: formatFinanceSyntheticStagingCommand({
      schemaVersion: 1,
      action: 'commit-document-review' as const,
      documentId,
    }),
  };
  let guardedCommitTurnResponse: Response;
  try {
    guardedCommitTurnResponse = await submitFinanceTurn(guardedCommitTurnInput);
  } catch (error) {
    input.financeStageReporter?.('turn-post-or-response-invalid');
    throw error;
  }
  let guardedCommitTurn: z.output<typeof TurnAcceptanceSchema>;
  try {
    guardedCommitTurn = TurnAcceptanceSchema.parse(
      await requireOkJson(guardedCommitTurnResponse),
    );
  } catch (error) {
    input.financeStageReporter?.('turn-acceptance-json-or-schema-invalid');
    throw error;
  }
  const guardedCommitInitialEventsInput = {
    send,
    cookie: ownerCookie,
    turn: guardedCommitTurn,
    afterSequence: 0,
    expectedTerminalType: 'approval.required' as const,
    initialSseDiagnostic: true,
  };
  let guardedCommitInitialEventsResponse: Response;
  try {
    guardedCommitInitialEventsResponse = await requestFinanceTurnEvents(
      guardedCommitInitialEventsInput,
    );
  } catch (error) {
    input.financeStageReporter?.('initial-sse-request-failed');
    throw error;
  }
  let guardedCommitInitialEvents: readonly ParsedRunEvent[];
  try {
    guardedCommitInitialEvents = await parseFinanceTurnEvents({
      ...guardedCommitInitialEventsInput,
      response: guardedCommitInitialEventsResponse,
    });
  } catch (error) {
    const diagnostic = initialSseDiagnosticFromError(error);
    if (diagnostic !== undefined) input.financeStageReporter?.(diagnostic);
    throw error;
  }
  input.financeStageReporter?.('guarded-review-commit:approval-parsing');
  let guardedCommitApproval: ReturnType<typeof financeApprovalFromTerminal>;
  try {
    guardedCommitApproval = financeApprovalFromTerminal({
      event: guardedCommitInitialEvents.at(-1),
      runId: guardedCommitTurn.runId,
      documentId,
    });
  } catch (error) {
    input.financeStageReporter?.('approval-terminal-invalid');
    throw error;
  }
  if (guardedCommitApproval.interruptionId.length === 0) {
    throw new Error('Finance guarded approval interruption is invalid');
  }
  const guardedCommitResumedEvents = await approveAndResumeFinanceTurn({
    send,
    cookie: ownerCookie,
    mutationHeaders,
    turn: guardedCommitTurn,
    initialEvents: guardedCommitInitialEvents,
    proposalId: guardedCommitApproval.proposalId,
    decisionIdempotencyKey: 'finance-staging-guarded-review-commit-decision-v1',
    allowRunFailedTerminal: true,
    ...(input.financeStageReporter === undefined
      ? {}
      : { guardedReviewStageReporter: input.financeStageReporter }),
  });
  financeCompletedFromTerminal({
    event: guardedCommitResumedEvents.at(-1),
    runId: guardedCommitTurn.runId,
  });
  input.financeStageReporter?.('guarded-review-commit:resumed-run-completed');
  input.financeStageReporter?.('guarded-review-commit:commit-readback');
  const committed = await financeDocumentDetailFor({
    documentId,
    send,
    cookie: ownerCookie,
  });
  if (
    committed.document.id !== documentId ||
    committed.document.state !== 'committed' ||
    committed.document.plaintextSha256 !== SYNTHETIC_FINANCE_PDF_SHA256
  ) {
    throw new Error('Finance guarded review commit readback is invalid');
  }

  input.financeStageReporter?.('guarded-review-commit:quota-readback');
  const experienceResponse = await send('/api/v1/experience/finance', {
    headers: { cookie: ownerCookie },
  });
  requireResponseRequestId(experienceResponse);
  const experience = FinanceExperienceV1Schema.parse(
    await requireOkJson(experienceResponse),
  );
  if (
    experience.quota.documentsUsed < 1 ||
    experience.quota.bytesUsed < SYNTHETIC_FINANCE_PDF.byteLength
  ) {
    throw new Error('Finance committed experience readback is invalid');
  }

  input.financeStageReporter?.('guarded-delete-denial');
  const deleteDenied = await send(
    `/api/v1/finance/documents/${encodeURIComponent(documentId)}`,
    {
      method: 'DELETE',
      headers: {
        ...mutationHeaders,
        'idempotency-key': 'finance-staging-delete-without-approval-v1',
      },
    },
  );
  requireResponseRequestId(deleteDenied);
  if (
    deleteDenied.status !== 409 ||
    (await parseProblem(deleteDenied)).code !== 'approval-required'
  ) {
    throw new Error('Finance delete approval defense gate failed');
  }

  const anonymousOriginal = await send(
    `/api/v1/finance/documents/${encodeURIComponent(documentId)}/original`,
  );
  if (anonymousOriginal.status !== 401) {
    throw new Error('Finance unauthenticated original defense gate failed');
  }
  await parseProblem(anonymousOriginal);

  input.financeStageReporter?.('qna-and-isolation');
  const financeQuestionTurn = await acceptFinanceTurn({
    send,
    mutationHeaders,
    idempotencyKey: 'finance-staging-qna-v1',
    message: formatFinanceSyntheticStagingCommand({
      schemaVersion: 1,
      action: 'search-document',
      query: FINANCE_REVIEW_ISSUER,
    }),
  });
  const financeQuestionEvents = await readFinanceTurnEvents({
    send,
    cookie: ownerCookie,
    turn: financeQuestionTurn,
    afterSequence: 0,
    expectedTerminalType: 'run.completed',
  });
  const financeQuestionOutput = financeOutputFromCompletedTerminal({
    event: financeQuestionEvents.at(-1),
    runId: financeQuestionTurn.runId,
  });
  const evidenceReferences = [
    ...new Set(financeQuestionOutput.evidenceReferences),
  ];
  if (
    evidenceReferences.length === 0 ||
    evidenceReferences.length !==
      financeQuestionOutput.evidenceReferences.length
  ) {
    throw new Error('Finance EMDO Q&A did not return an unambiguous citation');
  }
  const evidenceId = z.uuid().safeParse(evidenceReferences[0]);
  if (!evidenceId.success) {
    throw new Error('Finance EMDO Q&A evidence reference is invalid');
  }
  const ownerEvidenceResponse = await send(
    `/api/v1/finance/evidence/${encodeURIComponent(evidenceId.data)}`,
    { headers: { cookie: ownerCookie } },
  );
  requireResponseRequestId(ownerEvidenceResponse);
  const ownerEvidence = FinanceDocumentEvidenceListSchema.parse(
    await requireOkJson(ownerEvidenceResponse),
  );
  if (
    ownerEvidence.items.length !== 1 ||
    ownerEvidence.items[0]?.id !== evidenceId.data ||
    ownerEvidence.items[0]?.documentId !== documentId ||
    ownerEvidence.items[0]?.extractionRevision !==
      updatedReview.extractionRevision ||
    ownerEvidence.items[0]?.page !== 1 ||
    ownerEvidence.items[0]?.excerpt !== FINANCE_REVIEW_EVIDENCE_EXCERPT
  ) {
    throw new Error('Finance cited evidence readback is invalid');
  }

  const memberListResponse = await send('/api/v1/finance/documents?limit=50', {
    headers: { cookie: memberCookieWithCsrf },
  });
  requireResponseRequestId(memberListResponse);
  if (memberListResponse.ok) {
    const memberDocuments = FinanceDocumentListSchema.parse(
      await requireOkJson(memberListResponse),
    );
    if (memberDocuments.items.some((document) => document.id === documentId)) {
      throw new Error('Finance cross-user document list leaked owner metadata');
    }
  } else {
    await requireCrossUserFinanceDenial(memberListResponse);
  }
  for (const path of [
    `/api/v1/finance/documents/${encodeURIComponent(documentId)}`,
    `/api/v1/finance/documents/${encodeURIComponent(documentId)}/original`,
    `/api/v1/finance/documents/${encodeURIComponent(documentId)}/review`,
    `/api/v1/finance/documents/${encodeURIComponent(documentId)}/matches`,
    `/api/v1/finance/evidence/${encodeURIComponent(evidenceId.data)}`,
  ]) {
    await requireCrossUserFinanceDenial(
      await send(path, { headers: { cookie: memberCookieWithCsrf } }),
    );
  }

  input.financeStageReporter?.('safe-write-and-handoff');
  const directSafeWriteTurn = await acceptFinanceTurn({
    send,
    mutationHeaders,
    idempotencyKey: 'finance-staging-direct-safe-write-v1',
    message: formatFinanceSyntheticStagingCommand({
      schemaVersion: 1,
      action: 'create-manual-transaction',
      recordId: FINANCE_STAGING_MANUAL_TRANSACTION_ID,
      record: {
        recordType: 'transaction',
        accountId: FINANCE_STAGING_MANUAL_TRANSACTION_ACCOUNT_ID,
        categoryId: null,
        postedOn: FINANCE_STAGING_MANUAL_TRANSACTION_DATE,
        description: FINANCE_STAGING_MANUAL_TRANSACTION_DESCRIPTION,
        amountCadMinor: FINANCE_STAGING_MANUAL_TRANSACTION_AMOUNT_CAD_MINOR,
      },
    }),
  });
  const directSafeWriteEvents = await readFinanceTurnEvents({
    send,
    cookie: ownerCookie,
    turn: directSafeWriteTurn,
    afterSequence: 0,
    expectedTerminalType: 'run.completed',
  });
  const directSafeWriteOutput = financeOutputFromCompletedTerminal({
    event: directSafeWriteEvents.at(-1),
    runId: directSafeWriteTurn.runId,
  });
  if (
    directSafeWriteOutput.summary !== 'The manual transaction was recorded.' ||
    directSafeWriteOutput.evidenceReferences.length !== 0 ||
    directSafeWriteOutput.actionProposalReferences.length !== 0
  ) {
    throw new Error('Finance direct safe write result is invalid');
  }
  const financeReadResponse = await send(
    '/api/v1/experience/finance?limit=50',
    { headers: { cookie: ownerCookie } },
  );
  requireResponseRequestId(financeReadResponse);
  const financeRead = FinancePageSchema.parse(
    await requireOkJson(financeReadResponse),
  );
  const manualTransaction = financeRead.items.find(
    (item) =>
      item.recordType === 'transaction' &&
      item.id === FINANCE_STAGING_MANUAL_TRANSACTION_ID,
  );
  if (
    manualTransaction === undefined ||
    manualTransaction.recordType !== 'transaction' ||
    manualTransaction.description !==
      FINANCE_STAGING_MANUAL_TRANSACTION_DESCRIPTION ||
    manualTransaction.postedOn !== FINANCE_STAGING_MANUAL_TRANSACTION_DATE ||
    manualTransaction.currency !== 'CAD' ||
    manualTransaction.amountCadMinor !==
      FINANCE_STAGING_MANUAL_TRANSACTION_AMOUNT_CAD_MINOR ||
    manualTransaction.state !== 'active'
  ) {
    throw new Error('Finance direct safe write experience readback is invalid');
  }

  await (
    input.financeRestoreVerifierHandoffWriter ??
    writeFinanceRestoreVerifierHandoff
  )({
    documentId,
    evidenceId: evidenceId.data,
    expectedPlaintextSha256: SYNTHETIC_FINANCE_PDF_SHA256,
    memberCookie: memberCookieWithCsrf,
    ownerCookie,
    sourceSha: config.sourceSha,
    workflowRunId: config.workflowRunId,
  });

  return Object.freeze({
    schemaVersion: 1 as const,
    evidenceClass: 'finance-synthetic-staging-probe' as const,
    releaseEligible: false as const,
    outcome: 'blocked' as const,
    environment: 'staging' as const,
    sourceSha: config.sourceSha,
    observedAt: (input.now?.() ?? new Date()).toISOString(),
    execution: Object.freeze({
      workflow: '.github/workflows/staging.yml' as const,
      runId: config.workflowRunId,
      event: 'workflow_dispatch' as const,
    }),
    proof: Object.freeze({
      healthz: 'passed' as const,
      financeDocumentSurface: 'passed' as const,
      authenticatedSyntheticOwner: 'passed' as const,
      extractionToReview: 'passed' as const,
      encryptedOriginalHashReadback: 'passed' as const,
      reviewEdit: 'passed' as const,
      guardedReviewCommit: 'passed' as const,
      directSafeWrite: 'passed' as const,
      guardedDeleteDenial: 'passed' as const,
      unauthenticatedOriginalDenial: 'passed' as const,
      authenticatedSyntheticMember: 'passed' as const,
      crossUserScopeDenial: 'passed' as const,
      financeQnaThroughEmdo: 'passed' as const,
      citedEvidenceReadback: 'passed' as const,
      approvedDeletePurge: 'blocked' as const,
      backupRestore: 'blocked' as const,
    }),
    blockers: Object.freeze([
      'approved-document-purge-awaiting-backup',
      'backup-restore-awaiting-root-drill',
    ] as const),
  });
};

const requireOwnerFinanceContentRevocation = async (
  response: Response,
): Promise<void> => {
  requireResponseRequestId(response);
  if (response.status !== 404 && response.status !== 409) {
    throw new Error('Finance owner content revocation gate failed');
  }
  await parseProblem(response);
};

const runFinanceStagingFinalize = async (
  input: StagingAcceptanceCommandInput,
): Promise<FinanceStagingFinalizeResult> => {
  input.financeStageReporter?.('finalize-configuration');
  const configuration = FinanceAcceptanceConfigurationSchema.safeParse({
    apiOrigin: input.environment.EMDO_STAGING_API_ORIGIN,
    environment: input.environment.EMDO_ENVIRONMENT,
    financeSyntheticStaging: input.environment.EMDO_FINANCE_SYNTHETIC_STAGING,
    ownerEmail: input.environment.EMDO_SYNTHETIC_OWNER_EMAIL,
    ownerPassword: input.environment.EMDO_SYNTHETIC_OWNER_PASSWORD,
    publicOrigin: input.environment.EMDO_PUBLIC_ORIGIN,
    sourceSha: input.environment.EMDO_STAGING_SOURCE_SHA,
    syntheticDataOnly: input.environment.EMDO_SYNTHETIC_DATA_ONLY,
    workerProvidersEnabled: input.environment.EMDO_EXTERNAL_PROVIDERS_ENABLED,
    workflowRunId: input.environment.EMDO_STAGING_WORKFLOW_RUN_ID,
  });
  if (
    !exactArguments(input.argv, FINANCE_FINALIZE_ACCEPTANCE_ARGS) ||
    !configuration.success
  ) {
    throw new Error('Finance staging finalization configuration is invalid');
  }
  const config = configuration.data;
  input.financeStageReporter?.('finalize-attestation');
  const rawAttestation = await (
    input.financePhase2RootAttestationReader ??
    consumeFinanceStagingPhase2RootAttestation
  )();
  const parsedAttestation = FinanceStagingPhase2RootAttestationSchema.safeParse(
    {
      schema: FINANCE_FINALIZE_INPUT_SCHEMA,
      ...rawAttestation,
    },
  );
  if (!parsedAttestation.success) {
    throw new Error('Finance staging finalization handoff is invalid');
  }
  const attestation = Object.freeze({
    sourceSha: parsedAttestation.data.sourceSha,
    workflowRunId: parsedAttestation.data.workflowRunId,
    documentId: parsedAttestation.data.documentId,
    evidenceId: parsedAttestation.data.evidenceId,
    backupRestoreReceiptSha256:
      parsedAttestation.data.backupRestoreReceiptSha256,
  });
  if (
    attestation.sourceSha !== config.sourceSha ||
    attestation.workflowRunId !== config.workflowRunId
  ) {
    throw new Error(
      'Finance staging finalization handoff does not bind this run',
    );
  }
  input.financeStageReporter?.('finalize-health-and-contract');
  const fetchRequest =
    input.fetch ?? ((request: Request) => globalThis.fetch(request));
  const send: SameOriginSend = async (path, init = {}) => {
    const url = new URL(path, `${config.apiOrigin}/`);
    if (url.origin !== config.apiOrigin) {
      throw new Error('External network access is forbidden during acceptance');
    }
    return fetchRequest(
      new Request(url, {
        ...init,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(15_000),
      }),
    );
  };

  const healthResponse = await send('/healthz');
  requireResponseRequestId(healthResponse);
  const health = z
    .strictObject({ status: z.literal('ok') })
    .parse(await requireOkJson(healthResponse));
  if (health.status !== 'ok') throw new Error('Finance liveness gate failed');
  const openapi = z
    .object({
      openapi: z.literal('3.1.0'),
      paths: z.record(z.string(), z.unknown()),
    })
    .parse(await requireOkJson(await send('/openapi.json')));
  assertRequiredOpenApiOperations(
    openapi.paths,
    requiredFinanceOpenApiOperations,
  );

  input.financeStageReporter?.('finalize-owner-authentication');
  const ownerSignIn = await send('/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: config.publicOrigin,
      'idempotency-key': 'finance-staging-finalize-owner-sign-in-v1',
    },
    body: JSON.stringify({
      email: config.ownerEmail,
      password: config.ownerPassword,
    }),
  });
  if (!ownerSignIn.ok) {
    throw new Error('Finance finalization owner sign-in failed');
  }
  const ownerCookies = [...cookiesFrom(ownerSignIn)];
  if (
    !ownerCookies.some((cookie) =>
      cookie.startsWith('__Secure-emdo.session_token='),
    )
  ) {
    throw new Error('Finance finalization owner session was not issued');
  }
  const ownerSessionCookie = ownerCookies.join('; ');
  const ownerSession = z.object({ user: z.object({ id: z.uuid() }) }).parse(
    await requireOkJson(
      await send('/api/auth/get-session', {
        headers: { cookie: ownerSessionCookie },
      }),
    ),
  );
  const ownerCsrfResponse = await send('/api/v1/auth/csrf', {
    headers: { cookie: ownerSessionCookie },
  });
  requireResponseRequestId(ownerCsrfResponse);
  const ownerCsrf = z
    .strictObject({ schemaVersion: z.literal(1), token: z.string().min(24) })
    .parse(await requireOkJson(ownerCsrfResponse));
  ownerCookies.push(...cookiesFrom(ownerCsrfResponse));
  const ownerCookie = ownerCookies.join('; ');
  const ownerMutationHeaders = {
    cookie: ownerCookie,
    origin: config.publicOrigin,
    'x-csrf-token': ownerCsrf.token,
  };

  input.financeStageReporter?.('finalize-member-authentication');
  const memberSignIn = await send('/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: config.publicOrigin,
      'idempotency-key': 'finance-staging-finalize-member-sign-in-v1',
    },
    body: JSON.stringify({
      email: FINANCE_SYNTHETIC_MEMBER_EMAIL,
      password: config.ownerPassword,
    }),
  });
  if (!memberSignIn.ok) {
    throw new Error('Finance finalization member sign-in failed');
  }
  const memberCookies = [...cookiesFrom(memberSignIn)];
  if (
    !memberCookies.some((cookie) =>
      cookie.startsWith('__Secure-emdo.session_token='),
    )
  ) {
    throw new Error('Finance finalization member session was not issued');
  }
  const memberSessionCookie = memberCookies.join('; ');
  const memberSession = z.object({ user: z.object({ id: z.uuid() }) }).parse(
    await requireOkJson(
      await send('/api/auth/get-session', {
        headers: { cookie: memberSessionCookie },
      }),
    ),
  );
  if (memberSession.user.id === ownerSession.user.id) {
    throw new Error('Finance finalization sessions are not distinct');
  }
  const memberCsrfResponse = await send('/api/v1/auth/csrf', {
    headers: { cookie: memberSessionCookie },
  });
  requireResponseRequestId(memberCsrfResponse);
  z.strictObject({
    schemaVersion: z.literal(1),
    token: z.string().min(24),
  }).parse(await requireOkJson(memberCsrfResponse));
  memberCookies.push(...cookiesFrom(memberCsrfResponse));
  const memberCookie = memberCookies.join('; ');

  input.financeStageReporter?.('finalize-document-and-evidence');
  const committed = await financeDocumentDetailFor({
    documentId: attestation.documentId,
    send,
    cookie: ownerCookie,
  });
  if (
    committed.document.id !== attestation.documentId ||
    committed.document.state !== 'committed' ||
    committed.document.plaintextSha256 !== SYNTHETIC_FINANCE_PDF_SHA256
  ) {
    throw new Error('Finance finalization document binding is invalid');
  }
  const evidenceResponse = await send(
    `/api/v1/finance/evidence/${encodeURIComponent(attestation.evidenceId)}`,
    { headers: { cookie: ownerCookie } },
  );
  requireResponseRequestId(evidenceResponse);
  const evidence = FinanceDocumentEvidenceListSchema.parse(
    await requireOkJson(evidenceResponse),
  );
  if (
    evidence.items.length !== 1 ||
    evidence.items[0]?.id !== attestation.evidenceId ||
    evidence.items[0]?.documentId !== attestation.documentId ||
    evidence.items[0]?.extractionRevision !==
      committed.document.extractionRevision ||
    evidence.items[0]?.page !== 1 ||
    evidence.items[0]?.excerpt !== FINANCE_REVIEW_EVIDENCE_EXCERPT
  ) {
    throw new Error('Finance finalization evidence binding is invalid');
  }

  input.financeStageReporter?.('finalize-guarded-delete');
  const guardedDeleteTurn = await acceptFinanceTurn({
    send,
    mutationHeaders: ownerMutationHeaders,
    idempotencyKey: 'finance-staging-guarded-delete-v1',
    message: formatFinanceSyntheticStagingCommand({
      schemaVersion: 1,
      action: 'delete-document',
      documentId: attestation.documentId,
    }),
  });
  const guardedDeleteInitialEvents = await readFinanceTurnEvents({
    send,
    cookie: ownerCookie,
    turn: guardedDeleteTurn,
    afterSequence: 0,
    expectedTerminalType: 'approval.required',
  });
  const guardedDeleteApproval = financeApprovalFromTerminal({
    event: guardedDeleteInitialEvents.at(-1),
    runId: guardedDeleteTurn.runId,
    documentId: attestation.documentId,
  });
  if (guardedDeleteApproval.interruptionId.length === 0) {
    throw new Error('Finance guarded delete interruption is invalid');
  }
  const guardedDeleteResumedEvents = await approveAndResumeFinanceTurn({
    send,
    cookie: ownerCookie,
    mutationHeaders: ownerMutationHeaders,
    turn: guardedDeleteTurn,
    initialEvents: guardedDeleteInitialEvents,
    proposalId: guardedDeleteApproval.proposalId,
    decisionIdempotencyKey: 'finance-staging-guarded-delete-decision-v1',
  });
  financeCompletedFromTerminal({
    event: guardedDeleteResumedEvents.at(-1),
    runId: guardedDeleteTurn.runId,
  });

  input.financeStageReporter?.('finalize-purge-and-revocation');
  const tombstone = await financeDocumentDetailFor({
    documentId: attestation.documentId,
    send,
    cookie: ownerCookie,
  });
  if (
    tombstone.document.id !== attestation.documentId ||
    tombstone.document.state !== 'deleted' ||
    tombstone.reviewAvailable ||
    tombstone.matchCount !== 0
  ) {
    throw new Error('Finance deletion tombstone is invalid');
  }
  const ownerListResponse = await send('/api/v1/finance/documents?limit=50', {
    headers: { cookie: ownerCookie },
  });
  requireResponseRequestId(ownerListResponse);
  const ownerDocuments = FinanceDocumentListSchema.parse(
    await requireOkJson(ownerListResponse),
  );
  if (
    ownerDocuments.items.some(
      (document) => document.id === attestation.documentId,
    )
  ) {
    throw new Error('Finance deleted document remains listed for its owner');
  }
  const ownerExperienceResponse = await send('/api/v1/experience/finance', {
    headers: { cookie: ownerCookie },
  });
  requireResponseRequestId(ownerExperienceResponse);
  const ownerExperience = FinanceExperienceV1Schema.parse(
    await requireOkJson(ownerExperienceResponse),
  );
  if (
    ownerExperience.quota.documentsUsed !== 0 ||
    ownerExperience.quota.bytesUsed !== 0
  ) {
    throw new Error('Finance deletion purge quota readback is invalid');
  }

  for (const path of [
    `/api/v1/finance/documents/${encodeURIComponent(attestation.documentId)}/original`,
    `/api/v1/finance/documents/${encodeURIComponent(attestation.documentId)}/review`,
    `/api/v1/finance/documents/${encodeURIComponent(attestation.documentId)}/matches`,
    `/api/v1/finance/evidence/${encodeURIComponent(attestation.evidenceId)}`,
  ]) {
    await requireOwnerFinanceContentRevocation(
      await send(path, { headers: { cookie: ownerCookie } }),
    );
  }
  const memberListResponse = await send('/api/v1/finance/documents?limit=50', {
    headers: { cookie: memberCookie },
  });
  requireResponseRequestId(memberListResponse);
  if (memberListResponse.ok) {
    const memberDocuments = FinanceDocumentListSchema.parse(
      await requireOkJson(memberListResponse),
    );
    if (
      memberDocuments.items.some(
        (document) => document.id === attestation.documentId,
      )
    ) {
      throw new Error('Finance deleted document leaked to the member list');
    }
  } else {
    await requireCrossUserFinanceDenial(memberListResponse);
  }
  for (const path of [
    `/api/v1/finance/documents/${encodeURIComponent(attestation.documentId)}`,
    `/api/v1/finance/documents/${encodeURIComponent(attestation.documentId)}/original`,
    `/api/v1/finance/documents/${encodeURIComponent(attestation.documentId)}/review`,
    `/api/v1/finance/documents/${encodeURIComponent(attestation.documentId)}/matches`,
    `/api/v1/finance/evidence/${encodeURIComponent(attestation.evidenceId)}`,
  ]) {
    await requireCrossUserFinanceDenial(
      await send(path, { headers: { cookie: memberCookie } }),
    );
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    evidenceClass: 'finance-synthetic-staging-probe' as const,
    releaseEligible: false as const,
    outcome: 'passed' as const,
    environment: 'staging' as const,
    sourceSha: config.sourceSha,
    observedAt: (input.now?.() ?? new Date()).toISOString(),
    execution: Object.freeze({
      workflow: '.github/workflows/staging.yml' as const,
      runId: config.workflowRunId,
      event: 'workflow_dispatch' as const,
    }),
    proof: Object.freeze({
      healthz: 'passed' as const,
      financeDocumentSurface: 'passed' as const,
      authenticatedSyntheticOwner: 'passed' as const,
      extractionToReview: 'passed' as const,
      encryptedOriginalHashReadback: 'passed' as const,
      reviewEdit: 'passed' as const,
      guardedReviewCommit: 'passed' as const,
      directSafeWrite: 'passed' as const,
      guardedDeleteDenial: 'passed' as const,
      unauthenticatedOriginalDenial: 'passed' as const,
      authenticatedSyntheticMember: 'passed' as const,
      crossUserScopeDenial: 'passed' as const,
      financeQnaThroughEmdo: 'passed' as const,
      citedEvidenceReadback: 'passed' as const,
      approvedDeletePurge: 'passed' as const,
      guardedDeleteThroughEmdo: 'passed' as const,
      deletedTombstonePurge: 'passed' as const,
      ownerContentRevocation: 'passed' as const,
      memberContentRevocation: 'passed' as const,
      backupRestore: 'passed' as const,
    }),
    blockers: Object.freeze([] as const),
  });
};

export const runStagingAcceptanceCommand = async (
  input: StagingAcceptanceCommandInput,
): Promise<
  | Awaited<ReturnType<typeof runProviderFreeStagingAcceptance>>
  | FinanceStagingAcceptanceResult
  | FinanceStagingFinalizeResult
> =>
  exactArguments(input.argv, FINANCE_FINALIZE_ACCEPTANCE_ARGS)
    ? runFinanceStagingFinalize(input)
    : exactArguments(input.argv, FINANCE_ACCEPTANCE_ARGS)
      ? runFinanceStagingAcceptance(input)
      : runProviderFreeStagingAcceptance(input);

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  let financeProgress: FinanceStagingAcceptanceProgress | undefined;
  void runStagingAcceptanceCommand({
    argv: process.argv.slice(2),
    environment: process.env,
    financeStageReporter: (progress) => {
      financeProgress = progress;
    },
  })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write(formatStagingAcceptanceFailure(financeProgress));
      process.exitCode = 1;
    });
}
