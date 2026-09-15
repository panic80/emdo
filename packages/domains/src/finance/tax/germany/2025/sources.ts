import {
  deepFreeze,
  FinanceTaxAuthorityReferenceSchema,
  FinanceTaxAuthoritySourceSchema,
} from '@emdo/contracts';

const REVIEWED_AT = '2026-09-14T05:00:00.000Z';

/** Immutable authority references used by every emitted Germany 2025 line. */
export const GERMANY_2025_SOURCES = deepFreeze(
  [
    {
      id: 'de-estg-2025',
      authority: 'Federal Ministry of Justice legal portal',
      title: 'Einkommensteuergesetz (EStG), official consolidated text',
      url: 'https://www.gesetze-im-internet.de/estg/EStG.pdf',
      retrievedAt: REVIEWED_AT,
      documentHash:
        'e9480c773127a89216c2439b02534d56321c9174f28f1f4d591afa8b754a5445',
      locator:
        '§§2, 9a, 10, 10c, 15, 18, 32a and 35; income categories, deductions, 2025 tariff and trade-tax credit',
    },
    {
      id: 'de-solzg-2025',
      authority: 'Federal Ministry of Finance',
      title: 'Solidarity surcharge 2025, official tax handbook',
      url: 'https://amtliche-handbuecher.bundesfinanzministerium.de/lsth/2025/B-Anhaenge/Anhang-27/I/inhalt.html',
      retrievedAt: REVIEWED_AT,
      documentHash:
        'a927bdf58ace23c37edf7e98e922ec8ad473711b5f20af8be35b1a48ddcced4d',
      locator:
        'Anhang 27 I, SolzG §§3(3) and 4: single threshold €19,950, joint threshold €39,900, 5.5% and cap formula',
    },
    {
      id: 'de-gewstg-2025',
      authority: 'Federal Ministry of Justice legal portal',
      title: 'Gewerbesteuergesetz (GewStG), official consolidated text',
      url: 'https://www.gesetze-im-internet.de/gewstg/GewStG.pdf',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '328b2785f254b851ef3541585045cfce3e9ea7ca9a167bb27617254cd13e9122',
      locator:
        '§§7, 10, 11, 14 and 16: trade income, rounding, natural-person allowance, 3.5% measure rate and Hebesatz',
    },
    {
      id: 'de-bmf-32a-2025',
      authority: 'Federal Ministry of Finance',
      title: 'EStH 2025 §32a, income-tax tariff',
      url: 'https://amtliche-handbuecher.bundesfinanzministerium.de/lsth/2025/A-Einkommensteuergesetz/IV-Tarif-31-34b/Paragraf-32a/inhalt.html',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '291049d17be1ac102aa6217797627f0ccca157ead95a4c364c18e2c1545bbf73',
      locator:
        '2025 §32a tariff table: x rounded down, €12,096 basic allowance, zones through €277,825 and 45% top rate',
    },
    {
      id: 'de-bmf-9a-2025',
      authority: 'Federal Ministry of Finance',
      title: 'EStH 2025 §9a, employee expense allowance',
      url: 'https://amtliche-handbuecher.bundesfinanzministerium.de/lsth/2025/A-Einkommensteuergesetz/II-Einkommen-2-24b/4-Ueberschuss-d-Einnahmen-ueber-die-Werbungsk-8-9a/Paragraf-9a/inhalt.html',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '0eadb0f72354d08ec8299ff4ffa5717a108debaf993b8e67dc3fd68d5c0ea809',
      locator:
        '§9a no.1(a): employee Werbungskosten-Pauschbetrag €1,230 for 2025 when actual expenses are not higher',
    },
    {
      id: 'de-bmf-35-2025',
      authority: 'Federal Ministry of Finance',
      title: 'EStH 2025 §35, trade-tax credit',
      url: 'https://amtliche-handbuecher.bundesfinanzministerium.de/esth/2025/A-Einkommensteuergesetz/V-Steuerermaessigungen-34c-35c/3-Steuererm.-bei-Eink-aus-Gewerbebetrieb_35/Paragraf-35/inhalt.html',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '7830c095445a9a7892bba8184f3ec028989fd45ecc1e85eef2e6f8f872154252',
      locator:
        '§35(1): four times the assessed trade-tax measure, limited by the allocated tariff-tax reduction ceiling',
    },
    {
      id: 'de-bmf-tax-changes-2025',
      authority: 'Federal Ministry of Finance',
      title: 'What changes in 2025: income tax and solidarity surcharge',
      url: 'https://www.bundesfinanzministerium.de/Content/DE/Standardartikel/Themen/Steuern/das-aendert-sich-2025.html',
      retrievedAt: REVIEWED_AT,
      documentHash:
        'c9eb4f647c854b096270b15c4f0d42d3f3f9533befd79c4ecd56927ccf5043dd',
      locator:
        '2025 tax changes: €12,096 basic allowance and €19,950/€39,900 solidarity-surcharge thresholds',
    },
    {
      id: 'de-bmf-vorsorge-2025',
      authority: 'Federal Ministry of Finance',
      title: 'EStH 2025 table: pension, health and care insurance deductions',
      url: 'https://amtliche-handbuecher.bundesfinanzministerium.de/esth/2025/tabellarische-Uebersicht/Vorsorgeaufwendunge.html',
      retrievedAt: REVIEWED_AT,
      documentHash:
        'fc79b6407d4ce44367fbaf4dd1b430909ac30507bef00d66bce4e2bbb81e5a48',
      locator:
        '2025 table: €29,344 maximum old-age provision amount; 100% basis contributions and full basic health/care deductions',
    },
    {
      id: 'de-bmf-tariff-table-2025',
      authority: 'Federal Ministry of Finance',
      title: 'EStH 2025 tariff table and calculation aids',
      url: 'https://amtliche-handbuecher.bundesfinanzministerium.de/esth/2025/tabellarische-Uebersicht/inhalt.html',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '1e42aed68228aeced922ab05d91e31a6d21f2ddc8865a2d9aadb04012e9ef004',
      locator:
        '2025 calculation aid capture used as an independent tariff-boundary check; §32a remains the controlling rule',
    },
    {
      id: 'de-elster-forms-2025',
      authority: 'ELSTER electronic tax return service',
      title: '2025 income-tax return forms and applicability help',
      url: 'https://www.elster.de/eportal/helpGlobal?themaGlobal=help_est_ufa_10_2025',
      retrievedAt: REVIEWED_AT,
      documentHash:
        'cf9cfd2cf6bdb89b6daa29de9c409dcabe39dc1fc85ffaaa1fdf95df6eee73d5',
      locator:
        '2025 ESt1A, Anlage N, Anlage G, Anlage S and Anlage Vorsorgeaufwand form-selection guidance',
    },
    {
      id: 'de-elster-form-catalogue-2025',
      authority: 'ELSTER electronic tax return service',
      title: 'ELSTER official forms catalogue',
      url: 'https://www.elster.de/eportal/formulare-leistungen/alleformulare',
      retrievedAt: REVIEWED_AT,
      documentHash:
        'cdcf87c49daf82bb72f073d4007bcf57a60aeedb727f8e3ffb6b0365936ceb4e',
      locator: '2025 ESt1A catalogue entry and electronic form availability',
    },
    {
      id: 'de-est1a-2025',
      authority: 'Official German tax authority, Finanzamt Rente im Ausland',
      title: 'ESt 1 A 2025 form bundle and instructions',
      url: 'https://www.finanzamt-rente-im-ausland.de/export/sites/fmria/de/.galleries/formulare/Formulare-2025-Einkommensteuer/ESt-1_A_2025-RiA-komplett.pdf',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '23cb25939f1269c1ace8e4d382dd32dd896daf93fc24c527e10ebbe55afb4cb5',
      locator:
        'ESt1A 2025 main return and Anlage Vorsorgeaufwand lines 4, 11–15, 43; source-bound form-field evidence',
    },
    {
      id: 'de-fms-est1a-2025',
      authority: 'Federal Ministry of Finance Formular-Management-System',
      title: 'Hauptvordruck ESt 1 A (2025), official interactive form capture',
      url: 'https://formulare-bfinv.de/ffw/action/invoke.do?id=034037_25',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '9f8ccc72b9589030f5729b2abcf92bd7dc361c4d499a8673bd9fed06a0f356b3',
      locator:
        'Official 2025 FMS capture: form a034037_25, page 1, lines 4–24 and electronic-form notice',
    },
    {
      id: 'de-fms-anlage-n-2025',
      authority: 'Federal Ministry of Finance Formular-Management-System',
      title: 'Anlage N (2025), official interactive form capture',
      url: 'https://formulare-bfinv.de/ffw/action/invoke.do?id=034027_25',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '8f21b22cb04009db7165902ed43fd5161f3703382ec6aed618e58b0ebd03057c',
      locator:
        'Official 2025 FMS capture: form a034027_25, page 1, lines 1–24; field IDs, labels and eData precision',
    },
    {
      id: 'de-fms-anlage-g-2025',
      authority: 'Federal Ministry of Finance Formular-Management-System',
      title: 'Anlage G (2025), official electronic-form availability notice',
      url: 'https://formulare-bfinv.de/ffw/action/invoke.do?id=034094_25',
      retrievedAt: REVIEWED_AT,
      documentHash:
        'ec151d6bf5b283410370ed6eb04e9420aaafba10bbd34e3090bc45a1144daecc',
      locator:
        'Official 2025 FMS capture: form a034094_25; paper field pages are withheld because Anlage G is electronically transmitted under §25(4) EStG',
    },
    {
      id: 'de-fms-anlage-s-2025',
      authority: 'Federal Ministry of Finance Formular-Management-System',
      title: 'Anlage S (2025), official electronic-form availability notice',
      url: 'https://formulare-bfinv.de/ffw/action/invoke.do?id=034095_25',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '570bf39bc4288fda1de075d43dd295debe014f2adfd52be18eca6f0df9a32336',
      locator:
        'Official 2025 FMS capture: form a034095_25; paper field pages are withheld because Anlage S is electronically transmitted under §25(4) EStG',
    },
    {
      id: 'de-fms-vorsorgeaufwand-2025',
      authority: 'Federal Ministry of Finance Formular-Management-System',
      title: 'Anlage Vorsorgeaufwand (2025), official interactive form capture',
      url: 'https://formulare-bfinv.de/ffw/action/invoke.do?id=034098_25',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '305d0b3a9b4453239776334d9463d33f50d11ab24e7b81406971d88acae72165',
      locator:
        'Official 2025 FMS capture: form a034098_25, page 1, lines 1–22; field IDs and whole-euro precision',
    },
    {
      id: 'de-kstg-2025',
      authority: 'Federal Ministry of Justice legal portal',
      title: 'Körperschaftsteuergesetz (KStG), official consolidated text',
      url: 'https://www.gesetze-im-internet.de/kstg_1977/KStG.pdf',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '84799bc3d379dd311ae2d1878f7a4b21b6f7c0793d9c1ecf15d0b1badb57aef4',
      locator:
        '§§1, 8, 23, 31: resident corporation tax liability, taxable income, 15% rate through assessment year 2027 and assessment procedure',
    },
    {
      id: 'de-bmf-kst-rate-2025',
      authority: 'Federal Ministry of Finance',
      title: 'Körperschaftsteuer, official BMF glossary entry',
      url: 'https://www.bundesfinanzministerium.de/Content/DE/Glossareintraege/K/koerperschaftsteuer.html?view=renderHelp',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '60759812a143f0c30b328e2855d39f840f7eeeedbfbbb3292278653acddbe57b',
      locator:
        'Official BMF entry: corporation income tax is 15% of taxable income and assessed annually',
    },
    {
      id: 'de-elster-kst-2025',
      authority: 'ELSTER electronic tax return service',
      title: '2025 Körperschaftsteuer return help and field applicability',
      url: 'https://www.elster.de/eportal/helpGlobal?themaGlobal=help_kst_2025',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '96a88c0a6a42d6ab527ee7c9644f3dfa6e0044e12ae14745b61553686333b145',
      locator:
        'Official 2025 ELSTER KSt help: KSt1, Anlage GK, Anlage ZVE, line applicability and 31 July 2026 filing deadline',
    },
    {
      id: 'de-elster-gewst-2025',
      authority: 'ELSTER electronic tax return service',
      title: '2025 Gewerbesteuer return help and field applicability',
      url: 'https://www.elster.de/eportal/helpGlobal?themaGlobal=help_gewst_ufa_20_2025',
      retrievedAt: REVIEWED_AT,
      documentHash:
        '3d70265aa5256a854444463812d87ad2ad7c129d5a0bfd7ab7f16bbbdff1877e',
      locator:
        'Official 2025 ELSTER Gewerbesteuer help: GewSt 1 A and related Anlagen; Gewerbeertrag transfer to line 86',
    },
    {
      id: 'de-elster-availability-2025',
      authority: 'ELSTER electronic tax return service',
      title: 'Official ELSTER 2025 form availability dates',
      url: 'https://www.elster.de/eportal/infoseite/bereitstellungstermine',
      retrievedAt: REVIEWED_AT,
      documentHash:
        'f32ac0403f82924a1314905d3dbcdfd9a01b657da7f04d0a6f687a9c5bb16005',
      locator:
        'Official availability page lists 2025 Körperschaftsteuererklärung, Gewerbesteuererklärung and Gewerbesteuerzerlegung forms from 25 March 2026',
    },
    {
      id: 'de-bmf-pap-2025',
      authority: 'Federal Ministry of Finance',
      title: '2025 payroll programme flow plan publication',
      url: 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/Steuern/Steuerarten/Lohnsteuer/Programmablaufplan/2024-11-22-PAP-2025.html',
      retrievedAt: REVIEWED_AT,
      documentHash:
        'c108a6a48e4625043b355ceb19e50cf894890b68b1644a16e824fa24928003e7',
      locator:
        '2025 PAP publication and payroll availability only; annual return Soli is calculated from SolzG/BMF rule capture',
    },
  ].map((source) => FinanceTaxAuthorityReferenceSchema.parse(source)),
);

/** Build-time authority host review used by package tooling, without granting runtime access. */
export const GERMANY_2025_AUTHORITY_SOURCES = deepFreeze(
  [
    {
      country: 'DE',
      subdivision: 'DE-FED',
      hostname: 'gesetze-im-internet.de',
      authority: 'Federal Ministry of Justice legal portal',
      reviewedBy: 'EMDO finance tax source review',
      reviewedAt: REVIEWED_AT,
      rationale:
        'Official federal legal text is the controlling source for EStG and GewStG statutory rules.',
    },
    {
      country: 'DE',
      subdivision: 'DE-FED',
      hostname: 'amtliche-handbuecher.bundesfinanzministerium.de',
      authority: 'Federal Ministry of Finance official tax handbooks',
      reviewedBy: 'EMDO finance tax source review',
      reviewedAt: REVIEWED_AT,
      rationale:
        'Official 2025 handbooks provide the tariff, employee allowance, trade-tax credit and Soli calculation text.',
    },
    {
      country: 'DE',
      subdivision: 'DE-FED',
      hostname: 'bundesfinanzministerium.de',
      authority: 'Federal Ministry of Finance',
      reviewedBy: 'EMDO finance tax source review',
      reviewedAt: REVIEWED_AT,
      rationale:
        'Official BMF 2025 tax-change and payroll-publication pages establish the available-year context.',
    },
    {
      country: 'DE',
      subdivision: 'DE-FED',
      hostname: 'elster.de',
      authority: 'ELSTER electronic tax return service',
      reviewedBy: 'EMDO finance tax source review',
      reviewedAt: REVIEWED_AT,
      rationale:
        'Official ELSTER pages identify the 2025 return and schedule forms used by this candidate.',
    },
    {
      country: 'DE',
      subdivision: 'DE-FED',
      hostname: 'finanzamt-rente-im-ausland.de',
      authority: 'Official German tax authority, Finanzamt Rente im Ausland',
      reviewedBy: 'EMDO finance tax source review',
      reviewedAt: REVIEWED_AT,
      rationale:
        'Official tax-office publication provides the pinned ESt1A 2025 form and instructions bundle.',
    },
    {
      country: 'DE',
      subdivision: 'DE-FED',
      hostname: 'formulare-bfinv.de',
      authority: 'Federal Ministry of Finance Formular-Management-System',
      reviewedBy: 'EMDO finance tax source review',
      reviewedAt: REVIEWED_AT,
      rationale:
        'Official federal form-server captures establish the actual 2025 ESt1A, Anlage N and Vorsorgeaufwand field IDs and document the electronic-only G/S forms.',
    },
  ].map((source) => FinanceTaxAuthoritySourceSchema.parse(source)),
);
