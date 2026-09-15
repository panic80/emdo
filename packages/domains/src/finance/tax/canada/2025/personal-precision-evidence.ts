import { deepFreeze } from '@emdo/contracts';
/** Public CRA fillable PDF evidence. Format proves accepted cents, not an arithmetic rounding algorithm. */
export const PERSONAL_PAPER_PRECISION_SOURCES = deepFreeze([
  {
    id: 'cra-5000-d1-2025-fillable',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5000-d1/5000-d1-fill-25e.pdf',
    localFile: '5000-d1-fill-25e.pdf',
    documentHash:
      '70bc4b41f3e6eea1cf559d6b2e4c0f09b46405c0bb43f2e93c14dc33f5b343f7',
    retrievedAt: '2026-09-14T23:59:27.058466+00:00',
    formVersion: '5000-d1-fill-25e.pdf',
  },
  {
    id: 'cra-5000-s9-2025-fillable',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5000-s9/5000-s9-fill-25e.pdf',
    localFile: '5000-s9-fill-25e.pdf',
    documentHash:
      'aac16785c69833801b8b4c4d0203b6cfc49f48cd7638dc6e61b69a294ddc5542',
    retrievedAt: '2026-09-15T05:00:00+00:00',
    formVersion: '5000-s9-fill-25e.pdf',
  },
  {
    id: 'cra-5006-r-2025-fillable',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5006-r/5006-r-fill-25e.pdf',
    localFile: '5006-r-fill-25e.pdf',
    documentHash:
      'd307c87b2e53d98653d45065ca1b5d7b0ded5b6220e59fe6fef67c6c06717539',
    retrievedAt: '2026-09-14T02:49:18.481571+00:00',
    formVersion: '5006-r-fill-25e.pdf',
  },
  {
    id: 'cra-5006-c-2025-fillable',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5006-c/5006-c-fill-25e.pdf',
    localFile: '5006-c-fill-25e.pdf',
    documentHash:
      '13902084cf55966ca3cccb103190e49991d1f44d50991e29613f82b06dbd551e',
    retrievedAt: '2026-09-14T02:49:19.681801+00:00',
    formVersion: '5006-c-fill-25e.pdf',
  },
  {
    id: 'cra-5000-s8-2025-fillable',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5000-s8/5000-s8-fill-25e.pdf',
    localFile: '5000-s8-fill-25e.pdf',
    documentHash:
      '32827b2773fce2d4caab493809e2874949c5d5d2c800b7a7b2b2177c91534656',
    retrievedAt: '2026-09-14T02:49:21.837360+00:00',
    formVersion: '5000-s8-fill-25e.pdf',
  },
  {
    id: 'cra-5000-s6-2025-fillable',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5000-s6/5000-s6-fill-25e.pdf',
    localFile: '5000-s6-fill-25e.pdf',
    documentHash:
      'a31ecaf0c664485b616c6726ba14b0194891ae81e6297abfd28adcee3da78574',
    retrievedAt: '2026-09-14T02:49:23.141834+00:00',
    formVersion: '5000-s6-fill-25e.pdf',
  },
  {
    id: 'cra-5006-a-2025-fillable',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5006-a/5006-a-fill-25e.pdf',
    localFile: '5006-a-fill-25e.pdf',
    documentHash:
      '5364f60648f8a8c4d77a10655bc46731579060d775c2151268b894a012409e19',
    retrievedAt: '2026-09-14T02:49:24.530937+00:00',
    formVersion: '5006-a-fill-25e.pdf',
  },
  {
    id: 'cra-t2125-2025-fillable',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/t2125/t2125-fill-25e.pdf',
    localFile: 't2125-fill-25e.pdf',
    documentHash:
      '4645a511daf9f543a8560d053101e53d79d60d8443688ea7d39d71333b308584',
    retrievedAt: '2026-09-14T02:49:27.740198+00:00',
    formVersion: 't2125-fill-25e.pdf',
  },
  {
    id: 'cra-t2204-2025-fillable',
    url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/t2204/t2204-fill-25e.pdf',
    localFile: 't2204-fill-25e.pdf',
    documentHash:
      '8e868a81cb15764fb4e6cbdd402e088d375396d83e7ef557dd524db002d69308',
    retrievedAt: '2026-09-14T02:49:29.097019+00:00',
    formVersion: 't2204-fill-25e.pdf',
  },
]);
const federalTaxPaperProofs = Object.fromEntries(
  [1, 2, 3, 4, 5].flatMap((column) =>
    [70, 71, 72, 74, 75, 76].map((line) => {
      const suffix = {
        70: `Line36Amount${column}`,
        71: `Line37Amount${column}`,
        72: `Line38Amount${column}`,
        74: `Line40Amount${column}`,
        75: `Line41Amount${column}`,
        76: `Line42Amount${column}`,
      }[line]!;
      const readonly = line === 71 || line === 75;
      return [
        `FederalTax.Column${column}.${line}`,
        {
          sourceId: 'cra-5006-r-2025-fillable',
          path: `form1.Page5.PartA.Column${column}.${suffix}`,
          inputPattern: 'num{zzzzzzzzzzzz9.99}',
          displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
          changeScripts: readonly
            ? []
            : ['CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n'],
        },
      ];
    }),
  ),
) as Record<
  string,
  {
    sourceId: string;
    path: string;
    inputPattern: string;
    displayPattern: string;
    changeScripts: string[];
  }
>;
const schedule9PaperProofs = Object.fromEntries(
  [
    ['1', 'form1.Page1.Line1.Amount'],
    ['5', 'form1.Page1.Line5.Amount'],
    ['6A', 'form1.Page1.Line6.AmountA.Amount'],
    ['6', 'form1.Page1.Line6.Amount'],
    ['7D', 'form1.Page1.Line7.AmountD.Amount'],
    ['7', 'form1.Page1.Line7.Amount'],
    ['8', 'form1.Page1.Line8.Amount'],
    ['9', 'form1.Page1.Line9.Amount'],
    ['10', 'form1.Page1.Line10.Amount'],
    ['11', 'form1.Page1.Line11.Amount'],
    ['12', 'form1.Page1.Line12.Amount'],
    ['13', 'form1.Page1.Line13.Amount_Line13'],
    ['14', 'form1.Page1.Line14.Amount_Line14'],
    ['15', 'form1.Page1.Line15.Amount'],
    ['16', 'form1.Page1.Line16.Amount'],
    ['17', 'form1.Page1.Line17.Amount'],
    ['18', 'form1.Page1.Line18.Amount'],
    ['19', 'form1.Page1.Line19.Amount'],
    ['20Base', 'form1.Page2.Line20.AmountF.Amount'],
    ['20', 'form1.Page2.Line20.Amount'],
    ['21Base', 'form1.Page2.Line21.AmountG.Amount'],
    ['21', 'form1.Page2.Line21.Amount'],
    ['22', 'form1.Page2.Line22.Amount'],
    ['23', 'form1.Page2.Line23.Amount'],
  ].map(([line, path]) => [
    `Schedule9.${line}`,
    {
      sourceId: 'cra-5000-s9-2025-fillable',
      path,
      inputPattern: 'num{zzzzzzzzzzzz9.zz}',
      displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
      changeScripts: [
        'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
      ],
    },
  ]),
) as Record<
  string,
  {
    sourceId: string;
    path: string;
    inputPattern: string;
    displayPattern: string;
    changeScripts: string[];
  }
>;
export const PERSONAL_PAPER_FIELD_PROOFS = deepFreeze({
  ...federalTaxPaperProofs,
  ...schedule9PaperProofs,
  'T1.34900': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line34900.Line_34900_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.30000': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page5.PartB.Line30000.Line_30000_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'FederalBpa.1': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line1.Line1_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 8, false);\n\n',
    ],
  },
  'FederalBpa.2': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line2.Line2_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 8, false);\n\n',
    ],
  },
  'FederalBpa.3': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line3.Line3_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'FederalBpa.4': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line4.Line4_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 8, false);\n\n',
    ],
  },
  'FederalBpa.5': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line5.Line5_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'FederalBpa.6': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line6.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 8, false);\n\n',
    ],
  },
  'FederalBpa.7': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line7.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'FederalBpa.8': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line8.Line2_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 8, false);\n\n',
    ],
  },
  'FederalBpa.9': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line9.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'FederalBpa.9.copy2': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line9.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'FederalBpa.10': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line10.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'FederalBpa.10.copy2': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line10.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'FederalBpa.11': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page3.Line30000.Line11.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.84': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page5.PartB.Line89.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.85': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line90.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.96': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line102.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.96.copy2': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line102.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.98': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line104.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.101': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line107.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.106': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line112.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.33500': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line33500.Line_33500_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.33800': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line33800.Line_33800_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.34990': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line34990.Line_34990_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'FederalTopUp.1': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page7.Line34990.Line1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'FederalTopUp.2': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page7.Line34990.Line2.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'FederalTopUp.3': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page7.Line34990.Line3.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'FederalTopUp.4': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page7.Line34990.Line4.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'FederalTopUp.5': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page7.Line34990.Line5.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'FederalTopUp.7': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page7.Line34990.Line7.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },

  'T1.143': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.Step6.Line148.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.43500': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.Step6.Line43500.Line_43500_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.149': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line154.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.48200': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line48200.Line_48200_Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.166': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line48200.Line_48200_Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.167': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line172.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{(z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'if((xfa.event.change == "(")||(xfa.event.change == ")"))\n\t{\n\txfa.host.messageBox(\'Enter a negative sign "-" to indicate a negative value. The value will be automatically formatted with brackets.\', "Information Message", 3, 0);\n\txfa.event.change = "";\n\t}\nelse\n\t{ CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\t}\n\n',
    ],
  },
  'T1.48400': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Refund_or_Balance-owing.Line48400.Line_48400_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.48500': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Refund_or_Balance-owing.Line48500.Line_48500_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },

  'T1.119': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line124.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.40400': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line40400.Line_40400_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.122': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line127.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.125': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line130.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.125.copy2': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line130.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.42900': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line42900.Line_42900_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.128': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line133.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.130': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line135.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.132': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line137.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.40600': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line40600.Line_40600_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.41600': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line41600.Line_41600_Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.41600.copy2': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line41600.Line_41600_Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.41700': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line41700.Line_41700_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.42000': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.PartC.Line42000.Line_42000_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.35000': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line35000.Line_35000_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },

  'ON428.18': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Part_B.Line18.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.24': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Part_B.Line24.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.24.copy2': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Part_B.Line24.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.25': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Part_B.Line25.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.26': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line26.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.28': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line28.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.31': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line31.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.35': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line35.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.58840': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line46.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.61500': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line50.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.52': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line52.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.53': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line53.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.55': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line55.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.56': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Min-Tax-Carryover.Line56.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.58': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Min-Tax-Carryover.Line58.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.59.base': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Min-Tax-Carryover.Line59.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.59': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Min-Tax-Carryover.Line59.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.61540': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Min-Tax-Carryover.Line60.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.61': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line61.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.74': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line74.Amount',
    inputPattern: 'num{zz,zz9.99}',
    displayPattern: 'num{zz,zz9.99}',
    changeScripts: [],
  },
  'ON428.77': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line77.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.78.base': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line78.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ON428.78': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line78.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.79': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line79.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.80': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line80.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.80.copy2': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line80.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.81': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line81.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.83': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line83.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.84': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.Line84.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.86': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.Line86.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.88': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.Line88.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.90': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.Line90.Amount',
    inputPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.42800': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.Step6.Line42800.Line_42800_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },

  'ON428.1': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Line1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.8': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line51.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column1.2': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column1.Line2.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column1.4': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column1.Line4.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ONBracket.column1.6': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column1.Line6.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column1.8': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column1.Line8.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column2.2': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column2.Line2.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column2.4': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column2.Line4.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ONBracket.column2.6': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column2.Line6.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column2.8': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column2.Line8.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column3.2': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column3.Line2.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column3.4': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column3.Line4.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ONBracket.column3.6': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column3.Line6.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column3.8': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column3.Line8.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column4.2': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column4.Line2.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column4.4': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column4.Line4.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ONBracket.column4.6': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column4.Line6.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column4.8': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column4.Line8.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column5.2': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column5.Line2.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column5.4': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column5.Line4.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ONBracket.column5.6': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column5.Line6.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONBracket.column5.8': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Chart.Column5.Line8.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },

  'ON428.62': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line62.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.63': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.ON-Surtax.Line63.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.65': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.ON-Surtax.Line65.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.66.base': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line66.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.66': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line66.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.67.base': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line67.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.67': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line67.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.68': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line68.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.68.copy2': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line68.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.69': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line69.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.71': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line71.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.73': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page3.Line73.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },

  'ON428.89': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.Line89.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONHealthPremium.1': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.ON_Health_Prenium_Sub.Line1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ONHealthPremium.row2.income': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line2.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row2.excess': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line2.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row2.rateProduct': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line2.Amount3',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row4.income': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line4.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row4.excess': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line4.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row4.rateProduct': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line4.Amount3',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row4.total': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line4.Amount4',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row6.income': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line6.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row6.excess': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line6.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row6.rateProduct': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line6.Amount3',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row6.total': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line6.Amount4',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row8.income': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line8.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row8.excess': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line8.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row8.rateProduct': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line8.Amount3',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row8.total': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line8.Amount4',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row10.income': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line10.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row10.excess': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line10.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row10.rateProduct': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line10.Amount3',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },
  'ONHealthPremium.row10.total': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.ON_Health_Prenium-worksheet.Chart_ON_Health_Prenium.Taxable_Line10.Amount4',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this,9, false);\n\n',
    ],
  },

  'T2125.5C.copy2': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt5_sf.Prt5_Frm_sf.Prt5_Frm_Ln3_sf.Prt5_Frm_Ln3_grp.Prt5_Frm_Ln3_grp_inpt2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.9368.copy2': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt4_sf.Prt4_Frm_sf.Prt4_Frm_Ln9368_sf.Prt4_Frm_Ln9368_grp.Prt4_Frm_Ln9368_grp_inpt2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.3A': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page2.Prt3A_sf.Prt3A_Frm_sf.Prt3A_Frm_Ln1_sf.Prt3A_Frm_Ln1_grp.Prt3A_Frm_Ln1_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.3B': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page2.Prt3A_sf.Prt3A_Frm_sf.Prt3A_Frm_Ln2_sf.Prt3A_Frm_Ln2_grp.Prt3A_Frm_Ln2_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.3C': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page2.Prt3A_sf.Prt3A_Frm_sf.Prt3A_Frm_Ln3_sf.Prt3A_Frm_Ln3_grp.Prt3A_Frm_Ln3_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.3G': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page2.Prt3A_sf.Prt3A_Frm_sf.Prt3A_Frm_Ln7_sf.Prt3A_Frm_Ln7_grp.Prt3A_Frm_Ln7_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.4A': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt4_sf.Prt4_Frm_sf.Prt4_Frm_Ln_sf.Prt4_Frm_Ln_grp.Prt4_Frm_Ln_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.5A': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt5_sf.Prt5_Frm_sf.Prt5_Frm_Ln1_sf.Prt5_Frm_Lnc_grp.Prt5_Frm_Lnc_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.5C': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt5_sf.Prt5_Frm_sf.Prt5_Frm_Ln3_sf.Prt5_Frm_Ln3_grp.Prt5_Frm_Ln3_grp_inpt1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.5D': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt5_sf.Prt5_Frm_sf.Prt5_Frm_Ln4_sf.Prt5_Frm_Ln4_grp.Prt5_Frm_Ln4_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.9931': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page4.Prt9_sf.Prt9_Frm_sf.Prt9_Frm_Ln9931_sf.Prt9_Frm_Ln9931_grp.Prt9_Frm_Ln9931_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.9932': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page4.Prt9_sf.Prt9_Frm_sf.Prt9_Frm_Ln9932_sf.Prt9_Frm_Ln9932_grp.Prt9_Frm_Ln9932_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.9933': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page4.Prt9_sf.Prt9_Frm_sf.Prt9_Frm_Ln9933_sf.Prt9_Frm_Ln9933_grp.Prt9_Frm_Ln9933_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T1.10100': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page3.Line1.Line_10100_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.12100': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page3.Line12100.Line_12100_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.13499': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page3.Line13500.Line13499.Line_13499_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.13500': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page3.Line13500.Line_13500_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{(z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'if((xfa.event.change == "(")||(xfa.event.change == ")"))\n\t{\n\txfa.host.messageBox(\'Enter a negative sign "-" to indicate a negative value. The value will be automatically formatted with brackets.\', "Information Message", 3, 0);\n\txfa.event.change = "";\n\t}\nelse\n\t{ CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\t}\n\n',
    ],
  },
  'T1.13899': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page3.Line13900.Line13899.Line_13899_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.13900': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page3.Line13900.Line_13900_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{(z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'if((xfa.event.change == "(")||(xfa.event.change == ")"))\n\t{\n\txfa.host.messageBox(\'Enter a negative sign "-" to indicate a negative value. The value will be automatically formatted with brackets.\', "Information Message", 3, 0);\n\txfa.event.change = "";\n\t}\nelse\n\t{ CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\t}\n\n',
    ],
  },
  'T1.15000': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page3.Line15000.Line_15000_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.31200': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line31200.Line_31200_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.31260': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line31260.Line_31260_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.43700': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line43700.Line_43700_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.44000': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line44000.Line_44000_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.45000': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line45000.Line_45000_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.45350': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line45350.Line_45350_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.45355': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line45355.Line_45355_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.45400': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line45400.Line_45400_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.45600': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line45600.Line_45600_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.45700': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line45700.Line_45700_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.46800': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line46900.Line46800.Line_46800_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.46900': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line46900.Line_46900_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.47555': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line47555.Line_47600_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.47556': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line47556.Line_47556_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.47900': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line47900.Line_47900_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.47600': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line47600.Line_47600_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T2125.8000': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page2.Prt3C_sf.Prt3C_Frm_sf.Prt3C_Frm_Ln8000_sf.Prt3C_Frm_Ln8000_grp.Prt3C_Frm_Ln8000_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.8299': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page2.Prt3C_sf.Prt3C_Frm_sf.Prt3C_Frm_Ln8299_sf.Prt3C_Frm_Ln8299_grp.Prt3C_Frm_Ln8299_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.8519': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt3D_sf.Prt3D_Frm_sf.Prt3D_Frm_Ln8519_sf.Prt3D_Frm_Ln8519_grp.Prt3D_Frm_Ln8519_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.8521': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt4_sf.Prt4_Frm_sf.Prt4_Frm_Ln8521_sf.Prt4_Frm_Ln8521_grp.Prt4_Frm_Ln8521_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.8690': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt4_sf.Prt4_Frm_sf.Prt4_Frm_Ln8690_sf.Prt4_Frm_Ln8690_grp.Prt4_Frm_Ln8690_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.8760': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt4_sf.Prt4_Frm_sf.Prt4_Frm_Ln8760_sf.Prt4_Frm_Ln8760_grp.Prt4_Frm_Ln8760_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.8810': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt4_sf.Prt4_Frm_sf.Prt4_Frm_Ln8810_sf.Prt4_Frm_Ln8810_grp.Prt4_Frm_Ln8810_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.8811': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt4_sf.Prt4_Frm_sf.Prt4_Frm_Ln8811_sf.Prt4_Frm_Ln8811_grp.Prt4_Frm_Ln8811_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.8860': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt4_sf.Prt4_Frm_sf.Prt4_Frm_Ln8860_sf.Prt4_Frm_Ln8860_grp.Prt4_Frm_Ln8860_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.8910': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt4_sf.Prt4_Frm_sf.Prt4_Frm_Ln8910_sf.Prt4_Frm_Ln8910_grp.Prt4_Frm_Ln8910_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.9220': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt4_sf.Prt4_Frm_sf.Prt4_Frm_Ln9220_sf.Prt4_Frm_Ln9220_grp.Prt4_Frm_Ln9220_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.9368': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt4_sf.Prt4_Frm_sf.Prt4_Frm_Ln9368_sf.Prt4_Frm_Ln9368_grp.Prt4_Frm_Ln9368_grp_inpt1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.9369': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt4_sf.Prt4_Frm_sf.Prt4_Frm_Ln9369_sf.Prt4_Frm_Ln9369_grp.Prt4_Frm_Ln9369_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'T2125.9946': {
    sourceId: 'cra-t2125-2025-fillable',
    path: 'form1.Page3.Prt5_sf.Prt5_Frm_sf.Prt5_Frm_Ln9946_sf.Prt5_Frm_Ln9946_grp.Prt5_Frm_Ln9946_grp_inpt',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeFloat(this, 10, 2, false, CoreFunctions.FLOAT_CURRENCY);\n\n',
    ],
  },
  'ON428.58040': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Part_B.Line9.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T2204.1': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line1_sf.Field_L1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.2': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line2_sf.Field_L2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.3': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line3_sf.Field_L3',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.4': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line4_sf.Field_L4',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.5': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line5_sf.Field_L5',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.6': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line6_sf.Field1_L6',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.7': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line7_sf.Field_L7',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.8': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line8_sf.Field_L8',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.9': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line9_sf.Field_L9',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.10': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line10.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T2204.12': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Lin12_sf.Field_L10',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.13': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line13.Field_L11',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.14': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line14.Field_L12',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.15': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line15.Field_L12',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'T2204.16': {
    sourceId: 'cra-t2204-2025-fillable',
    path: 'form1.Page1.Line16.Field_L12',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{sz,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n\n',
    ],
  },
  'ON428-A.1': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.Adjusted_net_income.Line1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428-A.2': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.Adjusted_net_income.Line2.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428-A.3': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.Adjusted_net_income.Line3.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428-A.5': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.Adjusted_net_income.Line5.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428-A.6': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.Adjusted_net_income.Line6.Numeric_Negative_Parenthesis_Separator.NumWithoutCurrency',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{(z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      '\nCoreFunctions.validateKeystrokeFloat(this, 9, 2, false, CoreFunctions.FLOAT_NEG_PAREN);\n\n\t\n\n',
    ],
  },
  'ON428-A.7': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.Adjusted_net_income.Line7.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n',
    ],
  },
  'ON428-A.8': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.Adjusted_net_income.Line8.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n',
    ],
  },
  'ON428-A.9': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.Adjusted_net_income.Line9.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      '\nCoreFunctions.validateKeystrokeCurrency(this, 9, false);\n',
    ],
  },
  'ON428-A.10': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.Adjusted_net_income.Line10.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428-A.11': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.Adjusted_net_income.Line11.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428-A.12': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.Adjusted_net_income.Line12.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n',
    ],
  },
  'ON428-A.13': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.Adjusted_net_income.Line13.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428-A.14': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.PartA.Line14.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428-A.15': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.PartA.Line15.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428-A.16': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.PartA.Line16.Amount_ReadOnly',
    inputPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [],
  },
  'ON428-A.17': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.PartA.Line17.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n',
    ],
  },
  'ON428-A.19': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.PartA.Line19.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n',
    ],
  },
  'ON428-A.20': {
    sourceId: 'cra-5006-a-2025-fillable',
    path: 'form1.Page1.PartA.Line20.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'Schedule6.1': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page2.PartA.Chart.Line1.Amount1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.2': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page2.PartA.Chart.Line2.Amount1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.3': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page2.PartA.Chart.Line3.Amount1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.4': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page2.PartA.Chart.line4.Amount1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.5': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page2.PartA.Chart.Line5_Sub.Amount1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.6': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page2.PartA.Line6.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.7': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page3.PartB.Chart.Line7.Amount1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'if((xfa.event.change == "(")||(xfa.event.change == ")"))\n{\nxfa.host.messageBox("Do not enter brackets, use a negative sign. The value will be automatically formatted with brackets.", "Information Message", 3,0);\nxfa.event.change = "";\n}\nelse\n{\nCoreFunctions.validateKeystrokeCurrency(this, 9, false);\n}\n\n\n',
    ],
  },
  'Schedule6.8': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page3.PartB.Chart.Line8.Amount1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.9': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page3.PartB.Chart.Line9.Amount1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.10': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page3.PartB.Chart.Line10.Amount1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'if((xfa.event.change == "(")||(xfa.event.change == ")"))\n{\nxfa.host.messageBox("Do not enter brackets, use a negative sign. The value will be automatically formatted with brackets.", "Information Message", 3,0);\nxfa.event.change = "";\n}\nelse\n{\nCoreFunctions.validateKeystrokeCurrency(this, 9, false);\n}\n\n\n',
    ],
  },
  'Schedule6.11': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page3.PartB.Chart.Line11.Amount1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.12': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page3.PartB.Chart.Line12.Amount1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'Schedule6.13': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page3.PartB.Line13.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.15': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page3.PartB.Line15.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.16': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page4.Step2.Line16.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.17': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page4.Step2.Line17.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.18': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page4.Step2.Line18.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.20': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page4.Step2.Line20.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.21': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page4.Step2.Line21.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.22': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page4.Step2.Line22.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.23': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page4.Step2.Line23.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.24': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page4.Step2.Line24.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.25': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page4.Step2.Line25.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.27': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page4.Step2.Line27.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule6.28': {
    sourceId: 'cra-5000-s6-2025-fillable',
    path: 'form1.Page4.Step2.Line28.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.45300': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line45300.Line_45300_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.62140': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page4.Line85.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.23600': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page4.Line23600.Line_23600_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line1': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line2': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line2.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line3': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line3.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line4': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line4.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line5': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line5.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line6': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line6.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line7': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line7.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line8': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line8.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line9': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line9.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line10': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line10.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line11': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line11.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line12': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line12.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line13': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line13.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line14': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line14.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line15': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line15.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line16': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line16.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line17': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line17.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line18': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line18.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line19': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line19.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line20': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line20.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line21': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line21.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line22': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line22.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line23': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line23.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line24': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page4.Part3.Line24.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line25': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page5.Part3_Cont.Line25.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line26': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page5.Part3_Cont.Line26.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line27': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page5.Part3_Cont.Line27.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line28': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page5.Part3_Cont.Line28.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line29': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page5.Part3_Cont.Line29.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line30': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page5.Part3_Cont.Line30.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line31': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page5.Part3_Cont.Line31.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line32': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page5.Part3_Cont.Line32.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line33': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page5.Part3_Cont.Line33.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line34': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page5.Part3_Cont.Line34.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line35': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page5.Part3_Cont.Line35.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line36': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page5.Part3_Cont.Line36.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line37': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part3.Line37.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line38': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part3.Line38.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line39': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part3.Line39.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line40': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part3.Line40.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line41': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part3.Line41.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line42': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part3.Line42.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line43': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part3.Line43.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line44': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part3.Line44.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line45': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part3.Line45.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line46': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part3.Line46.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line47': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part3.Line47.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part3.line48': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part3.Line48.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line1': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part4.Line1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line2': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part4.Line2.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line3': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part4.Line3.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line4': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part4.Line4.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line5': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part4.Line5.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line6': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part4.Line6.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line7': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part4.Line7.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line8': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part4.Line8.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line9': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page6.Part4.Line9.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line10': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part4.Line10.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line11': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part4.Line11.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line12': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part4.Line12.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line13': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part4.Line13.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line14': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part4.Line14.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line15': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part4.Line15.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line16': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part4.Line16.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part4.line17': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part4.Line17.amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.22200': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page4.Line22200.Line_22200_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.22215': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page4.Line22215.Line_22215_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.30800': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line30800.Line_30800_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.31000': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line31000.Line_31000_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.42100': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.Step6.Line42100.Line_42100_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.42120': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.Step6.Line42120.Line_42120_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.42200': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page7.Step6.Line42200.Line_42200_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.44800': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line44800.Line_44800_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.33099': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line33099.Line_33099_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.108': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line114.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.109': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line115.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.110': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line116.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.33200': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page6.PartB.Line33200.Line_33200_Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.45200': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page8.Step6-Continued.Line45200.Line_45200_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.58689': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Medical-Expenses.Line36.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.39': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Medical-Expenses.Line39.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.40': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Medical-Expenses.Line40.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.41': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Medical-Expenses.Line41.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'ON428.58769': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line43.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'MedicalSupplement.6': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page9.Line45200.Line6.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'MedicalSupplement.8': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page9.Line45200.Line8.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'MedicalSupplement.11': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page9.Line45200.Line11.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'MedicalSupplement.13': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page9.Line45200.Line13.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'MedicalSupplement.14': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page9.Line45200.Line14.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'MedicalSupplement.15': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page9.Line45200.Line15.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'MedicalSupplement.16': {
    sourceId: 'cra-5000-d1-2025-fillable',
    path: 'form1.Page9.Line45200.Line16.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, true);\n\n',
    ],
  },
  'T1.21200': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page4.Line21200.Line_21200_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.23300': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page4.Line23300.Line_23300_Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.26000': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page5.Step4.Line26000.Line_26000_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'T1.25200': {
    sourceId: 'cra-5006-r-2025-fillable',
    path: 'form1.Page5.Step4.Line25200.Line_25200_Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.58240': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Part_B.CPP-QPP.Line19.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.58280': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Part_B.CPP-QPP.Line20.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.58300': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page1.Part_B.Employment-Insurance.Line21.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'ON428.58800': {
    sourceId: 'cra-5006-c-2025-fillable',
    path: 'form1.Page2.Line44.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.99}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line1': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part5.Line1.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line2': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part5.Line2.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line3': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part5.Line3.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line4': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part5.Line4.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line5': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part5.Line5.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line6': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part5.Line6.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line7': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part5.Line7.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line8': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part5.Line8.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line9': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part5.Line9.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line10': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page7.Part5.Line10.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line11': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line11.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line12': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line12.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line13': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line13.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line14': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line14.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line15': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line15.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line16': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line16.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line17': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line17.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line18': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line18.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line19': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line19.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line20': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line20.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line21': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line21.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line22': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line22.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line23': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line23.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line24': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line24.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line25': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line25.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line26': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line26.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line27': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line27.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line28': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line28.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line29': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line29.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line30': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line30.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line31': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line31.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line32': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line32.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line33': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line33.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line34': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line34.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line35': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line35.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line36': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line36.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line37': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line37.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line38': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line38.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line39': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line39.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line40': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line40.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line41': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page8.Part5.Line41.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line42': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line42.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line43': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line43.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line44': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line44.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line45': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line45.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line46': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line46.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line47': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line47.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line48': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line48.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line49': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line49.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line50': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line50.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line51': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line51.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line52': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line52.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line53': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line53.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line54': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line54.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line55': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line55.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line56': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line56.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line57': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page9.Part5_Cont.Line57.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line58': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line58.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line59': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line59.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line60': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line60.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line61': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line61.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line62': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line62.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line63': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line63.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line64': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line64.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line65': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line65.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line66': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line66.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line67': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line67.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line68': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line68.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line69': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line69.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line70': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line70.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line71': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line71.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line72': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line72.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line73': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line73.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line74': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line74.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line75': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line75.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line76': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line76.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line77': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page10.Part5_Cont.Line77.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line78': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page11.Part5-Cont.Line79.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line79': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page11.Part5-Cont.Line80.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line80': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page11.Part5-Cont.Line81.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line81': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page11.Part5-Cont.Line82.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line82': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page11.Part5-Cont.Line83.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line83': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page11.Part5-Cont.Line84.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line84': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page11.Part5-Cont.Line85.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line85': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page11.Part5-Cont.Line86.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line86': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page11.Part5-Cont.Line87.Amount2',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line87': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page11.Part5-Cont.Line88.Amount1',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{s z,zzz,zzz,zzz,zz9.99}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
  'Schedule8.part5.line88': {
    sourceId: 'cra-5000-s8-2025-fillable',
    path: 'form1.Page11.Part5-Cont.Line89.Amount',
    inputPattern: 'num{zzzzzzzzzzzz9.zz}',
    displayPattern: 'num{(s z,zzz,zzz,zzz,zz9.99)}',
    changeScripts: [
      'CoreFunctions.validateKeystrokeCurrency(this, 9, false);\n\n',
    ],
  },
});
