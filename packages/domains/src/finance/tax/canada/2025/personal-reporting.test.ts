import { describe, expect, it } from 'vitest';
import type { PersonalFormField } from './personal-package.js';
import { decimal, rational, serialize } from './personal-exact.js';
import { applyCanadaPersonalPaperReporting } from './personal-reporting.js';

function field(
  id: string,
  amount: string,
  dependencies: string[] = [],
): PersonalFormField {
  const [form, line] = id.split('.');
  return {
    id,
    form: form!,
    line: line!,
    label: 'Independent reporting fixture',
    dependencies,
    sourceId: 'fixture-reviewed-cent-transfer',
    locator: 'independent reporting fixture',
    ...serialize(decimal(amount)),
    reportableAmount: null,
  };
}

describe('Canadian 2025 exact reporting graph', () => {
  it('canonicalizes zero before serializing a trace', () => {
    expect(rational(0n, 100n)).toEqual({ n: 0n, d: 1n });
    expect(serialize(decimal('0.00')).exactRational).toEqual({
      numerator: '0',
      denominator: '1',
    });
    expect(serialize({ n: 0n, d: 100n }).exactRational).toEqual({
      numerator: '0',
      denominator: '1',
    });
  });

  it('resolves a dependent field when its parent appears later in the array', () => {
    const output = applyCanadaPersonalPaperReporting(
      [field('T1.13500', '2.50', ['T1.10100']), field('T1.10100', '1.25')],
      false,
    );
    expect(output[0]!.reporting.status).toBe('lossless-cents');
    expect(output[0]!.reportableAmount).toBe('2.50');
    expect(output[0]!.reporting.blockedDependencies).toEqual([]);
  });

  it('keeps a half-cent parent unresolved through an exact-cent child', () => {
    const output = applyCanadaPersonalPaperReporting(
      [field('T1.13500', '-0.50', ['T1.10100']), field('T1.10100', '1.005')],
      false,
    );
    expect(output[1]!.reporting.status).toBe('rounding-unproven');
    expect(output[0]!.reporting.status).toBe('dependency-unresolved');
    expect(output[0]!.reporting.blockedDependencies).toEqual(['T1.10100']);
    expect(output[0]!.reportableAmount).toBeNull();
  });

  it('preserves an exact negative refund amount at cents', () => {
    const output = applyCanadaPersonalPaperReporting(
      [field('T1.13500', '-12.50')],
      false,
    );
    expect(output[0]!.reporting.status).toBe('lossless-cents');
    expect(output[0]!.reportableAmount).toBe('-12.50');
  });

  it('keeps a dependency cycle unresolved instead of treating a partial walk as proof', () => {
    const output = applyCanadaPersonalPaperReporting(
      [
        field('T1.13500', '2.50', ['T1.10100']),
        field('T1.10100', '1.25', ['T1.13500']),
      ],
      false,
    );
    expect(output.map((f) => f.reporting.status)).toEqual([
      'dependency-unresolved',
      'dependency-unresolved',
    ]);
    expect(output[0]!.reporting.blockedDependencies).toEqual(['T1.10100']);
    expect(output[1]!.reporting.blockedDependencies).toEqual(['T1.13500']);
  });
});
