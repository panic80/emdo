import {
  deepFreeze,
  FinanceTaxAuthorityReferenceSchema,
} from '@emdo/contracts';
export const US_2025_SOURCES = deepFreeze(
  [
    {
      id: 'irs-2025-f1040',
      authority: 'Internal Revenue Service',
      title: 'Form 1040',
      url: 'https://www.irs.gov/pub/irs-prior/f1040--2025.pdf',
      locator: 'Lines 1a, 8\u201311b',
      retrievedAt: '2026-09-14T04:25:47.022967Z',
      documentHash:
        '3d31c226df0d189ced80e039d01cf0f8820c1019681a0f0ca6264de277b7e982',
    },
    {
      id: 'irs-2025-f1040sc',
      authority: 'Internal Revenue Service',
      title: 'Schedule C',
      url: 'https://www.irs.gov/pub/irs-prior/f1040sc--2025.pdf',
      locator: 'Parts I\u2013II, lines 1\u201331',
      retrievedAt: '2026-09-14T04:25:46.996913Z',
      documentHash:
        'ddf401dbe060467d39f90ad2abf645df1de31512821a150dc68a3882bbf19716',
    },
    {
      id: 'irs-2025-f1040sse',
      authority: 'Internal Revenue Service',
      title: 'Schedule SE',
      url: 'https://www.irs.gov/pub/irs-prior/f1040sse--2025.pdf',
      locator: 'Part I lines 2\u201313',
      retrievedAt: '2026-09-14T04:25:46.953410Z',
      documentHash:
        '05bc2b3e1dfca65d8c6fc6d652af4fa3736e953c6575d6e9f82590484677d347',
    },
    {
      id: 'irs-2025-f1040s1',
      authority: 'Internal Revenue Service',
      title: 'Schedule 1',
      url: 'https://www.irs.gov/pub/irs-prior/f1040s1--2025.pdf',
      locator: 'Lines 3, 10, 15, 26',
      retrievedAt: '2026-09-14T04:25:46.984108Z',
      documentHash:
        '8dafec719f6a4716c259a2bdaca546d9bb9e262d1eabef885fe116a7327458fa',
    },
    {
      id: 'irs-2025-f1040s2',
      authority: 'Internal Revenue Service',
      title: 'Schedule 2',
      url: 'https://www.irs.gov/pub/irs-prior/f1040s2--2025.pdf',
      locator: 'Lines 4, 21',
      retrievedAt: '2026-09-14T04:25:46.996873Z',
      documentHash:
        '64d867b683334cfc533993e37ccb0d143449ec29428a78206be2e4de333941e8',
    },
    {
      id: 'irs-2025-i1040gi',
      authority: 'Internal Revenue Service',
      title: '1040 instructions',
      url: 'https://www.irs.gov/pub/irs-prior/i1040gi--2025.pdf',
      locator: 'Rounding Off to Whole Dollars',
      retrievedAt: '2026-09-14T04:25:47.738933Z',
      documentHash:
        '482e9c487c608f1bbeaceef35bc3c0933e8b35443cfff447e4279d590468364a',
    },
    {
      id: 'irs-2025-i1040sc',
      authority: 'Internal Revenue Service',
      title: 'Schedule C instructions',
      url: 'https://www.irs.gov/pub/irs-prior/i1040sc--2025.pdf',
      locator: 'Cash method; Part I and Part II',
      retrievedAt: '2026-09-14T04:25:47.555637Z',
      documentHash:
        'b5536db91498a450572e37078d7d5ee8fdc400e385d4fee3a26c230a33e399b6',
    },
    {
      id: 'irs-2025-i1040sse',
      authority: 'Internal Revenue Service',
      title: 'Schedule SE instructions',
      url: 'https://www.irs.gov/pub/irs-prior/i1040sse--2025.pdf',
      locator: 'Who Must File; Lines 4a Through 4c; Line 13',
      retrievedAt: '2026-09-14T04:25:47.357745Z',
      documentHash:
        'ea9e3120706f9d5e21ce1c6cbec256b5e2e2bf02c44759773d9236462cf4d800',
    },
    {
      id: 'irs-2025-irm-se-threshold',
      authority: 'Internal Revenue Service',
      title: 'Internal Revenue Manual 3.14.1',
      url: 'https://www.irs.gov/irm/part3/irm_03-014-001r',
      locator:
        '3.14.1.6.12.1.3 (01-01-2026), Verifying Self-Employment Income and Self-Employment Tax Changes; TY2025 processing threshold exception for entered SE income of $433.00–$433.99',
      retrievedAt: '2026-09-14T18:55:35.664624Z',
      documentHash:
        '359a7d463c8087151d19d5c4d6bbe50ef9a008b172798d8284420cc1f90a8eb4',
    },
    {
      id: 'irs-2025-p334',
      authority: 'Internal Revenue Service',
      title: 'Tax Guide for Small Business',
      url: 'https://www.irs.gov/pub/irs-prior/p334--2025.pdf',
      locator: 'Chapter 10, Nonfarm Optional Method, Examples 1 and 3',
      retrievedAt: '2026-09-14T04:25:47.919137Z',
      documentHash:
        '722639ba7bfd6f5348234b58d21e1afd8cb0c04895138bd5c4539142dde6c60a',
    },
    {
      id: 'irs-2025-se-correction',
      authority: 'Internal Revenue Service',
      title: 'Schedule SE correction',
      url: 'https://www.irs.gov/forms-pubs/correction-to-the-2025-instructions-for-schedule-se-form-1040',
      locator: 'Three 2025 exemption notation corrections, February 20, 2026',
      retrievedAt: '2026-09-14T04:25:47.871214Z',
      documentHash:
        '815a1c672fdd025f69faf0f395c2d25551f921ba3467bc8a0de608a0bf0c92c6',
    },
    {
      id: 'irs-2025-f8995',
      title: 'Form 8995',
      authority: 'Internal Revenue Service',
      url: 'https://www.irs.gov/pub/irs-prior/f8995--2025.pdf',
      locator: 'Lines 1\u201317',
      retrievedAt: '2026-09-14T04:36:43.985678Z',
      documentHash:
        '55380ad230303e1586ce97f0f224265b8337ad18c9204f0fb7325e95a76b5cde',
    },
    {
      id: 'irs-2025-i8995',
      title: 'Form 8995 instructions',
      authority: 'Internal Revenue Service',
      url: 'https://www.irs.gov/pub/irs-prior/i8995--2025.pdf',
      locator: 'Qualified business income, line11',
      retrievedAt: '2026-09-14T04:36:44.276283Z',
      documentHash:
        '875843baead68f6fa9aa7c3f6f27d6c1f37cb971ac334bcf414acdb4c1487684',
    },
    {
      id: 'irs-2025-qbi-correction',
      title: 'Form 8995 correction',
      authority: 'Internal Revenue Service',
      url: 'https://www.irs.gov/forms-pubs/corrections-to-the-instructions-on-how-to-calculate-the-taxable-income-before-qbi-deduction-for-form-8995',
      locator: 'Line11 correction, February13,2026',
      retrievedAt: '2026-09-14T04:36:44.546870Z',
      documentHash:
        'e6f2515f1a93fa7d77961acdc63c15328d3cb8363df3ddf5c06c0cf0664d9278',
    },
    {
      id: 'irs-2025-f6251',
      title: 'Form 6251',
      authority: 'Internal Revenue Service',
      url: 'https://www.irs.gov/pub/irs-prior/f6251--2025.pdf',
      locator: 'Part I ordinary standard-deduction case; Part II',
      retrievedAt: '2026-09-14T04:36:44.794080Z',
      documentHash:
        '6995bfd29c6fe1b80fdc396c9c4796c7cef58a966070db0346721eae815fea3f',
    },
    {
      id: 'irs-2025-f8959',
      title: 'Form 8959',
      authority: 'Internal Revenue Service',
      url: 'https://www.irs.gov/pub/irs-prior/f8959--2025.pdf',
      locator: 'Parts I,II,IV,V',
      retrievedAt: '2026-09-14T04:36:45.054302Z',
      documentHash:
        '13e64004948331d2b708c80b1b664bf69675028edd0b84f2de6e3ca9afaa996d',
    },
    {
      id: 'irs-2025-p596',
      title: 'Earned Income Credit',
      authority: 'Internal Revenue Service',
      url: 'https://www.irs.gov/pub/irs-prior/p596--2025.pdf',
      locator: 'Childless eligibility and WorksheetB',
      retrievedAt: '2026-09-14T04:36:45.492225Z',
      documentHash:
        '29e8c6695912318253743210fcd68aaa10ad874c76edcab4aa7dc4b23ff51dbf',
    },
    {
      id: 'irs-2025-f2210',
      title: 'Form 2210',
      authority: 'Internal Revenue Service',
      url: 'https://www.irs.gov/pub/irs-prior/f2210--2025.pdf',
      locator: 'Flowchart, Parts I\u2013III',
      retrievedAt: '2026-09-14T04:52:03.026730Z',
      documentHash:
        '6899ce672648b280bf00ab47200f1b0fbf40368cfbf137df507b945b8577159a',
    },
    {
      id: 'irs-2025-i2210',
      title: 'Form 2210 instructions',
      authority: 'Internal Revenue Service',
      url: 'https://www.irs.gov/pub/irs-prior/i2210--2025.pdf',
      locator:
        'Exceptions; equal withholding; regular method; penalty worksheet rate periods',
      retrievedAt: '2026-09-14T04:52:03.401248Z',
      documentHash:
        '7bd6a47494e588fcb422a9ae97970a369fe24fd778ad33b224aeb1cd759e831d',
    },
  ].map((source) => FinanceTaxAuthorityReferenceSchema.parse(source)),
);
