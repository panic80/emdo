import {
  deepFreeze,
  FinanceTaxAuthorityReferenceSchema,
} from '@emdo/contracts';

/**
 * Primary NTA captures used by this package.  The HTML captures preserve the
 * bytes returned by the NTA (including their Shift-JIS encoding); hashes are
 * over those captured bytes.  A source URL is evidence, never an activation
 * or filing authorization.
 */
export const JAPAN_2025_SOURCES = deepFreeze(
  [
    {
      id: 'nta-jp-r07-forms',
      authority: 'National Tax Agency of Japan (国税庁)',
      title:
        '令和7年分の所得税及び復興特別所得税の確定申告書等の様式・手引き等',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/syotoku/r07.htm',
      retrievedAt: '2026-09-14T05:18:52Z',
      documentHash:
        '87c03170361b157ae382ff2ca7462dc98d7b0802934b295477bdf2abb22cdacc',
      locator:
        '2025 (令和7年分) return forms index; Form 1/2 is listed as 申告書第一表・第二表',
    },
    {
      id: 'nta-jp-r07-form-1-2',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '申告書第一表・第二表（令和7年分以降用）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r07/01.pdf',
      retrievedAt: '2026-09-14T05:18:52Z',
      documentHash:
        '833e641919fbc1eb22605a1989c6514eabb742334528d04dd90736ae90afce46',
      locator:
        'Official two-page Form 1 and Form 2 layout; salary, deductions, national tax, surtax and withholding fields',
    },
    {
      id: 'nta-jp-r07-identification',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '手順1 住所、氏名などを記入する（令和7年分）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order1/3-1_01.htm',
      retrievedAt: '2026-09-14T05:52:52Z',
      documentHash:
        'e0ac6c9a1dfdc126d9159e452d2b55a0243a6f32a9fbbbbfbdc090f790ad9563',
      locator:
        '2025 NTA First/Second Form identity instructions: tax-office jurisdiction, filing date, address, My Number, birth date, name, gender, occupation, household head, phone and return-type checkboxes',
    },
    {
      id: 'nta-jp-r07-white-business-general',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '収支内訳書（一般用）（令和5年分以降用）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r07/05.pdf',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        '686ecbd849ebe07b11a90d10421561669188e1cfd48b18962bf1be06965a0f24',
      locator:
        'Official general white-return business-income statement; revenue, cost of sales, expense categories and business-income total fields',
    },
    {
      id: 'nta-jp-r07-white-business-general-guide',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '令和7年分収支内訳書（一般用）の書き方',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/034.pdf',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        '5ac5dabb0eff09479009347c825edffbed28ec5d9a746afd8fc14fcc65a15aba',
      locator:
        '2025 instructions for the general white-return statement and business-income schedule',
    },
    {
      id: 'nta-jp-r07-white-business-general-handbook',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '令和7年分白色申告者の決算の手引き（一般用）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/kojin_jigyo/kichou09.pdf',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        '5e6fde36f22beb1414314fd71cce5929eb24dfc0fa1330abfe6e423d068cca30',
      locator:
        '2025 white-return general business closing handbook and recording guidance',
    },
    {
      id: 'nta-jp-r07-blue-business-general',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '所得税青色申告決算書（一般用）（令和5年分以降用）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r07/10.pdf',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        'c3cd9d17c0174972a19c5b8174ad01ac685f4ed2dda9d3e903e6fd315bf5f4c3',
      locator:
        'Official general blue-return business-income statement and balance-sheet pages',
    },
    {
      id: 'nta-jp-r07-blue-business-general-guide',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '令和7年分青色申告決算書（一般用）の書き方',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/037.pdf',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        '77c8ad203bbd04efcacf42c4c8c95a6a098b80784e51df66347812948b578900',
      locator:
        '2025 instructions for general blue-return business statement and balance-sheet fields',
    },
    {
      id: 'nta-jp-r07-blue-business-general-handbook',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '令和7年分青色申告の決算の手引き（一般用）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/025.pdf',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        'd688dd73e82a13b5b8f4d8d559f16cc82da948f5a249d9a2ac75361dc855f82c',
      locator:
        '2025 blue-return general business closing handbook and account treatment',
    },
    {
      id: 'nta-jp-r07-business-bookkeeping',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '帳簿の記帳のしかた（事業所得者用）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/kojin_jigyo/kichou03.pdf',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        '050d458b38be96f3256d984bd75c0673d0aa7b2a1d3e92333295a649544254e1',
      locator:
        'NTA bookkeeping guidance for individual business-income source records',
    },
    {
      id: 'nta-jp-r07-corporation-forms',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '法人税等各種別表関係（令和7年4月1日以後終了事業年度等分）',
      url: 'https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/01.htm',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        '4920e32cb5a4467b9e9b4085067a10e9cb3db66aab0020c7b60c619ee1af13f3',
      locator:
        '2025 corporate return form index with domestic corporation Blue/White Form 1, attached schedules and instructions',
    },
    {
      id: 'nta-jp-r07-corporation-form-1-blue',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '別表一 各事業年度の所得に係る申告書（内国法人・青色申告）',
      url: 'https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/pdf/01-01-a.pdf',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        '792192289d9b4848f2b0aa5886a93840858d88090b138cad014fc3b11a9fc2f2',
      locator:
        'Official domestic corporation blue-return Form 1 for fiscal years ending on or after 1 April 2025',
    },
    {
      id: 'nta-jp-r07-corporation-form-1-white',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '別表一 各事業年度の所得に係る申告書（内国法人・白色申告）',
      url: 'https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/pdf/01-01-s.pdf',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        'dcd39af5c697b406f031a6216459f6a4bd5343550780eacc9d938f5b9e2402b1',
      locator:
        'Official domestic corporation white-return Form 1 for fiscal years ending on or after 1 April 2025',
    },
    {
      id: 'nta-jp-r07-corporation-form-1-instructions',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '法人税申告書別表一の記載要領（令和7年4月1日以後終了事業年度分）',
      url: 'https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/pdf/01-01-ki.pdf',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        '5aaad8c5bd06d4ba82e02fbca7d5330611b95e837a96bbe00ed3661f7285506a',
      locator: 'Official Form 1 completion instructions and dependency notes',
    },
    {
      id: 'nta-jp-r07-corporation-guide',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '令和7年版 法人税のあらましと申告の手引',
      url: 'https://www.nta.go.jp/publication/pamph/hojin/aramashi2025/pdf/01.pdf',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        'f24ae20d01dbb726c428281adce7b839c4cfbdc92a9e6e75c2bbaf83de397f2e',
      locator:
        '2025 corporate tax return process, Form 1, schedules, local corporate tax and special defense corporate tax overview',
    },
    {
      id: 'nta-jp-r07-corporation-small-company-criteria',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '中小法人の判定について（令和7年4月1日以後終了事業年度分）',
      url: 'https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/pdf/f02-01.pdf',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        '8ca978e6d7feb448c4b49bffc471f6f956e21746412be4bc9fe03058ee8c3535',
      locator:
        'Official NTA small-company classification dependency for corporate tax rates and schedules',
    },
    {
      id: 'nta-jp-r07-corporation-return-overview',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '法人税・地方法人税及び防衛特別法人税の申告',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tokushu/hojin.htm',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        '700138cae1f347c2be03b380ba74007e704ceb81fe2a62d547e3559d4b851d55',
      locator:
        'NTA corporate filing overview and tax categories; used for standalone corporation scope gates',
    },
    {
      id: 'nta-jp-r07-local-tax-guidance',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '手順6 住民税、事業税に関する事項を記入する（令和7年分）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order6/3-6_01.htm',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        '7dde644943c1b544005df11c9f2bee27f5fc506b204a9bc019643f6de63b5e29',
      locator:
        'NTA states local authorities calculate and notify inhabitant/business tax from return information; municipality/prefecture-specific inquiries required',
    },
    {
      id: 'nta-jp-r07-local-tax-input',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '住民税に関する事項の入力（令和7年分）',
      url: 'https://www.keisan.nta.go.jp/r7yokuaru_sp/socat1/scid1345.html',
      retrievedAt: '2026-09-14T06:13:05Z',
      documentHash:
        '0f05488731cd112c809e296715200d67fc9803ba6b7ca7e7c1fafa7f439a14c5',
      locator:
        'NTA return-creation guidance lists local-tax collection choices and minor-dependant/retirement-relative details',
    },
    {
      id: 'nta-jp-r07-salary-income',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '手順2 給与所得の計算（令和7年分）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order2/3-2_06.htm',
      retrievedAt: '2026-09-14T05:18:52Z',
      documentHash:
        'd693641fc03301440ac9f3cdc9f0b12c73bfd9484ea5ab293713a79998f5f38c',
      locator:
        'Lines 13-29: salary-income table, 1,000-yen intermediate truncation and 1-yen fraction rule',
    },
    {
      id: 'nta-jp-r07-social-insurance',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '手順3 社会保険料控除（令和7年分）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order3/3-3_10.htm',
      retrievedAt: '2026-09-14T05:18:52Z',
      documentHash:
        '29971a01041a3bbc5fca9d81805c0e4aba926a44dd29a0ffb9377fb946d19dcd',
      locator:
        'Lines 6-23: eligible social-insurance premiums and First/Second Form line 10 handling',
    },
    {
      id: 'nta-jp-r07-basic-deduction',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '手順3 基礎控除（令和7年分）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order3/3-3_21.htm',
      retrievedAt: '2026-09-14T05:18:52Z',
      documentHash:
        '1460dc8a95889697b03f904aa7c6f4c3d20f1d49c3fcd9c61ed3ab7af2abd56e',
      locator:
        'Lines 8-22: resident basic-deduction bands from 950,000 yen through no deduction',
    },
    {
      id: 'nta-jp-r07-national-tax',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '手順4 課税所得金額に対する税額の速算表（令和7年分）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order4/3-4_26.htm',
      retrievedAt: '2026-09-14T05:18:52Z',
      documentHash:
        '6a712e5523ac705acb475278626dbd82d7734707138cc1dd8aa02a2b9c451319',
      locator:
        'Lines 6-35: taxable-income 1,000-yen truncation and seven national income-tax brackets',
    },
    {
      id: 'nta-jp-r07-reconstruction-surtax',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '手順4 復興特別所得税額（令和7年分）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order4/3-4_45.htm',
      retrievedAt: '2026-09-14T05:18:52Z',
      documentHash:
        '96323f99c658f083a8cb9cf37eb4327b7e13cbf1e96d6dce369d8a11944586e8',
      locator:
        'Lines 6-20: 2.1% of base income tax and truncation below one yen',
    },
    {
      id: 'nta-jp-r07-total-tax',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '手順4 所得税及び復興特別所得税の額（令和7年分）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order4/3-4_41_1.htm',
      retrievedAt: '2026-09-14T05:18:52Z',
      documentHash:
        '734c709937d6c9b80d63fe8e469e79f5af285c3d011255247c073743ce0634f8',
      locator: 'Lines 4-7: combined base income tax and reconstruction surtax',
    },
    {
      id: 'nta-jp-r07-withholding',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '手順4 源泉徴収税額（令和7年分）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order4/3-4_38.htm',
      retrievedAt: '2026-09-14T05:18:52Z',
      documentHash:
        '4dbccb03bdceffd16d15cc94dbdfa776fd423ba8838ebce978ea442e3684f724',
      locator:
        'Lines 4-20: withheld income-tax-and-reconstruction amount on First Form line 49 and Second Form income details',
    },
    {
      id: 'nta-jp-r07-assessment',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '手順4 申告納税額（令和7年分）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order4/3-4_39.htm',
      retrievedAt: '2026-09-14T05:18:52Z',
      documentHash:
        '8584f6d0de995958d38d2ba816036d7b9b374df705e3bfc2406980f192779073',
      locator:
        'Lines 4-10: positive assessment truncation below 100 yen and signed negative refund amount',
    },
    {
      id: 'nta-jp-r07-third-period',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '手順4 第3期分の税額（令和7年分）',
      url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order4/3-4_41.htm',
      retrievedAt: '2026-09-14T05:18:52Z',
      documentHash:
        '9403c59e427f717239f99460a4f4c4cd24e4152d805aee14981b24b5a4f39f0c',
      locator:
        'Lines 3-13: third-period amount after estimated payments; positive amount truncated below 100 yen',
    },
    {
      id: 'nta-jp-r07-high-income',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: 'No.2270 特定の基準所得金額の課税の特例',
      url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2270.htm',
      retrievedAt: '2026-09-14T05:35:32Z',
      documentHash:
        '09a5a71f37ed185407e31a7d30d0835adc91ee20870972b6ec0ff6b1d8bb8fef',
      locator:
        'Lines 65-72 and 97: the 330-million-yen threshold, 22.5% comparison, and application from 2025 (令和7年分)',
    },
    {
      id: 'nta-jp-2025-tax-reform',
      authority: 'National Tax Agency of Japan (国税庁)',
      title: '令和7年度税制改正による基礎控除・給与所得控除の見直し',
      url: 'https://www.nta.go.jp/users/gensen/2025kiso/index.htm',
      retrievedAt: '2026-09-14T05:18:52Z',
      documentHash:
        '5b1c39edc19e060ef7357b47e9e33873feece4cff13d74b709118c6628f950f1',
      locator:
        'Lines 27-48: 2025 resident basic-deduction amounts and 650,000-yen minimum salary deduction',
    },
  ].map((source) => FinanceTaxAuthorityReferenceSchema.parse(source)),
);

export type Japan2025SourceId = (typeof JAPAN_2025_SOURCES)[number]['id'];
