import { deepFreeze } from '@emdo/contracts';
import { PERSONAL_PAPER_FIELD_PROOFS } from './personal-precision-evidence.js';
import type { PersonalFormField } from './personal-package.js';

export const PERSONAL_PAPER_REPORTING_POLICY_VERSION = '2025-paper-precision.8';
export type PersonalFieldReporting = {
  target: 'cra-2025-fillable-paper-field';
  policyVersion: string;
  status:
    | 'lossless-cents'
    | 'blocked-input'
    | 'field-proof-missing'
    | 'dependency-unresolved'
    | 'rounding-unproven'
    | 'dimensionless-not-reportable'
    | 'field-width-exceeded';
  rounding: 'none-lossless' | null;
  blockedDependencies: string[];
  sourceId: string | null;
  fieldPath: string | null;
};
/** These are reviewed formula nodes, not a rule synthesized from matching PDF field names.
 * A cent-only direct transfer/sum/difference/min/max preserves exact cents. T2204.10
 * is one multiplication and cap: if it introduces subcents it stays blocked.
 * Schedule8 parts3/4/5 use reviewed line and conditional dependencies. Exact-looking
 * descendants cannot bypass a subcent intermediate or unresolved branch input.
 */
export function applyCanadaPersonalPaperReporting(
  fields: PersonalFormField[],
  blocked: boolean,
) {
  type Resolution = {
    status: PersonalFieldReporting['status'];
    blockedDependencies: string[];
    exactCents: boolean;
    scaled: bigint;
    proof:
      | (typeof PERSONAL_PAPER_FIELD_PROOFS)[keyof typeof PERSONAL_PAPER_FIELD_PROOFS]
      | undefined;
  };
  const byId = new Map(fields.map((field) => [field.id, field]));
  const resolutions = new Map<string, Resolution>();
  const visiting = new Set<string>();

  // Resolve by field id rather than by array position. The workflow currently
  // emits a topological order, but this boundary is also used by independent
  // schedule tests and must preserve the graph when a caller supplies fields
  // in a different order. A cycle or missing node remains unresolved.
  const resolve = (id: string): Resolution | undefined => {
    const existing = resolutions.get(id);
    if (existing) return existing;
    const field = byId.get(id);
    if (!field) return undefined;
    const proof =
      PERSONAL_PAPER_FIELD_PROOFS[
        field.id as keyof typeof PERSONAL_PAPER_FIELD_PROOFS
      ];
    visiting.add(id);
    const blockedDependencies = field.dependencies.filter((dependencyId) => {
      if (dependencyId.startsWith('fact:')) return false;
      if (visiting.has(dependencyId)) return true;
      const dependency = resolve(dependencyId);
      return !dependency || dependency.status !== 'lossless-cents';
    });
    visiting.delete(id);

    const n = BigInt(field.exactRational.numerator),
      d = BigInt(field.exactRational.denominator);
    const cents = n * 100n;
    const exactCents =
      field.unit !== 'dimensionless' && d > 0n && cents % d === 0n;
    const integerDigits =
      d > 0n
        ? (n < 0n ? -n / d : n / d).toString().length
        : Number.MAX_SAFE_INTEGER;
    const maxIntegerDigits = field.form === 'T2125' ? 10 : 9;
    const status: PersonalFieldReporting['status'] = blocked
      ? 'blocked-input'
      : !proof
        ? 'field-proof-missing'
        : blockedDependencies.length
          ? 'dependency-unresolved'
          : field.unit === 'dimensionless'
            ? 'dimensionless-not-reportable'
            : !exactCents
              ? 'rounding-unproven'
              : integerDigits > maxIntegerDigits
                ? 'field-width-exceeded'
                : 'lossless-cents';
    const resolution: Resolution = {
      status,
      blockedDependencies,
      exactCents,
      scaled: exactCents ? cents / d : 0n,
      proof,
    };
    resolutions.set(id, resolution);
    return resolution;
  };

  return fields.map((field) => {
    const resolution = resolve(field.id)!;
    const scaled = resolution.scaled;
    const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(3, '0');
    return deepFreeze({
      ...field,
      reportableAmount:
        resolution.status === 'lossless-cents'
          ? `${scaled < 0n ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
          : null,
      reporting: {
        target: 'cra-2025-fillable-paper-field',
        policyVersion: PERSONAL_PAPER_REPORTING_POLICY_VERSION,
        status: resolution.status,
        rounding:
          resolution.status === 'lossless-cents' ? 'none-lossless' : null,
        blockedDependencies: resolution.blockedDependencies,
        sourceId: resolution.proof?.sourceId ?? null,
        fieldPath: resolution.proof?.path ?? null,
      } satisfies PersonalFieldReporting,
    });
  });
}
