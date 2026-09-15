import {
  decimal as q,
  plus,
  minus,
  times,
  positive,
  minimum,
  type PersonalExact,
} from './personal-exact.js';

/** The caller must first validate the personal candidate's reviewed single-person,
 * no-other-income/deductions/credits/ACWB guards. These are monetary worksheet
 * lines, not identity/election fields or an assertion of form completeness. */
export function appendCanada2025SingleBenefitSchedules(
  schedule: 'ON428-A' | 'Schedule6',
  at: (id: string) => PersonalExact,
  field: (
    id: string,
    label: string,
    value: PersonalExact,
    dependencies: string[],
    sourceId?: string,
    locator?: string,
  ) => PersonalExact,
) {
  const source = schedule === 'ON428-A' ? 'cra-5006-a-25e' : 'cra-5000-s6-25e';
  const id = (line: number) => `${schedule}.${line}`;
  const value = (line: number) => at(id(line));
  const add = (
    line: number,
    label: string,
    amount: PersonalExact,
    dependencies: string[] = [],
  ) =>
    field(
      id(line),
      label,
      amount,
      dependencies,
      source,
      `${schedule} E (25), line ${line}${schedule === 'Schedule6' && line <= 12 ? ', column 1' : ''}`,
    );
  const copy = (line: number, from: string, label: string) =>
    add(line, label, at(from), [from]);
  const zero = (line: number, guard: string, label: string) =>
    add(line, label, q('0'), [`fact:${guard}`]);
  const sum = (line: number, lines: number[], label: string) =>
    add(line, label, plus(...lines.map(value)), lines.map(id));
  if (schedule === 'ON428-A') {
    copy(1, 'T1.10100', 'Employment income');
    zero(
      2,
      'scope.noOtherIncome',
      'Other employment income excluded by reviewed scope',
    );
    sum(3, [1, 2], 'Total employment income');
    add(
      5,
      'Maximum allowable LIFT credit',
      minimum(times(value(3), q('0.0505')), q('875')),
      [id(3)],
    );
    copy(6, 'T1.23600', 'Net income');
    zero(7, 'scope.noOtherDeductions', 'UCCB repayment excluded');
    zero(8, 'scope.noOtherDeductions', 'RDSP income repayment excluded');
    sum(9, [6, 7, 8], 'Net income plus repayments');
    zero(10, 'scope.noOtherIncome', 'UCCB income excluded');
    zero(11, 'scope.noOtherIncome', 'RDSP income excluded');
    sum(12, [10, 11], 'UCCB and RDSP income');
    add(13, 'Adjusted net income', positive(minus(value(9), value(12))), [
      id(9),
      id(12),
    ]);
    copy(14, id(5), 'Maximum single-person credit');
    copy(15, id(13), 'Single-person adjusted net income');
    add(16, 'Individual income threshold', q('32500'));
    add(17, 'Income above threshold', positive(minus(value(15), value(16))), [
      id(15),
      id(16),
    ]);
    add(19, 'LIFT income reduction at 5%', times(value(17), q('0.05')), [
      id(17),
    ]);
    add(
      20,
      'Single-person LIFT credit',
      positive(minus(value(14), value(19))),
      [id(14), id(19)],
    );
    field(
      'ON428.62140',
      'LIFT credit',
      value(20),
      [id(20)],
      'cra-5006-c-2025-etext',
      'ON428 line 85; transfer from ON428-A line 20',
    );
    return;
  }
  copy(1, 'T1.10100', 'Employment income; other employment excluded');
  zero(2, 'scope.noOtherIncome', 'Taxable scholarship income excluded');
  add(
    3,
    'Positive business and commission income',
    plus(positive(at('T1.13500')), positive(at('T1.13900'))),
    ['T1.13500', 'T1.13900'],
  );
  zero(4, 'scope.noSpecialReturns', 'Exempt working income excluded');
  sum(5, [1, 2, 3, 4], 'Working income');
  copy(6, id(5), 'Family working income; no eligible spouse');
  copy(7, 'T1.23600', 'Net income');
  zero(8, 'scope.noSpecialReturns', 'Net exempt income excluded');
  zero(9, 'scope.noOtherDeductions', 'UCCB and RDSP repayments excluded');
  sum(10, [7, 8, 9], 'Net income plus adjustments');
  zero(11, 'scope.noOtherIncome', 'UCCB and RDSP income excluded');
  add(12, 'Adjusted net income', positive(minus(value(10), value(11))), [
    id(10),
    id(11),
  ]);
  copy(13, id(12), 'Family adjusted net income; no eligible spouse');
  // Printed line 13 instructs a person without an eligible spouse to skip line 14.
  copy(15, id(13), 'Adjusted family net income; line 14 not applicable');
  copy(16, id(6), 'Family working income');
  add(17, 'Working income base amount', q('3000'));
  add(18, 'Working income above base', positive(minus(value(16), value(17))), [
    id(16),
    id(17),
  ]);
  add(20, 'Basic benefit at 27%', times(value(18), q('0.27')), [id(18)]);
  add(21, 'Maximum benefit without spouse or dependant', q('1633'), [
    'fact:scope.singleNoDependants',
  ]);
  add(22, 'CWB before income reduction', minimum(value(20), value(21)), [
    id(20),
    id(21),
  ]);
  copy(23, id(15), 'Adjusted family net income');
  add(24, 'Income reduction base without spouse or dependant', q('26855'), [
    'fact:scope.singleNoDependants',
  ]);
  add(25, 'Adjusted income above base', positive(minus(value(23), value(24))), [
    id(23),
    id(24),
  ]);
  add(27, 'CWB income reduction at 15%', times(value(25), q('0.15')), [id(25)]);
  add(
    28,
    'Basic Canada workers benefit',
    positive(minus(value(22), value(27))),
    [id(22), id(27)],
  );
  field(
    'T1.45300',
    'Basic CWB working figure',
    value(28),
    [id(28)],
    source,
    'Schedule 6 line 28 to T1 line 45300; no DTC or RC210',
  );
}
