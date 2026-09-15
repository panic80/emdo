import type { CanadaCorporate2025Intake } from './intake.js';

/** T2 E(25), pages 5–7. Called only after the corporate workflow's coverage validation.
 * Current-year investment income, dividends, foreign credits, Part IV tax and transfers
 * are absent by explicit questionnaire answers. Prior pools/refunds are never inferred zero.
 * Values use the workflow's exact six-decimal integer unit. */
export function corporateRefundableSections(
  input: CanadaCorporate2025Intake,
  taxable: bigint,
  federalTax: bigint,
  parse: (value: string) => bigint,
) {
  const values: Record<string, bigint> = {};
  const dependencies: Record<string, string[]> = {};
  const put = (key: string, value: bigint, deps: string[] = []) => {
    values[key] = value;
    dependencies[`T2.${key}`] = deps.map((d) =>
      d.startsWith('T2.') ? d : `T2.${d}`,
    );
    return value;
  };
  const nonnegative = (v: bigint) => (v < 0n ? 0n : v);
  const min = (...v: bigint[]) => v.reduce((a, b) => (a < b ? a : b));
  const multiply = (v: bigint, n: bigint, d: bigint) => {
    if ((v * n) % d !== 0n)
      throw new Error('corporate-refundable-exact-scale-exceeded');
    return (v * n) / d;
  };
  put('432', 0n);
  put('440', 0n);
  put('445', 0n);
  put('632', 0n);
  put('636', 0n);
  put('780', 0n);
  put('p5.A', taxable, ['360']);
  put('p5.B', 0n);
  put('p5.C', 0n);
  put('p5.D', 0n, ['432']);
  put('p5.E', taxable, ['400', '405', '410', '428']);
  put('p5.F', 0n, ['440']);
  put('p5.G', taxable, ['p5.B', 'p5.C', 'p5.D', 'p5.E', 'p5.F']);
  const reductionBase = put(
    'p5.H',
    nonnegative(values['p5.A']! - values['p5.G']!),
    ['p5.A', 'p5.G'],
  );
  put('p5.I', multiply(reductionBase, 13n, 100n), ['p5.H']);
  put('638', values['p5.I']!, ['p5.I']);
  put('p6.A', multiply(values['440']!, 23n, 75n), ['440']);
  put('p6.B', 0n, ['632']);
  put('p6.C', multiply(values['445']!, 8n, 100n), ['445']);
  put('p6.D', nonnegative(values['p6.B']! - values['p6.C']!), ['p6.B', 'p6.C']);
  put('p6.E', nonnegative(values['p6.A']! - values['p6.D']!), ['p6.A', 'p6.D']);
  put('p6.F', taxable, ['360']);
  put('p6.G', taxable, ['400', '405', '410', '428']);
  put('p6.H', multiply(values['632']!, 75n, 29n), ['632']);
  put('p6.I', values['636']! * 4n, ['636']);
  put('p6.J', values['p6.G']! + values['p6.H']! + values['p6.I']!, [
    'p6.G',
    'p6.H',
    'p6.I',
  ]);
  put('p6.K', values['p6.F']! - values['p6.J']!, ['p6.F', 'p6.J']);
  put('p6.L', multiply(values['p6.K']!, 23n, 75n), ['p6.K']);
  put('p6.M', federalTax, ['700', '780']);
  put('450', min(values['p6.E']!, values['p6.L']!, values['p6.M']!), [
    'p6.E',
    'p6.L',
    'p6.M',
  ]);
  const history = input.priorYear.refundableTaxHistory;
  put('520', parse(history.eligibleRdToh));
  put('535', nonnegative(parse(history.nonEligibleRdToh)));
  put('570', parse(history.eligibleDividendRefund));
  put('575', parse(history.nonEligibleDividendRefund));
  put('525', 0n);
  put('540', 0n);
  put('p7.C', 0n);
  put('p7.D', 0n);
  put('p7.E', 0n, ['p7.C', 'p7.D']);
  put('p7.H', values['450']!, ['450']);
  put('p7.I', 0n);
  put('p7.J', values['p7.E']!, ['p7.E']);
  put('p7.K', 0n);
  put('p7.L', values['p7.I']! - values['p7.J']! - values['p7.K']!, [
    'p7.I',
    'p7.J',
    'p7.K',
  ]);
  put('p7.O', multiply(0n, 23n, 60n));
  put('p7.P', nonnegative(values['p7.L']! - values['p7.O']!), ['p7.L', 'p7.O']);
  put(
    '545',
    nonnegative(
      values['535']! +
        values['p7.H']! +
        values['540']! +
        values['p7.P']! -
        values['575']!,
    ),
    ['535', 'p7.H', '540', 'p7.P', '575'],
  );
  put(
    'p7.Q',
    nonnegative(
      values['p7.E']! - nonnegative(values['p7.O']! - values['p7.L']!),
    ),
    ['p7.E', 'p7.O', 'p7.L'],
  );
  put(
    '530',
    nonnegative(
      values['520']! + values['525']! + values['p7.Q']! - values['570']!,
    ),
    ['520', '525', 'p7.Q', '570'],
  );
  put('p7.AA', multiply(0n, 23n, 60n));
  put('p7.BB', values['530']!, ['530']);
  put('p7.CC', min(values['p7.AA']!, values['p7.BB']!), ['p7.AA', 'p7.BB']);
  put('p7.DD', multiply(0n, 23n, 60n));
  put('p7.EE', values['545']!, ['545']);
  put('p7.FF', min(values['p7.DD']!, values['p7.EE']!), ['p7.DD', 'p7.EE']);
  put('p7.GG', nonnegative(values['p7.DD']! - values['p7.EE']!), [
    'p7.DD',
    'p7.EE',
  ]);
  put('p7.HH', nonnegative(values['p7.BB']! - values['p7.CC']!), [
    'p7.BB',
    'p7.CC',
  ]);
  put('p7.II', min(values['p7.GG']!, values['p7.HH']!), ['p7.GG', 'p7.HH']);
  put('p7.JJ', values['p7.CC']! + values['p7.FF']! + values['p7.II']!, [
    'p7.CC',
    'p7.FF',
    'p7.II',
  ]);
  put('784', values['p7.JJ']!, ['p7.JJ']);
  return { values, dependencies };
}
