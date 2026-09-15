import type { CorporateForm } from './workflow.js';
import { CORPORATE_XFA_FIELDS } from './xfa-inventory.js';

/** Supported-case S1/S5 graph, after the parent workflow validates no other
 * adjustments, provincial credits or special taxes. Sources: S1 E(25) pp1–4;
 * S5 E(25) p5 Ontario 5A–5J. Mutates only freshly constructed local form rows. */
export function populateCorporateSchedules(
  forms: CorporateForm[],
  money: (value: bigint) => CorporateForm['fields'][string],
  parse: (value: string) => bigint,
) {
  const graph: Record<string, string[]> = {};
  const s1 = forms.find((f) => f.id === 'S1')!;
  const numericLines = [
    ...new Set(
      CORPORATE_XFA_FIELDS.filter(
        (f) => f.form === 'S1' && f.decimalPlaces !== null,
      ).flatMap((f) => /^Line (\d+)\./.exec(f.assist ?? '')?.[1] ?? []),
    ),
  ];
  for (const line of numericLines)
    if (!(line in s1.fields)) {
      s1.fields[line] = money(0n);
      graph[`S1.${line}`] = [];
    }
  for (const [line, deps] of [
    [
      'D',
      [
        ...numericLines.filter((k) => Number(k) >= 201 && Number(k) <= 254),
        '296',
      ],
    ],
    [
      'E',
      [
        ...numericLines.filter((k) => Number(k) >= 300 && Number(k) <= 350),
        '396',
      ],
    ],
  ] as [string, string[]][]) {
    s1.fields[line] = money(0n);
    graph[`S1.${line}`] = deps.map((k) => `S1.${k}`);
  }
  graph['S1.199'] = ['S1.D'];
  graph['S1.499'] = ['S1.E'];
  const s5 = forms.find((f) => f.id === 'S5')!;
  const value = (line: string) =>
    parse((s5.fields[line] as { exactDecimal: string }).exactDecimal);
  const set = (line: string, amount: bigint, deps: string[] = []) => {
    s5.fields[line] = money(amount);
    graph[`S5.${line}`] = deps.map((d) => `S5.${d}`);
  };
  const floor = (v: bigint) => (v < 0n ? 0n : v);
  const added = ['276', '277', '281'],
    credits = ['406', '408', '410', '415'],
    refundable = [
      '450',
      '452',
      '456',
      '458',
      '460',
      '462',
      '466',
      '468',
      '470',
      '472',
      '474',
    ];
  for (const line of [
    ...added,
    ...credits,
    ...refundable,
    '416',
    '418',
    '420',
    '278',
    '280',
  ])
    set(line, 0n);
  set('5A', value('270') - value('402'), ['270', '402']);
  set('5B', 0n, added);
  set('5C', value('5A') + value('5B'), ['5A', '5B']);
  set('5D', 0n, credits);
  set('5E', floor(value('5C') - value('5D')), ['5C', '5D']);
  set('5F', floor(value('5E') - value('416')), ['5E', '416']);
  set('5G', floor(value('5F') - value('418') - value('420')), [
    '5F',
    '418',
    '420',
  ]);
  set('5H', 0n, ['278', '280']);
  set('5I', value('5G') + value('5H'), ['5G', '5H']);
  set('5J', 0n, refundable);
  set('290', value('5I') - value('5J'), ['5I', '5J']);
  return graph;
}
