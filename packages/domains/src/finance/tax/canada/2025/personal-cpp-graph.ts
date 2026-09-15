/** Reviewed dependency graph for CRA Schedule 8 E (25), parts 3, 4 and 5.
 * Only called after the personal candidate's ordinary 12-month CPP guards pass.
 * Dependencies include conditional comparisons; exact-looking descendants cannot
 * bypass an unresolved fractional-cent source or branch decision. */
const part3: Record<number, number[]> = {
  2: [1],
  3: [],
  4: [2, 3],
  5: [2, 4],
  6: [],
  7: [5, 6],
  9: [8],
  10: [8, 9],
  11: [7],
  12: [7],
  13: [11, 12],
  14: [9],
  15: [11],
  16: [14, 15],
  17: [10],
  18: [12],
  19: [17, 18],
  20: [16, 19],
  22: [4],
  23: [21, 22],
  24: [20, 23],
  25: [15, 24],
  26: [18, 24],
  27: [22, 24],
  28: [26, 27],
  29: [24],
  30: [16, 15, 14, 24],
  31: [16],
  32: [16, 19],
  33: [31, 32],
  34: [30, 32],
  35: [23, 33],
  36: [34, 35],
  37: [19, 18, 17, 24],
  38: [19],
  39: [19, 16],
  40: [38, 39],
  41: [37, 39],
  42: [23, 40, 35],
  43: [41, 42],
  44: [23, 22, 21, 24],
  45: [23],
  46: [23, 20],
  47: [44, 46],
  48: [43, 47],
};
const part4: Record<number, number[]> = {
  2: [],
  3: [1, 2],
  4: [3],
  5: [],
  6: [4, 5],
  7: [4, 6],
  8: [],
  9: [7, 8],
  10: [9],
  11: [9],
  12: [6],
  13: [11, 12],
  14: [10, 13],
  15: [10],
  16: [13],
  17: [15, 16],
};
const p3 = (line: number) => `Schedule8.part3.line${line}`;
const part5: Record<number, Array<number | string>> = {
  1: ['T1.13500', 'T1.13900', 'fact:scope.ordinaryCpp', 'fact:dateOfBirth'],
  2: ['fact:scope.ordinaryCpp'],
  3: ['fact:scope.ordinaryCpp'],
  4: [1, 2, 3],
  5: [p3(8)],
  6: [p3(20)],
  7: [5, 6],
  8: [p3(20)],
  9: [p3(20), p3(23), 8],
  10: [7, 9],
  11: [p3(21)],
  12: [p3(23)],
  13: [11, 12],
  14: [p3(23)],
  15: [p3(20), p3(23), 14],
  16: [13, 15],
  17: ['fact:scope.ordinaryCpp', 'fact:dateOfBirth'],
  18: ['fact:scope.ordinaryCpp', 'fact:dateOfBirth'],
  19: [17, 18],
  20: [10],
  21: [19, 20],
  22: [4, 21],
  23: [p3(1), 18],
  24: [p3(1), 18],
  25: [23, 24],
  26: [p3(1), 18, 4],
  27: [p3(1), 18, 19],
  28: [26, 27],
  29: [25, 28],
  30: [22, 29],
  31: [4],
  32: [p3(2)],
  33: [31, 32],
  34: [33, 17, 'fact:scope.ordinaryCpp'],
  35: [16],
  36: [34, 35],
  37: [4],
  38: [25],
  39: [37, 38],
  40: [30],
  41: [39, 40],
  42: [33, 17, 36, 41],
  43: [30, 42],
  44: [30, 42],
  45: [42, 30],
  46: [44, 45],
  47: [43, 46],
  48: [p3(24)],
  49: [47, 48],
  50: [49],
  51: [p3(16), p3(11), p3(9), 30, 42],
  52: [p3(16)],
  53: [p3(16), p3(19), 52],
  54: [52, 53],
  55: [51, 53],
  56: [p3(23), 54],
  57: [55, 56],
  58: [p3(19), p3(12), p3(10)],
  59: [p3(19)],
  60: [p3(19), p3(16), 59],
  61: [59, 60],
  62: [58, 60],
  63: [p3(23), 61, 56],
  64: [62, 63],
  65: [p3(23), p3(22), p3(21)],
  66: [p3(23)],
  67: [p3(23), p3(20), 66],
  68: [65, 67],
  69: [64, 68],
  70: [43],
  71: [44],
  72: [70, 71],
  73: [p3(24)],
  74: [72, 73],
  75: [72, 73],
  76: [75],
  77: [72, 73, 76],
  78: [70],
  79: [75],
  80: [78, 79],
  81: [71],
  82: [77],
  83: [81, 82],
  84: [45],
  85: [84],
  86: [74],
  87: [85, 86],
  88: [80, 81, 83, 84, 87],
};
export function personalCppWorksheetDependencies(
  locator: string,
  worksheetLocators: string[] = [],
): string[] | null {
  const match = /^part([345])\.line(\d+)$/.exec(locator);
  if (!match) return null;
  const part = Number(match[1]),
    line = Number(match[2]);
  if (part === 5) {
    // The printed line33 condition skips34–41 and writes zero directly at42.
    const dependencies =
      line === 42 && !worksheetLocators.includes('part5.line36')
        ? [33, 17]
        : part5[line];
    return (
      dependencies?.map((d) =>
        typeof d === 'number' ? `Schedule8.part5.line${d}` : d,
      ) ?? null
    );
  }
  if (part === 3 && line === 1) return ['fact:t4.box14', 'fact:t4.box26'];
  if (part === 3 && line === 8) return ['fact:t4.box16'];
  if (part === 3 && line === 21) return ['fact:t4.box16A'];
  if (part === 4 && line === 1)
    return [
      'T1.13500',
      'T1.13900',
      'fact:scope.ordinaryCpp',
      'fact:dateOfBirth',
    ];
  const dependencies = (part === 3 ? part3 : part4)[line];
  if (!dependencies) return null;
  return [
    ...dependencies.map((n) => `Schedule8.part${part}.line${n}`),
    // Published Part2 12-month limits and no CPT20 election are reviewed inputs.
    ...(([2, 3, 6].includes(line) && part === 3) ||
    ([2, 4, 5, 8].includes(line) && part === 4)
      ? ['fact:scope.ordinaryCpp', 'fact:dateOfBirth']
      : []),
  ];
}
export function personalCppTransferDependencies(
  line: string,
  branch: 'employment-only' | 'self-employment-only' | 'mixed',
  worksheetLocators: string[],
): string[] {
  const noEmployment = [
    'fact:t4.box14',
    'fact:t4.box26',
    'fact:t4.box16',
    'fact:t4.box16A',
    'fact:scope.ordinaryCpp',
  ];
  if (branch === 'self-employment-only') {
    const from = (
      { '22200': 17, '31000': 15, '42100': 14 } as Record<string, number>
    )[line];
    return from ? [`Schedule8.part4.line${from}`] : noEmployment;
  }
  if (branch === 'employment-only') {
    if (['22200', '31000', '42100'].includes(line))
      return ['T1.13500', 'T1.13900', 'fact:scope.ordinaryCpp'];
    const positive = worksheetLocators.includes('part3.line25');
    const from = (
      {
        '30800': positive ? 25 : 36,
        '22215': positive ? 28 : 48,
        '44800': positive ? 29 : 24,
      } as Record<string, number>
    )[line];
    if (from) return [`Schedule8.part3.line${from}`];
  }
  if (branch === 'mixed') {
    const branchDependencies = [
      'Schedule8.part5.line30',
      'Schedule8.part5.line42',
    ];
    // Page9 explicitly returns to Part3 when both contribution bases are zero.
    if (!worksheetLocators.includes('part5.line43')) {
      if (['22200', '31000', '42100'].includes(line)) return branchDependencies;
      const positive = worksheetLocators.includes('part3.line25');
      const from = (
        {
          '30800': positive ? 25 : 36,
          '22215': positive ? 28 : 48,
          '44800': positive ? 29 : 24,
        } as Record<string, number>
      )[line];
      if (from) return [...branchDependencies, `Schedule8.part3.line${from}`];
    } else {
      const from = (
        {
          '30800': 57,
          '22215': 69,
          '31000': 70,
          '22200': 88,
          '42100': 49,
          '44800': 50,
        } as Record<string, number>
      )[line];
      if (from) return [`Schedule8.part5.line${from}`, ...branchDependencies];
    }
  }
  return ['Schedule8.unknown-transfer-proof'];
}
