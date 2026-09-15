import type { CanadaCorporate2025Intake } from './intake.js';

/** Captured T2 E(25), pages 3/4/8/9. Coverage validation precedes this graph.
 * Zero adjustments are justified by explicit attachment/special-tax/credit declarations.
 * No reporting rounding and no CRA administrative $2 write-off are applied. */
export function corporateT2Totals(
  input: CanadaCorporate2025Intake,
  seed: Record<string, bigint>,
  parse: (value: string) => bigint,
) {
  const values = { ...seed };
  const dependencies: Record<string, string[]> = {};
  const set = (key: string, value: bigint, deps: string[] = []) => {
    values[key] = value;
    dependencies[`T2.${key}`] = deps.map((d) => `T2.${d}`);
    return value;
  };
  const sum = (keys: string[]) =>
    keys.reduce((total, key) => total + values[key]!, 0n);
  const floor = (value: bigint) => (value < 0n ? 0n : value);
  const min = (keys: string[]) =>
    keys.map((k) => values[k]!).reduce((a, b) => (a < b ? a : b));
  const rate = (value: bigint, n: bigint, d: bigint) => {
    if ((value * n) % d !== 0n)
      throw new Error('corporate-totals-exact-scale-exceeded');
    return (value * n) / d;
  };
  const deductions = [
    '311',
    '313',
    '314',
    '320',
    '325',
    '331',
    '332',
    '333',
    '334',
    '335',
    '336',
    '340',
    '350',
    '352',
  ];
  deductions.forEach((key) => set(key, 0n));
  set('p3.B', sum(deductions), deductions);
  set('p3.C', floor(values['300']! - values['p3.B']!), ['300', 'p3.B']);
  set('355', 0n);
  set('360', values['p3.C']! + values['355']!, ['p3.C', '355']);
  set(
    '405',
    values['360']! - rate(values['632']!, 100n, 28n) - values['636']! * 4n,
    ['360', '632', '636'],
  );
  set('p4.C', values['410']!, ['410']);
  set('p4.E', rate(values['410']! * values['415']!, 1n, 90_000n * parse('1')), [
    '410',
    '415',
  ]);
  // The form specifies subtraction without a zero floor here. Only the greater E/G controls line422.
  set('p4.F', values['417']! - parse('50000'), ['417']);
  set(
    'p4.G',
    rate(values['410']! * values['p4.F']!, 1n, 100_000n * parse('1')),
    ['410', 'p4.F'],
  );
  set(
    '422',
    values['p4.E']! > values['p4.G']! ? values['p4.E']! : values['p4.G']!,
    ['p4.E', 'p4.G'],
  );
  set('426', floor(values['410']! - values['422']!), ['410', '422']);
  set('510', 0n);
  set('515', 0n);
  set('p4.J', values['515']!, ['515']);
  set('428', values['426']! - values['p4.J']!, ['426', 'p4.J']);
  set('p4.minimum', min(['400', '405', '410', '428']), [
    '400',
    '405',
    '410',
    '428',
  ]);
  set('430', rate(values['p4.minimum']!, 19n, 100n), ['p4.minimum']);
  set('555', 0n);
  set('560', rate(values['555']!, 5n, 100n), ['555']);
  [
    '565',
    '580',
    '602',
    '616',
    '620',
    '624',
    '639',
    '640',
    '641',
    '648',
    '652',
  ].forEach((key) => set(key, 0n));
  set('p8.F', values['440']!, ['440']);
  set('p8.G', values['360']!, ['360']);
  set('p8.H', min(['400', '405', '410', '428']), ['400', '405', '410', '428']);
  set('p8.I', values['p8.G']! - values['p8.H']!, ['p8.G', 'p8.H']);
  set('604', rate(min(['p8.F', 'p8.I']), 8n, 75n), ['p8.F', 'p8.I']);
  const additions = ['550', '560', '565', '580', '602', '604'];
  set('p8.K', sum(additions), additions);
  set('p8.L', values['430']!, ['430']);
  const reductions = [
    'p8.L',
    '608',
    '616',
    '620',
    '632',
    '636',
    '638',
    '639',
    '640',
    '641',
    '648',
    '652',
  ];
  set('p8.M', sum(reductions), reductions);
  set('p8.N', values['p8.K']! - values['p8.M']!, ['p8.K', 'p8.M']);
  set('700', values['p8.N']!, ['p8.N']);
  const otherTaxes = [
    '705',
    '710',
    '712',
    '716',
    '720',
    '724',
    '725',
    '726',
    '727',
    '728',
  ];
  otherTaxes.forEach((key) => set(key, 0n));
  set('p9.totalFederal', sum(['700', ...otherTaxes]), ['700', ...otherTaxes]);
  set('770', values['p9.totalFederal']! + values['760']!, [
    'p9.totalFederal',
    '760',
  ]);
  ['788', '792', '795', '796', '797', '798', '808', '812'].forEach((key) =>
    set(key, 0n),
  );
  set('800', parse(input.taxWithholding.amount));
  set('801', parse(input.taxWithholding.payments));
  const credits = [
    '780',
    '784',
    '788',
    '792',
    '795',
    '796',
    '797',
    '798',
    '800',
    '808',
    '812',
    '840',
  ];
  set('890', sum(credits), credits);
  set('p9.balance', values['770']! - values['890']!, ['770', '890']);
  set('refund', floor(-values['p9.balance']!), ['p9.balance']);
  set('balanceOwing', floor(values['p9.balance']!), ['p9.balance']);
  return { values, dependencies };
}
