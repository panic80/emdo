export interface AcceptanceEvidenceContext {
  readonly sourceSha: string;
  readonly images: Readonly<Record<string, string>>;
  readonly environment: string;
  readonly producerRunId: string;
  readonly producerHeadSha: string;
  readonly producerConclusion: string;
  readonly ciRunId: string;
  readonly ciHeadSha: string;
  readonly ciConclusion: string;
  readonly now: number;
}

export const ACCEPTANCE_EVIDENCE_SCHEMA_VERSION: 1;
export const ACCEPTANCE_RECEIPT_SCHEMA_VERSION: 1;
export const ACCEPTANCE_EVIDENCE_FILENAME: string;
export const ACCEPTANCE_PRODUCER_WORKFLOW: string;
export const ACCEPTANCE_CI_WORKFLOW: string;
export const REQUIRED_CI_JOBS: readonly string[];
export const REQUIRED_GATES: readonly Readonly<{
  id: string;
  evidenceClass: string;
}>[];
export const REQUIRED_PROVIDER_SMOKES: readonly string[];

export function canonicalJson(value: unknown): string;
export function parseAcceptanceImageLock(source: string): Readonly<{
  sourceSha: string;
  images: Readonly<Record<string, string>>;
}>;
export function validateAcceptanceReceipt(
  value: unknown,
  expected: Readonly<{
    category: 'ci' | 'gates' | 'providers';
    id: string;
    context: AcceptanceEvidenceContext | undefined;
  }>,
): Readonly<{
  category: string;
  id: string;
  sourceSha: string;
  environment: string;
  observedAt: number;
  observedAtText: string;
  evidenceClass: string | undefined;
}>;
export function parseAcceptanceReceipt(
  source: string,
  expected: Readonly<{
    category: 'ci' | 'gates' | 'providers';
    id: string;
    context: AcceptanceEvidenceContext | undefined;
  }>,
): Readonly<{
  value: unknown;
  verification: ReturnType<typeof validateAcceptanceReceipt>;
}>;
export function validateAcceptanceDescriptor(
  value: unknown,
  expected: Readonly<{
    category: 'ci' | 'gates' | 'providers';
    id: string;
  }>,
): Readonly<{
  id: string;
  artifact: Readonly<{ name: string; sha256: string }>;
}>;
export function validateAcceptanceEvidence(
  value: unknown,
  context: AcceptanceEvidenceContext,
): Readonly<{
  sourceSha: string;
  environment: string;
  issuedAt: number;
  expiresAt: number;
}>;
export function verifyAcceptanceEvidenceBundle(
  input: Readonly<{
    manifestText: string;
    digestText: string;
    signatureText: string;
    publicKeyPem: string | Buffer;
    context: AcceptanceEvidenceContext;
  }>,
): Readonly<{ manifestDigest: string }>;
export function readStrictRegularFile(
  path: string,
  maximumBytes?: number,
): Promise<string>;
export function verifyAcceptanceArtifactReceipts(
  manifest: unknown,
  artifactsRoot: string,
  context: AcceptanceEvidenceContext,
): Promise<Readonly<{ artifactCount: number }>>;
export function deriveAcceptanceManifestEntryFromArtifact(
  input: Readonly<{
    artifactsRoot: string;
    category: 'ci' | 'gates' | 'providers';
    id: string;
    artifact: unknown;
    context: AcceptanceEvidenceContext;
    issuedAt: number;
  }>,
): Promise<
  Readonly<{
    manifestEntry: Readonly<Record<string, unknown>>;
    verification: ReturnType<typeof validateAcceptanceReceipt>;
  }>
>;
