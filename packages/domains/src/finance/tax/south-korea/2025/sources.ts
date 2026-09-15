import {
  deepFreeze,
  FinanceTaxAuthorityReferenceSchema,
} from '@emdo/contracts';

/**
 * Official NTS sources reviewed for the 2025 attributable-year slice.  The
 * hashes cover the bytes fetched on 2026-09-14; direct downloads are retained
 * as provenance even though this bounded package does not ship the large NTS
 * PDF/ZIP captures. NTS publication-page responses can include a changing
 * read counter; the recorded page hashes bind the response observed at the
 * stated retrieval timestamp.
 */
const retrievedAt = '2026-09-14T05:16:28.000Z';
const extensionRetrievedAt = '2026-09-14T15:07:12.000Z';

export const SOUTH_KOREA_2025_SOURCES = deepFreeze(
  [
    {
      id: 'nts-kr-2025-year-end-settlement-guide',
      authority: 'National Tax Service, Republic of Korea',
      title: '2025 Year-end Tax Settlement Guide for Withholding Agents',
      url: 'https://d.nts.go.kr/comm/nttFileDownload.do?fileKey=88c482e8d69eb1653515871654a4ab42',
      locator:
        '2025 귀속 연말정산 신고안내: 근로소득자의 과세표준 및 세액계산; pp. 8, 94-95, 103-120, 148-162',
      retrievedAt,
      documentHash:
        'e25fe22ef388f12a48cdc39bc23ec762b2941f780a4e7ca0d66925a47594902e',
    },
    {
      id: 'nts-kr-2025-global-income-guide',
      authority: 'National Tax Service, Republic of Korea',
      title:
        'Individual Income Tax and Benefit Guide for Foreigners 2026 (Tax return for 2025)',
      url: 'https://www.nts.go.kr/comm/nttFileDownload.do?fileKey=f3672a0a56ff88d41548b4cc5fc41a3b',
      locator:
        '2025년 귀속 종합소득세 신고안내: 2025 attribution, global-income tax rates pp. 17-18, wage-income calculation pp. 227-228',
      retrievedAt,
      documentHash:
        '2144b60c037f91cf902b38b0a36035e3a8a52354ad4e4cc30d48c1cbec3fc5f6',
    },
    {
      id: 'nts-kr-2025-return-publication-page',
      authority: 'National Tax Service, Republic of Korea',
      title:
        'Individual Income Tax and Benefit Guide for Foreigners 2026 publication notice',
      url: 'https://www.nts.go.kr/english/na/ntt/selectNttInfo.do?mi=10788&nttSn=1350804',
      locator:
        'NTS News, published 2026-04-30: “Individual Income Tax and Benefit Guide for Foreigners 2026 (Tax return for 2025)”',
      retrievedAt,
      documentHash:
        '5e925973003d1089475ba24ee709f995406a61d7c91410eee47d334913430516',
    },
    {
      id: 'nts-kr-2025-year-end-publication-page',
      authority: 'National Tax Service, Republic of Korea',
      title: '2025 attributable-year year-end tax settlement landing page',
      url: 'https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=238938&mi=6645',
      locator:
        'NTS year-end tax settlement landing page: “2025년 귀속 연말정산 종합 안내” and links to the 2025 guide, forms and calculation examples',
      retrievedAt,
      documentHash:
        '0f4579bae22469eb9345590d2709d60a558f2e097028cd94dcc863e10db2b4a9',
    },
    {
      id: 'nts-kr-2025-local-income-tax-guide',
      authority: 'National Tax Service, Republic of Korea',
      title: 'Withholding tax overview: local income tax',
      url: 'https://g.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7701&mi=2413',
      locator:
        'NTS withholding overview: local income tax is 10% of the related individual or corporate income tax; employment withholding is payable to the workplace local authority',
      retrievedAt: extensionRetrievedAt,
      documentHash:
        '30be0384766a21a020dd477baf87b54cd45ab42dfbe9fea59dde01ca73a088bf',
    },
    {
      id: 'nts-kr-2025-global-income-overview',
      authority: 'National Tax Service, Republic of Korea',
      title:
        'Global income tax overview and bookkeeping / expense-rate guidance',
      url: 'https://nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7669&mi=2224',
      locator:
        'NTS individual income-tax overview: 2025 business bookkeeping thresholds, simplified and standard expense-rate boundaries',
      retrievedAt: extensionRetrievedAt,
      documentHash:
        '65691003946457a575d6e553db1b67ceaa2e31f5ab42f4d0a3ae239dccfdb76f',
    },
    {
      id: 'nts-kr-2025-corporate-income-overview',
      authority: 'National Tax Service, Republic of Korea',
      title: 'Profit-making corporation income-tax filing overview',
      url: 'https://b.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7979&mi=6553',
      locator:
        'NTS profit-making corporation guide: taxable-income bridge and 2025 corporate rates of 9%, 19%, 21% and 24%',
      retrievedAt: extensionRetrievedAt,
      documentHash:
        'add895e49ebacad4958336e29ec8664d0b93edf74452afab1a98bfc9944029cf',
    },
    {
      id: 'nts-kr-2025-global-form40-1-page',
      authority: 'National Tax Service, Republic of Korea',
      title:
        'Income Tax Act Form 40(1) global income tax return publication page',
      url: 'https://nts.go.kr/nts/na/ntt/selectNttInfo.do?mi=2240&nttSn=1002353',
      locator:
        'NTS major forms publication dated 2024-12-31: Form 40(1), global income tax and rural special tax assessment and payment statement',
      retrievedAt: extensionRetrievedAt,
      documentHash:
        '3a0af26269719cfbfbffaf0e3c84558eb37d68fa85889f748bcb2a4846781715',
    },
    {
      id: 'nts-kr-2025-global-form40-1',
      authority: 'National Tax Service, Republic of Korea',
      title:
        'Income Tax Act Form 40(1) global income tax and rural special tax assessment and payment statement',
      url: 'https://www.nts.go.kr/comm/nttFileDownload.do?fileKey=91cc4e65db49d2dd55f4b01214dc744a',
      locator:
        'Official HWP attachment to the Form 40(1) publication page; 2025 attributable-year general global-income return form',
      retrievedAt: extensionRetrievedAt,
      documentHash:
        '2fb6f557a510b3db861348cf84af5dbba25a01c07a0a2419965055b55b93ba33',
    },
    {
      id: 'nts-kr-2025-corporate-form1',
      authority: 'National Tax Service, Republic of Korea',
      title:
        'Corporate Tax Act Form 1 corporate income-tax assessment and tax statement',
      url: 'https://taxlaw.nts.go.kr/downloadFile.do?fleId=701000000001012513&fleSn=1',
      locator:
        'Taxlaw NTS historical Form 1 revision effective 2025-01-01: 법인세 과세표준 및 세액신고서 [법인세법 시행규칙 별지 제1호서식]',
      retrievedAt: extensionRetrievedAt,
      documentHash:
        'e123f7d44aec869a430bda8a2d2670b690cd93bab231f1d92ec2d60d2faff7b2',
    },
  ].map((source) => FinanceTaxAuthorityReferenceSchema.parse(source)),
);

/**
 * The NTS publication evidence deliberately records the attributable income
 * year separately from the publication/filing year.  The latest complete NTS
 * guide found at review time is the 2025 return guide published 2026-04-30;
 * therefore this package belongs under /2025, not /2026.
 */
export const SOUTH_KOREA_2025_PUBLICATION_EVIDENCE = deepFreeze({
  selectedYear: 2025,
  latestFullyPublishedReturnYear: 2025,
  publicationDate: '2026-04-30',
  filingWindow: '2026-05-01 through 2026-06-01',
  returnGuideSourceId: 'nts-kr-2025-return-publication-page',
  returnGuideUrl:
    'https://www.nts.go.kr/english/na/ntt/selectNttInfo.do?mi=10788&nttSn=1350804',
  yearEndSourceId: 'nts-kr-2025-year-end-settlement-guide',
  yearEndLandingUrl:
    'https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=238938&mi=6645',
  basis:
    'NTS identifies the 2026 guide as the tax return for 2025 and publishes the 2025 attributable-year year-end settlement materials; no 2026 attributable-year annual return guide was published at review time.',
});

export const SOUTH_KOREA_2025_SOURCE_VERSION = deepFreeze({
  packageVersion: '2025.1-national-employment-working-papers.1',
  sourceReviewDate: '2026-09-14',
  sourceIds: SOUTH_KOREA_2025_SOURCES.map((source) => source.id),
});
