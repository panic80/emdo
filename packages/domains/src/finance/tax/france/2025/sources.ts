import {
  deepFreeze,
  FinanceTaxAuthorityReferenceSchema,
  FinanceTaxAuthoritySourceSchema,
  type FinanceTaxAuthoritySource,
} from '@emdo/contracts';

const retrievedAt = '2026-09-14T16:00:00Z';

/**
 * Pinned primary-source references for the 2025-income / 2026-return
 * candidate. Hashes are SHA-256 digests of the HTTPS response bytes captured
 * on retrievedAt; derived text is never substituted for an authority hash.
 */
export const FRANCE_2025_SOURCES = deepFreeze(
  [
    {
      id: 'dgfip-fr-brochure-ir-2026',
      authority: 'Direction générale des Finances publiques',
      title: 'Brochure pratique 2026 — déclaration des revenus 2025',
      url: 'https://www.impots.gouv.fr/www2/fichiers/documentation/brochure/ir_2026/pdf_integral/Brochure-IR-2026.pdf',
      retrievedAt,
      documentHash:
        '89b85e9f529b0ccc56f9b52b584eb41ea0f21d9b8506df06ead7a0d1f73deada',
      locator:
        'pp. 52, 81, 107, 371–373 and professional-income tables: indexed 2025-income limits; family quotient; 10% salary deduction; micro-BIC/BNC fixed abatements; rounding; tax table; decote; collection threshold',
    },
    {
      id: 'dgfip-fr-form-2042-2026',
      authority: 'Direction générale des Finances publiques',
      title: 'Déclaration des revenus 2025 — formulaire n° 2042 (2026)',
      url: 'https://www.impots.gouv.fr/sites/default/files/formulaires/2042/2026/2042_5535.pdf',
      retrievedAt,
      documentHash:
        'ddf48d388d9b4c69650d3985499aaabb1af757a9b43211979ea663701c46ef2d',
      locator:
        'Form 2042 (Cerfa 10330*30), pp. 1–4: identity, family, salary lines 1AJ–1DJ, actual-expense lines 1AK–1DK and PAS lines 8HV–8IV; version 2026 for income year 2025',
    },
    {
      id: 'dgfip-fr-form-2042-c-pro-2026',
      authority: 'Direction générale des Finances publiques',
      title:
        'Déclaration complémentaire des revenus des professions non salariées 2025 — formulaire n° 2042-C-PRO (2026)',
      url: 'https://www.impots.gouv.fr/sites/default/files/formulaires/2042/2026/2042_5474.pdf',
      retrievedAt,
      documentHash:
        '293de292c87cf77251e659ac5611dac416104d6019e7a458078f7421707c993b',
      locator:
        'Form 2042-C-PRO (Cerfa 11222*28), pp. 1, 3 and 6: operator identity/SIRET, micro-BIC services line 5KP and micro-BNC gross receipts line 5HV with calculated-income lines 5HQ/5KP context',
    },
    {
      id: 'dgfip-fr-form-2065-2026',
      authority: 'Direction générale des Finances publiques',
      title:
        'Impôt sur les sociétés — formulaire n° 2065-SD et annexe 2065 bis-SD (2026)',
      url: 'https://www.impots.gouv.fr/sites/default/files/formulaires/2065-sd/2026/2065-sd_5381.pdf',
      retrievedAt,
      documentHash:
        'c4f8d73574b6aa5667dba91ad8a918aaca3c71587f4d863938d0223f207d06de',
      locator:
        'Form 2065-SD (Cerfa 11084*28), pp. 1–2: exercise/régime/identity, cadre C results at normal and 15% rates, 2065 bis distributions and remuneration; notice states 2050–2059-G liasse is attached',
    },
    {
      id: 'dgfip-fr-is-rates-2026',
      authority: 'Direction générale des Finances publiques',
      title: 'Impôt sur les sociétés — taux normal et taux réduit',
      url: 'https://www.impots.gouv.fr/international-professionnel/impot-sur-les-societes',
      retrievedAt,
      documentHash:
        '9983537e892953610f9a3c3380232ac59b71c4780a7c1959049307bf7ba3aca6',
      locator:
        'Taux applicable aux exercices ouverts depuis 2022: 25% normal; 15% on first €42,500 for qualifying companies with turnover ≤€10m, fully paid capital and qualifying ownership',
    },
    {
      id: 'dgfip-fr-declaration-2026',
      authority: 'Direction générale des Finances publiques',
      title: 'Les modalités de la déclaration de revenus en 2026',
      url: 'https://www.impots.gouv.fr/les-modalites-de-la-declaration-de-revenus-en-2026',
      retrievedAt,
      documentHash:
        'cd267ceec94cc7862c8a67e25b175634a1964ad242df47c758d0b89403f6cd3d',
      locator:
        '§§ 44–62: 2026 filing settles 2025 income and subtracts PAS paid in 2025',
    },
    {
      id: 'bofip-fr-ir-liq-20-10-20260407',
      authority: 'Direction générale des Finances publiques',
      title: 'BOFiP BOI-IR-LIQ-20-10 — détermination de l’impôt brut',
      url: 'https://bofip.impots.gouv.fr/bofip/2491-PGP.html/identifiant=BOI-IR-LIQ-20-10-20260407',
      retrievedAt,
      documentHash:
        '52405ad849c6ab28755ec1ce8b7df00017c9710d78db7b20295be59f5829ed96',
      locator:
        '§§ 10, 40: divide net taxable income by quotient-family parts, apply the progressive scale and multiply by parts; 2025-income thresholds',
    },
    {
      id: 'bofip-fr-ir-liq-20-20-20-20260407',
      authority: 'Direction générale des Finances publiques',
      title: 'BOFiP BOI-IR-LIQ-20-20-20 — plafonnement du quotient familial',
      url: 'https://bofip.impots.gouv.fr/bofip/2494-PGP.html/identifiant=BOI-IR-LIQ-20-20-20-20260407',
      retrievedAt,
      documentHash:
        '85ebe9a711b3716b0abc1756e9bf42c510e3874018b0e502eafa788bfa9c1dab',
      locator:
        '§§ 20, 40, 60–70: double liquidation; €1,807 standard cap; €4,262 first-child full-part cap for a single parent',
    },
    {
      id: 'bofip-fr-ir-liq-20-20-30-20260407',
      authority: 'Direction générale des Finances publiques',
      title: 'BOFiP BOI-IR-LIQ-20-20-30 — décote',
      url: 'https://bofip.impots.gouv.fr/bofip/2495-PGP.html/identifiant=BOI-IR-LIQ-20-20-30-20260407',
      retrievedAt,
      documentHash:
        '9d59f688c2c986fbdf28d61f65ac3319f7eecae3aa681560b1cd13b8151ae72e',
      locator:
        '§§ 10, 40: single-filer decote below €1,982, equal to €897 minus 45.25% of gross progressive tax',
    },
    {
      id: 'bofip-fr-ir-pas-20-20-10-20260407',
      authority: 'Direction générale des Finances publiques',
      title: 'BOFiP BOI-IR-PAS-20-20-10 — taux du prélèvement à la source',
      url: 'https://bofip.impots.gouv.fr/bofip/11247-PGP.html/identifiant=BOI-IR-PAS-20-20-10-20260407',
      retrievedAt,
      documentHash:
        '863eec7601d536edd7493b2248133ca624c880777bcb7eac9c636f16f3de7f60',
      locator:
        '2025-income / 2026-return PAS rules; withholding is credited in annual settlement after declaration',
    },
  ].map((source) => FinanceTaxAuthorityReferenceSchema.parse(source)),
);

/** Build-time host review; it grants no authority to intake-supplied URLs. */
export const FRANCE_2025_SOURCE_REVIEWS: readonly FinanceTaxAuthoritySource[] =
  deepFreeze(
    [
      {
        country: 'FR',
        subdivision: 'FR-METRO',
        hostname: 'impots.gouv.fr',
        authority: 'Direction générale des Finances publiques',
        reviewedBy: 'EMDO tax package review',
        reviewedAt: retrievedAt,
        rationale:
          'Official DGFiP and BOFiP 2026 publications establish the 2025-income scale, salary deduction, quotient-family limits, decote, rounding, PAS settlement, 2042/2042-C-PRO field layouts and 2065 corporate-return requirements used by this development candidate.',
      },
      {
        country: 'FR',
        subdivision: 'FR-METRO',
        hostname: 'bofip.impots.gouv.fr',
        authority: 'Direction générale des Finances publiques',
        reviewedBy: 'EMDO tax package review',
        reviewedAt: retrievedAt,
        rationale:
          'BOFiP is the official DGFiP doctrine host for the 2025-income progressive calculation, family quotient cap and decote rules.',
      },
    ].map((source) => FinanceTaxAuthoritySourceSchema.parse(source)),
  );

export const FRANCE_2025_PROVENANCE = deepFreeze({
  incomeYear: 2025,
  filingYear: 2026,
  returnForm: '2042-2026',
  authority: 'Direction générale des Finances publiques',
  sourceIds: FRANCE_2025_SOURCES.map((source) => source.id),
  retrievedAt,
});
