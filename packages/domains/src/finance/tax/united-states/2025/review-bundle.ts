import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  deepFreeze,
  FinanceTaxIntakeSchema,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import { evaluateUs2025WorkingPapers } from './workflow.js';
import { US_2025_SOURCES } from './sources.js';
import { usdCents } from './rounding.js';
import { US_WAGE_CORRECTION_SOURCE } from './wage-source.js';
export const US_REVIEW_BUNDLE_VERSION = '2025.2-wage-correction-bindings';

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
export const usReviewContentHash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(200);
const boxes = ['box1', 'box2', 'box3', 'box5', 'box6', 'box7'] as const;
const cents = z.string().refine((value) => {
  try {
    usdCents(value);
    return true;
  } catch {
    return false;
  }
});
const Artifact = z.strictObject({
  artifactId: z.uuid(),
  workspaceId: z.uuid(),
  caseId: z.uuid(),
  taxSubjectId: z.uuid(),
  revision: z.number().int().positive(),
  contentHash: hash,
  form: z.enum(['W-2', 'W-2c']),
  taxYear: z.literal(2025),
  originalArtifactId: z.uuid().nullable(),
  supersedesArtifactId: z.uuid().nullable().optional(),
  corrections: z
    .array(
      z.strictObject({ box: z.enum(boxes), previous: cents, correct: cents }),
    )
    .max(6)
    .optional(),
  reviewedBy: text,
  reviewedAt: z.iso.datetime(),
  boxes: z.strictObject({
    box1: cents,
    box2: cents,
    box3: cents,
    box5: cents,
    box6: cents,
    box7: cents,
  }),
});
export type UsReviewedWageArtifact = z.infer<typeof Artifact> & {
  bytes: Uint8Array;
};
const Snapshot = z.strictObject({
  workspaceId: z.uuid(),
  caseId: z.uuid(),
  taxSubjectId: z.uuid(),
  snapshotRevision: z.number().int().positive(),
  snapshotHash: hash,
  intakeHash: hash,
  wageManifestReference: text,
  wageManifestRevision: z.number().int().positive(),
});
/** Trusted persistence boundary, not an authorization API. The caller MUST resolve the
 * current private-case permission, immutable snapshot and reviewed artifact bytes under
 * that scope. Never deserialize this argument directly from a browser/model request.
 * We recompute all results and hashes; no caller-supplied rules, forms or outcomes.
 */
export function prepareUs2025ReviewBundle(
  input: FinanceTaxIntake,
  trusted: z.infer<typeof Snapshot>,
  artifacts: readonly UsReviewedWageArtifact[],
) {
  const intake = FinanceTaxIntakeSchema.parse(input);
  const snapshot = Snapshot.parse(trusted);
  for (const key of ['workspaceId', 'caseId', 'taxSubjectId'] as const)
    if (snapshot[key] !== intake[key])
      throw new Error('review-snapshot-scope-mismatch');
  if (
    snapshot.snapshotRevision !== intake.revision ||
    snapshot.intakeHash !== usReviewContentHash(intake)
  )
    throw new Error('review-snapshot-input-mismatch');
  if (
    artifacts.length > 100 ||
    artifacts.reduce((total, entry) => total + entry.bytes.byteLength, 0) >
      100 * 1024 * 1024
  )
    throw new Error('review-artifact-limit');
  const bound = artifacts
    .map(({ bytes, ...metadata }) => {
      const artifact = Artifact.parse(metadata);
      for (const key of ['workspaceId', 'caseId', 'taxSubjectId'] as const)
        if (artifact[key] !== snapshot[key])
          throw new Error('review-artifact-scope-mismatch');
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > 25 * 1024 * 1024 ||
        createHash('sha256').update(bytes).digest('hex') !==
          artifact.contentHash
      )
        throw new Error('review-artifact-content-mismatch');
      return artifact;
    })
    .sort((a, b) =>
      a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0,
    );
  if (new Set(bound.map((entry) => entry.artifactId)).size !== bound.length)
    throw new Error('review-artifact-duplicate');
  // W-2c only populates changed boxes. Retain every original/correction artifact,
  // reconcile previous values and carry unchanged amounts from its predecessor.
  // One explicit linear chain per original; timestamp or UUID order never picks a winner.
  const byId = new Map(bound.map((entry) => [entry.artifactId, entry]));
  const successor = new Map<string, string>();
  for (const entry of bound) {
    if (entry.form === 'W-2') {
      if (
        entry.originalArtifactId !== null ||
        entry.supersedesArtifactId ||
        entry.corrections?.length
      )
        throw new Error('review-original-correction-metadata');
      continue;
    }
    const predecessor = entry.supersedesArtifactId
      ? byId.get(entry.supersedesArtifactId)
      : undefined;
    const original = entry.originalArtifactId
      ? byId.get(entry.originalArtifactId)
      : undefined;
    if (
      !predecessor ||
      !original ||
      original.form !== 'W-2' ||
      !entry.corrections
    )
      throw new Error('review-correction-chain-missing');
    if (
      predecessor.artifactId !== original.artifactId &&
      predecessor.originalArtifactId !== original.artifactId
    )
      throw new Error('review-correction-root-mismatch');
    if (successor.has(predecessor.artifactId))
      throw new Error('review-correction-branch-ambiguous');
    successor.set(predecessor.artifactId, entry.artifactId);
    const expected = { ...predecessor.boxes };
    const changed = new Set<string>();
    for (const correction of entry.corrections) {
      if (changed.has(correction.box))
        throw new Error('review-correction-box-duplicate');
      changed.add(correction.box);
      if (usdCents(expected[correction.box]) !== usdCents(correction.previous))
        throw new Error('review-correction-previous-mismatch');
      expected[correction.box] = correction.correct;
    }
    if (
      boxes.some(
        (box) => usdCents(expected[box]) !== usdCents(entry.boxes[box]),
      )
    )
      throw new Error('review-correction-effective-mismatch');
  }
  const reached = new Set<string>();
  const effective = bound
    .filter((entry) => entry.form === 'W-2')
    .map((root) => {
      let entry = root;
      while (true) {
        if (reached.has(entry.artifactId))
          throw new Error('review-correction-cycle');
        reached.add(entry.artifactId);
        const next = successor.get(entry.artifactId);
        if (!next) return entry;
        entry = byId.get(next)!;
      }
    });
  if (reached.size !== bound.length)
    throw new Error('review-correction-orphan-cycle');
  const wageManifest = {
    reference: snapshot.wageManifestReference,
    revision: snapshot.wageManifestRevision,
    artifacts: bound,
  };
  const wageManifestHash = usReviewContentHash(wageManifest);
  const result = evaluateUs2025WorkingPapers(intake);
  const blockers: string[] = [];
  if (
    result.status === 'blocked-input' ||
    result.fieldCoverage?.unresolved.length
  )
    blockers.push('federal-required-fields-unresolved');
  const needsWages =
    result.fieldCoverage?.attachments.some(
      (entry) => entry.form === 'W-2' && entry.required,
    ) || bound.length > 0;
  if (needsWages) {
    if (!bound.length) blockers.push('required-w2-artifact-missing');
    for (const box of boxes) {
      const fact = intake.facts.find((entry) => entry.key === `w2.${box}`);
      const total = effective.reduce(
        (sum, entry) => sum + usdCents(entry.boxes[box]),
        0n,
      );
      if (
        !fact ||
        fact.value.type !== 'decimal' ||
        usdCents(fact.value.value) !== total
      )
        blockers.push(`w2-${box}-artifact-total-mismatch`);
      if (
        !fact ||
        fact.source.kind !== 'evidence' ||
        fact.source.reference !== wageManifest.reference ||
        fact.source.revision !== wageManifest.revision ||
        fact.source.contentHash !== wageManifestHash
      )
        blockers.push(`w2-${box}-source-binding-mismatch`);
    }
  }
  const generated = result.evaluation.forms
    .map((form) => ({
      formId: form.id,
      content: form,
      physicalFields:
        result.fieldCoverage?.fields.filter(
          (field) => field.formId === form.id,
        ) ?? [],
    }))
    .map((content) => ({
      ...content,
      contentHash: usReviewContentHash(content),
    }));
  for (const attachment of result.fieldCoverage?.attachments ?? [])
    if (
      attachment.required &&
      attachment.form !== 'W-2' &&
      !generated.some((form) => form.formId === attachment.form)
    )
      blockers.push(`required-generated-form-${attachment.form}-missing`);
  // Source: each pinned2025 form's printed upper-right attachment sequence.
  const sequences: Record<string, { sequence: number; sourceId: string }> = {
    S1: { sequence: 1, sourceId: 'irs-2025-f1040s1' },
    S2: { sequence: 2, sourceId: 'irs-2025-f1040s2' },
    F2210: { sequence: 6, sourceId: 'irs-2025-f2210' },
    C: { sequence: 9, sourceId: 'irs-2025-f1040sc' },
    SE: { sequence: 17, sourceId: 'irs-2025-f1040sse' },
    F6251: { sequence: 32, sourceId: 'irs-2025-f6251' },
    F8995: { sequence: 55, sourceId: 'irs-2025-f8995' },
    F8959: { sequence: 71, sourceId: 'irs-2025-f8959' },
  };
  const assembly = (result.fieldCoverage?.attachments ?? [])
    .filter((entry) => entry.required && entry.form !== 'W-2')
    .map((entry) => {
      const sequence = sequences[entry.form];
      if (!sequence) throw new Error('review-attachment-sequence-unknown');
      return {
        formId: entry.form,
        ...sequence,
        authorityHash: US_2025_SOURCES.find(
          (source) => source.id === sequence.sourceId,
        )!.documentHash,
        generatedContentHash:
          generated.find((form) => form.formId === entry.form)?.contentHash ??
          null,
      };
    })
    .sort((a, b) => a.sequence - b.sequence);
  const content = {
    version: US_REVIEW_BUNDLE_VERSION,
    correctionAuthority: US_WAGE_CORRECTION_SOURCE,
    effectiveWageArtifactIds: effective.map((entry) => entry.artifactId),
    snapshot,
    federalInputHash: result.binding?.inputHash ?? null,
    federalOutputHash: result.outputHash,
    definitionHash: result.definitionHash,
    generated,
    assembly,
    wageManifest,
    wageManifestHash,
    attachments: (result.fieldCoverage?.attachments ?? []).map((entry) =>
      entry.form === 'W-2'
        ? { ...entry, required: Boolean(needsWages) }
        : entry,
    ),
    blockers,
    authority: US_2025_SOURCES.find(
      (source) => source.id === 'irs-2025-i1040gi',
    ),
    authorityLocator:
      'page67, Assemble Your Return: attach all W-2 and original/corrected W-2c; schedules in attachment sequence order',
  };
  return deepFreeze({
    ...content,
    bundleHash: usReviewContentHash(content),
    attachmentBindingsComplete: blockers.length === 0,
    complete: false as const,
    status: blockers.length
      ? ('blocked-review-bundle' as const)
      : ('incomplete-working-papers' as const),
  });
}
