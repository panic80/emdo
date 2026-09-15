import {
  deepFreeze,
  FinanceTaxAuthorityReferenceSchema,
} from '@emdo/contracts';
export const NY_2025_SOURCES = deepFreeze(
  [
    {
      id: 'ny-2025-instructions',
      authority: 'New York State Department of Taxation and Finance',
      title: '2025 IT-201 instructions',
      url: 'https://www.tax.ny.gov/forms/html-instructions/2025/it/it201i-2025.htm',
      locator:
        'IT-201 lines19\u201380; single tax tables, resident/local tax instructions',
      documentHash:
        '97f0ba99c2099216e2ec1f6b0c09ecaaa6ddf8abebc25093124c8d9155c4a7e5',
      retrievedAt: '2026-09-14T05:20:32.127587Z',
    },
    {
      id: 'ny-2025-tables',
      authority: 'New York State Department of Taxation and Finance',
      title: '2025 IT-201 tables',
      url: 'https://www.tax.ny.gov/pit/file/tax-tables/it201i-2025.htm',
      locator:
        'IT-201 lines19\u201380; single tax tables, resident/local tax instructions',
      documentHash:
        '82eebae8f594fe8ff0bb2f3eb811bbcb51f0cca39718b58f4c6a6dc5cdb33072',
      retrievedAt: '2026-09-14T05:20:32.130823Z',
    },
    {
      id: 'ny-2025-it201',
      authority: 'New York State Department of Taxation and Finance',
      title: '2025 IT-201 it201',
      url: 'https://www.tax.ny.gov/pdf/2025/inc/it201_2025_fill_in.pdf',
      locator:
        'IT-201 lines19\u201380; single tax tables, resident/local tax instructions',
      documentHash:
        'cfe63039ffa4374f5fff67b7d2b37c5bdb802211fac55c69386e8f15c20d3e08',
      retrievedAt: '2026-09-14T05:20:32.838915Z',
    },
    {
      id: 'ny-2025-it215',
      authority: 'New York State Department of Taxation and Finance',
      title: '2025 it215',
      url: 'https://www.tax.ny.gov/pdf/2025/inc/it215_2025_fill_in.pdf',
      locator: 'Full-year resident single credit computation and eligibility',
      documentHash:
        'a78af9f80c94aa6da2e27f3cbb366582cf65f538d67b070d7d5e0cfe34e787ee',
      retrievedAt: '2026-09-14T05:31:18.076351Z',
    },
    {
      id: 'ny-2025-it215i',
      authority: 'New York State Department of Taxation and Finance',
      title: '2025 it215i',
      url: 'https://www.tax.ny.gov/pdf/2025/inc/it215i_2025.pdf',
      locator: 'Full-year resident single credit computation and eligibility',
      documentHash:
        '50a119620fd3bf8e6e73386a08a078c7e818db8fc50402dbc1b182d3e53193a3',
      retrievedAt: '2026-09-14T05:31:18.524366Z',
    },
    {
      id: 'ny-2025-it270',
      authority: 'New York State Department of Taxation and Finance',
      title: '2025 it270',
      url: 'https://www.tax.ny.gov/pdf/2025/inc/it270_2025_fill_in.pdf',
      locator: 'Full-year resident single credit computation and eligibility',
      documentHash:
        '7a97ec1670f6ecb6965ab9d15261974c51096c90c75d76ba1b4ca38d4b1fe860',
      retrievedAt: '2026-09-14T05:31:19.385112Z',
    },
    {
      id: 'ny-2025-it270i',
      authority: 'New York State Department of Taxation and Finance',
      title: '2025 it270i',
      url: 'https://www.tax.ny.gov/pdf/2025/inc/it270i_2025.pdf',
      locator: 'Full-year resident single credit computation and eligibility',
      documentHash:
        '1f8f971a8a59ce9be9342d39ac9912ed53d8c2a769526299ca0c2cc55b8a0868',
      retrievedAt: '2026-09-14T05:31:19.846854Z',
    },
    {
      id: 'ny-2025-it2105-9',
      authority: 'New York State Department of Taxation and Finance',
      title: '2025 it2105-9',
      url: 'https://www.tax.ny.gov/pdf/2025/inc/it2105_9_2025_fill_in.pdf',
      locator: 'Ordinary individual calculation and wage record instructions',
      documentHash:
        '5e86a7ea75f6f66a3019c03492fdd4836f95fb754feb1623ab006b63ffcf0324',
      retrievedAt: '2026-09-14T05:39:42.508666Z',
    },
    {
      id: 'ny-2025-it2105-9i',
      authority: 'New York State Department of Taxation and Finance',
      title: '2025 it2105-9i',
      url: 'https://www.tax.ny.gov/pdf/2025/inc/it2105_9i_2025.pdf',
      locator: 'Ordinary individual calculation and wage record instructions',
      documentHash:
        '47f4092f86b2262dbc967dbf1891bb3e3f4e5603c04bd7ecadedade3f8e853a8',
      retrievedAt: '2026-09-14T05:39:43.017789Z',
    },
    {
      id: 'ny-2025-it2',
      authority: 'New York State Department of Taxation and Finance',
      title: '2025 it2',
      url: 'https://www.tax.ny.gov/pdf/2025/inc/it2_2025_fill_in_2d.pdf',
      locator: 'Ordinary individual calculation and wage record instructions',
      documentHash:
        'bfeae435f2a4c168044b89296bde0e59a6a27b9555fb465f4735eee31819ba76',
      retrievedAt: '2026-09-14T05:39:44.059398Z',
    },
    {
      id: 'ny-2025-it2105i',
      authority: 'New York State Department of Taxation and Finance',
      title: '2025 estimated tax instructions',
      url: 'https://www.tax.ny.gov/pdf/2025/inc/it2105i_2025.pdf',
      locator: '2025 payment due dates: April15,June16,September15,January15',
      retrievedAt: '2026-09-14T05:42:01.176733Z',
      documentHash:
        'a19b82d4d78d4060932c0714a731e5672c858f5ab78071e23f536bfc2c48c4bd',
    },
  ].map((entry) => FinanceTaxAuthorityReferenceSchema.parse(entry)),
);
