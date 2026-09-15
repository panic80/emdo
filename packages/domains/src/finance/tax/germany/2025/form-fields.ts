import {
  deepFreeze,
  type FinanceTaxEvaluation,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import { GERMANY_2025_SOURCES } from './sources.js';

/**
 * This inventory is deliberately separate from the semantic working-paper
 * definitions.  The FMS captures contain actual control IDs for ESt1A, Anlage
 * N and Anlage Vorsorgeaufwand.  The official 2025 FMS pages for Anlage G and
 * Anlage S are availability notices because those schedules are electronically
 * transmitted; their electronic data paths remain unresolved here.
 */
export type Germany2025FormId =
  'ESt1A' | 'AnlageN' | 'AnlageG' | 'AnlageS' | 'Vorsorgeaufwand';

export type Germany2025FieldKind =
  | 'amount'
  | 'text'
  | 'date'
  | 'choice'
  | 'checkbox'
  | 'calculated-output'
  | 'schedule-line';

export type Germany2025FieldPrecision =
  | 'whole-euro'
  | 'euro-cent'
  | 'text'
  | 'date'
  | 'choice'
  | 'boolean'
  | 'unproven';

export type Germany2025FieldStatus =
  'populated' | 'inapplicable' | 'user-required' | 'unresolved';

type Branch =
  | 'all'
  | 'single'
  | 'one-employer'
  | 'no-special-wages'
  | 'no-income-replacement'
  | 'no-foreign-income'
  | 'no-church-tax'
  | 'no-private-insurance'
  | 'no-additional-pension'
  | 'professional'
  | 'trade';

type Germany2025FieldDefinition = {
  formId: Germany2025FormId;
  fieldId: string | null;
  line: string;
  label: string;
  kind: Germany2025FieldKind;
  precision: Germany2025FieldPrecision;
  sourceId: string;
  actualField: boolean;
  reportingOnly?: boolean;
  electronicOnly?: boolean;
  factKey?: string;
  logicalKey?: string;
  branch?: Branch;
  required?: boolean;
};

export type Germany2025FormField = Germany2025FieldDefinition & {
  sourceHash: string;
};

export type Germany2025FieldDecision = Germany2025FormField & {
  status: Germany2025FieldStatus;
  value: string | boolean | null;
  predicate: string;
  sourceFactKeys: readonly string[];
  calculationKey: string | null;
};

export type Germany2025TraceLike = {
  formId: string;
  line: string;
  exactNumerator?: string;
  exactDenominator?: string;
  sourceFactKeys?: readonly string[];
};

const source = (sourceId: string) => {
  const reference = GERMANY_2025_SOURCES.find((entry) => entry.id === sourceId);
  if (!reference)
    throw new Error(`Germany source is not registered: ${sourceId}`);
  return reference;
};

const f = (definition: Germany2025FieldDefinition): Germany2025FormField => ({
  ...definition,
  sourceHash: source(definition.sourceId).documentHash,
});

const fmsEst1a = 'de-fms-est1a-2025';
const fmsN = 'de-fms-anlage-n-2025';
const fmsVorsorge = 'de-fms-vorsorgeaufwand-2025';
const fmsG = 'de-fms-anlage-g-2025';
const fmsS = 'de-fms-anlage-s-2025';
const est1aInstructions = 'de-est1a-2025';

const actual = (
  formId: Germany2025FormId,
  fieldId: string,
  line: string,
  label: string,
  kind: Germany2025FieldKind,
  precision: Germany2025FieldPrecision,
  sourceId: string,
  extra: Partial<Germany2025FieldDefinition> = {},
) =>
  f({
    formId,
    fieldId,
    line,
    label,
    kind,
    precision,
    sourceId,
    actualField: true,
    ...extra,
  });

const derived = (
  formId: Germany2025FormId,
  line: string,
  logicalKey: string,
  label: string,
  sourceId: string,
  extra: Partial<Germany2025FieldDefinition> = {},
) =>
  f({
    formId,
    fieldId: null,
    line,
    label,
    kind: 'schedule-line',
    precision: 'unproven',
    sourceId,
    actualField: false,
    reportingOnly: true,
    logicalKey,
    required: true,
    ...extra,
  });

const output = (line: string, label: string) =>
  f({
    formId: 'ESt1A',
    fieldId: `review.evaluation.${line}`,
    line,
    label,
    kind: 'calculated-output',
    precision: 'euro-cent',
    sourceId: est1aInstructions,
    actualField: false,
    reportingOnly: true,
    logicalKey: `ESt1A.${line}`,
    required: false,
  });

/**
 * Actual 2025 controls captured from the federal form server, together with
 * semantic schedule lines that must be reconciled to the electronic ELSTER
 * data set before a filing export can be enabled.
 */
export const GERMANY_2025_FORM_FIELD_CATALOG = deepFreeze([
  // Hauptvordruck ESt 1 A (form a034037_25, page 1).
  actual(
    'ESt1A',
    'k1',
    '1',
    'Einkommensteuererklärung 2025 verwenden',
    'checkbox',
    'boolean',
    fmsEst1a,
    { logicalKey: 'scope.income-tax-return', required: true },
  ),
  actual(
    'ESt1A',
    'k2',
    '1',
    'Antrag auf Arbeitnehmer-Sparzulage',
    'checkbox',
    'boolean',
    fmsEst1a,
    { branch: 'all', required: false },
  ),
  actual(
    'ESt1A',
    'k3',
    '2',
    'Erklärung zur Kirchensteuer auf Kapitalerträge',
    'checkbox',
    'boolean',
    fmsEst1a,
    { branch: 'no-church-tax', required: false },
  ),
  actual(
    'ESt1A',
    'k4',
    '2',
    'Erklärung zur Feststellung des verbleibenden Verlustvortrags',
    'checkbox',
    'boolean',
    fmsEst1a,
    { branch: 'all', required: false },
  ),
  actual(
    'ESt1A',
    'k7',
    '3',
    'Antrag auf Mobilitätsprämie',
    'checkbox',
    'boolean',
    fmsEst1a,
    { branch: 'all', required: false },
  ),
  actual(
    'ESt1A',
    'steuernummer',
    '4',
    'Steuernummer',
    'text',
    'text',
    fmsEst1a,
  ),
  actual(
    'ESt1A',
    'finanzamt',
    '5',
    'Name des Finanzamts',
    'text',
    'text',
    fmsEst1a,
  ),
  actual(
    'ESt1A',
    'bisheriges_finanzamt',
    '6',
    'Bisheriges Finanzamt bei Wohnsitzwechsel',
    'text',
    'text',
    fmsEst1a,
    { required: false },
  ),
  actual(
    'ESt1A',
    'telefon',
    '7',
    'Telefonische Rückfragen tagsüber',
    'text',
    'text',
    fmsEst1a,
    { required: false },
  ),
  ...[
    ['identifikationssnummer', 'erste zwei Ziffern'],
    ['identifikationssnummer2', 'nächste drei Ziffern'],
    ['identifikationssnummer3', 'nächste drei Ziffern'],
    ['identifikationssnummer4', 'letzte drei Ziffern'],
  ].map(([fieldId, part]) =>
    actual(
      'ESt1A',
      fieldId!,
      '8',
      `Identifikationsnummer, ${part}`,
      'text',
      'text',
      fmsEst1a,
    ),
  ),
  actual(
    'ESt1A',
    'geburtsdatum',
    '8',
    'Geburtsdatum',
    'date',
    'date',
    fmsEst1a,
  ),
  actual(
    'ESt1A',
    'sterbedatum',
    '8',
    'Sterbedatum im Sterbefall',
    'date',
    'date',
    fmsEst1a,
    { required: false },
  ),
  actual('ESt1A', 'name', '9', 'Name', 'text', 'text', fmsEst1a),
  actual('ESt1A', 'vorname', '10', 'Vorname', 'text', 'text', fmsEst1a),
  actual(
    'ESt1A',
    'titel',
    '11',
    'Titel oder akademischer Grad',
    'text',
    'text',
    fmsEst1a,
    { required: false },
  ),
  actual(
    'ESt1A',
    'religion_barrierearm',
    '11',
    'Religion am 31.12.2025',
    'choice',
    'choice',
    fmsEst1a,
  ),
  actual(
    'ESt1A',
    'ausgeuebter_beruf',
    '12',
    'Ausgeübter Beruf',
    'text',
    'text',
    fmsEst1a,
  ),
  actual(
    'ESt1A',
    'reliaenderung',
    '12',
    'Änderung der Religion im Jahr 2025',
    'choice',
    'choice',
    fmsEst1a,
    { required: false },
  ),
  actual(
    'ESt1A',
    'strasse_hausnummer',
    '13',
    'Straße',
    'text',
    'text',
    fmsEst1a,
  ),
  actual('ESt1A', 'hausnummer', '14', 'Hausnummer', 'text', 'text', fmsEst1a),
  actual(
    'ESt1A',
    'hausnummerzusatz',
    '14',
    'Hausnummerzusatz',
    'text',
    'text',
    fmsEst1a,
    { required: false },
  ),
  actual(
    'ESt1A',
    'ergaenzung',
    '14',
    'Adressergänzung',
    'text',
    'text',
    fmsEst1a,
    { required: false },
  ),
  actual(
    'ESt1A',
    'postleitzahl',
    '15',
    'Postleitzahl im Inland',
    'text',
    'text',
    fmsEst1a,
  ),
  actual(
    'ESt1A',
    'postleitzahl4',
    '15',
    'Postleitzahl im Ausland',
    'text',
    'text',
    fmsEst1a,
    { required: false },
  ),
  actual('ESt1A', 'wohnort', '16', 'Wohnort', 'text', 'text', fmsEst1a),
  actual(
    'ESt1A',
    'staat2',
    '17',
    'Staat bei Anschrift im Ausland',
    'text',
    'text',
    fmsEst1a,
    { required: false },
  ),
  ...[
    ['datum', 'verheiratet oder Lebenspartnerschaft begründet'],
    ['datum2', 'verwitwet'],
    ['datum3', 'geschieden oder aufgehoben'],
    ['datum4', 'dauernd getrennt lebend'],
  ].map(([fieldId, label]) =>
    actual(
      'ESt1A',
      fieldId!,
      '18',
      `Familienstand: ${label}`,
      'date',
      'date',
      fmsEst1a,
      { branch: 'single', required: false },
    ),
  ),
  actual(
    'ESt1A',
    'k9',
    '19',
    'Zusammenveranlagung',
    'checkbox',
    'boolean',
    fmsEst1a,
    { branch: 'single', required: false },
  ),
  actual(
    'ESt1A',
    'k11',
    '19',
    'Einzelveranlagung von Ehegatten oder Lebenspartnern',
    'checkbox',
    'boolean',
    fmsEst1a,
    { branch: 'single', required: false },
  ),
  actual(
    'ESt1A',
    'k12',
    '19',
    'Gütergemeinschaft',
    'checkbox',
    'boolean',
    fmsEst1a,
    { branch: 'single', required: false },
  ),
  ...[
    ['identifikationssnummer5', 'erste zwei Ziffern'],
    ['identifikationssnummer6', 'nächste drei Ziffern'],
    ['identifikationssnummer7', 'nächste drei Ziffern'],
    ['identifikationssnummer8', 'letzte drei Ziffern'],
  ].map(([fieldId, part]) =>
    actual(
      'ESt1A',
      fieldId!,
      '20',
      `Identifikationsnummer Person B, ${part}`,
      'text',
      'text',
      fmsEst1a,
      { branch: 'single', required: false },
    ),
  ),
  actual(
    'ESt1A',
    'geburtsdatum2',
    '20',
    'Geburtsdatum Person B',
    'date',
    'date',
    fmsEst1a,
    { branch: 'single', required: false },
  ),
  actual(
    'ESt1A',
    'sterbedatum2',
    '20',
    'Sterbedatum Person B',
    'date',
    'date',
    fmsEst1a,
    { branch: 'single', required: false },
  ),
  actual(
    'ESt1A',
    'abweichender_name',
    '21',
    'Name Person B',
    'text',
    'text',
    fmsEst1a,
    { branch: 'single', required: false },
  ),
  actual(
    'ESt1A',
    'vorname_ehefrau',
    '22',
    'Vorname Person B',
    'text',
    'text',
    fmsEst1a,
    { branch: 'single', required: false },
  ),
  actual('ESt1A', 'titel2', '23', 'Titel Person B', 'text', 'text', fmsEst1a, {
    branch: 'single',
    required: false,
  }),
  actual(
    'ESt1A',
    'religion2_barrierearm',
    '23',
    'Religion Person B',
    'choice',
    'choice',
    fmsEst1a,
    { branch: 'single', required: false },
  ),
  actual(
    'ESt1A',
    'ausgeuebter_beruf2',
    '24',
    'Ausgeübter Beruf Person B',
    'text',
    'text',
    fmsEst1a,
    { branch: 'single', required: false },
  ),
  actual(
    'ESt1A',
    'reliaenderung2',
    '24',
    'Änderung der Religion Person B im Jahr 2025',
    'choice',
    'choice',
    fmsEst1a,
    { branch: 'single', required: false },
  ),

  // Anlage N (form a034027_25, page 1). eData controls are read-only on FMS;
  // the review exporter can carry values, but cannot submit them as a filing.
  actual('AnlageN', 'name', '1', 'Name', 'text', 'text', fmsN),
  actual('AnlageN', 'name2', '2', 'Vorname', 'text', 'text', fmsN),
  actual('AnlageN', 'steuernummer', '3', 'Steuernummer', 'text', 'text', fmsN),
  actual(
    'AnlageN',
    'k_mann',
    '3',
    'Steuerpflichtige Person oder Person A',
    'checkbox',
    'boolean',
    fmsN,
    { required: true },
  ),
  actual(
    'AnlageN',
    'k_frau',
    '3',
    'Ehefrau oder Person B',
    'checkbox',
    'boolean',
    fmsN,
    { branch: 'single', required: false },
  ),
  actual(
    'AnlageN',
    'k_hinweis',
    '4',
    'Wichtiger Hinweis für nicht zutreffende eDaten',
    'checkbox',
    'boolean',
    fmsN,
    { required: true },
  ),
  actual(
    'AnlageN',
    'steuerklasse',
    '4',
    'Steuerklasse',
    'choice',
    'choice',
    fmsN,
  ),
  actual(
    'AnlageN',
    'betrag',
    '5',
    'Bruttoarbeitslohn Steuerklassen 1 bis 5',
    'amount',
    'whole-euro',
    fmsN,
    { factKey: 'employment.grossWages', logicalKey: 'AnlageN.grossWages' },
  ),
  actual(
    'AnlageN',
    'betrag6',
    '5',
    'Bruttoarbeitslohn Steuerklasse 6 oder Urlaubskasse',
    'amount',
    'whole-euro',
    fmsN,
    { branch: 'one-employer', required: false },
  ),
  actual(
    'AnlageN',
    'betrag2',
    '6',
    'Lohnsteuer Steuerklassen 1 bis 5',
    'amount',
    'euro-cent',
    fmsN,
    {
      factKey: 'employment.incomeTaxWithheld',
      logicalKey: 'ESt1A.incomeTaxWithheld',
    },
  ),
  actual(
    'AnlageN',
    'betrag7',
    '6',
    'Lohnsteuer Steuerklasse 6 oder Urlaubskasse',
    'amount',
    'euro-cent',
    fmsN,
    { branch: 'one-employer', required: false },
  ),
  actual(
    'AnlageN',
    'betrag3',
    '7',
    'Solidaritätszuschlag Steuerklassen 1 bis 5',
    'amount',
    'euro-cent',
    fmsN,
    { factKey: 'employment.soliWithheld', logicalKey: 'ESt1A.soliWithheld' },
  ),
  actual(
    'AnlageN',
    'betrag8',
    '7',
    'Solidaritätszuschlag Steuerklasse 6 oder Urlaubskasse',
    'amount',
    'euro-cent',
    fmsN,
    { branch: 'one-employer', required: false },
  ),
  actual(
    'AnlageN',
    'betrag4',
    '8',
    'Kirchensteuer Arbeitnehmer Steuerklassen 1 bis 5',
    'amount',
    'euro-cent',
    fmsN,
    {
      factKey: 'employment.churchTaxWithheld',
      branch: 'no-church-tax',
      required: false,
    },
  ),
  actual(
    'AnlageN',
    'betrag9',
    '8',
    'Kirchensteuer Steuerklasse 6 oder Urlaubskasse',
    'amount',
    'euro-cent',
    fmsN,
    { branch: 'one-employer', required: false },
  ),
  actual(
    'AnlageN',
    'betrag5',
    '9',
    'Kirchensteuer Ehegatte oder Lebenspartner',
    'amount',
    'euro-cent',
    fmsN,
    { branch: 'single', required: false },
  ),
  actual(
    'AnlageN',
    'betrag10',
    '9',
    'Kirchensteuer Person B Steuerklasse 6 oder Urlaubskasse',
    'amount',
    'euro-cent',
    fmsN,
    { branch: 'single', required: false },
  ),
  actual(
    'AnlageN',
    'zeile10',
    '10',
    'Korrektur Firmenwagenbesteuerung',
    'choice',
    'choice',
    fmsN,
    { branch: 'no-special-wages', required: false },
  ),
  ...[
    ['betrag11', '11', 'Steuerbegünstigte Versorgungsbezüge erster Bezug'],
    ['betrag15', '11', 'Steuerbegünstigte Versorgungsbezüge zweiter Bezug'],
    [
      'betrag12',
      '12',
      'Bemessungsgrundlage Versorgungsfreibetrag erster Bezug',
    ],
    [
      'betrag16',
      '12',
      'Bemessungsgrundlage Versorgungsfreibetrag zweiter Bezug',
    ],
    ['betrag13', '15', 'Sterbegeld oder Abfindung erster Bezug'],
    ['betrag17', '15', 'Sterbegeld oder Abfindung zweiter Bezug'],
    ['betrag14', '16', 'Versorgungsbezüge für mehrere Jahre erster Bezug'],
    ['betrag18', '16', 'Versorgungsbezüge für mehrere Jahre zweiter Bezug'],
    ['betrag69', '17', 'Arbeitslohn für mehrere Jahre oder Entschädigungen'],
    ['betrag24', '18', 'Arbeitslohn ohne Steuerabzug'],
    ['steuerfr_einnahmen', '19', 'Steuerfreie Aufwandsentschädigung Tätigkeit'],
    ['betrag48', '19', 'Steuerfreie Aufwandsentschädigung Betrag'],
  ].map(([fieldId, line, label]) =>
    actual(
      'AnlageN',
      fieldId!,
      line!,
      label!,
      fieldId === 'steuerfr_einnahmen' ? 'text' : 'amount',
      fieldId === 'steuerfr_einnahmen' ? 'text' : 'whole-euro',
      fmsN,
      { branch: 'no-special-wages', required: false },
    ),
  ),
  actual(
    'AnlageN',
    'betrag30',
    '20',
    'Kurzarbeitergeld und vergleichbare Lohnersatzleistungen',
    'amount',
    'whole-euro',
    fmsN,
    { branch: 'no-income-replacement', required: false },
  ),
  ...[
    [
      'betrag25',
      '21',
      'Steuerfreier Arbeitslohn nach Doppelbesteuerungsabkommen',
    ],
    [
      'betrag26',
      '22',
      'Steuerfreier Arbeitslohn nach Auslandstätigkeitserlass',
    ],
    ['betrag33', '23', 'Steuerfreie besondere Lohnbestandteile'],
    ['anz', '24', 'Anzahl Anlagen N-AUS'],
  ].map(([fieldId, line, label]) =>
    actual(
      'AnlageN',
      fieldId!,
      line!,
      label!,
      fieldId === 'anz' ? 'text' : 'amount',
      fieldId === 'anz' ? 'text' : 'whole-euro',
      fmsN,
      { branch: 'no-foreign-income', required: false },
    ),
  ),

  // Anlage Vorsorgeaufwand (form a034098_25, page 1). The remaining pages
  // use the same actual control namespace and are represented as explicit
  // unresolved controls where this bounded intake has no fact.
  actual('Vorsorgeaufwand', 'name', '1', 'Name', 'text', 'text', fmsVorsorge),
  actual(
    'Vorsorgeaufwand',
    'vorname',
    '2',
    'Vorname',
    'text',
    'text',
    fmsVorsorge,
  ),
  actual(
    'Vorsorgeaufwand',
    'steuernummer',
    '3',
    'Steuernummer',
    'text',
    'text',
    fmsVorsorge,
  ),
  actual(
    'Vorsorgeaufwand',
    'k_hinweis',
    '3',
    'Wichtiger Hinweis für nicht zutreffende eDaten',
    'checkbox',
    'boolean',
    fmsVorsorge,
    { required: true },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag',
    '4',
    'Arbeitnehmeranteil Altersvorsorge',
    'amount',
    'whole-euro',
    fmsVorsorge,
    {
      factKey: 'insurance.pensionEmployee',
      logicalKey: 'Vorsorgeaufwand.pensionContributions',
    },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag2',
    '5',
    'Landwirtschaftliche Alterskassen oder berufsständische Versorgung',
    'amount',
    'whole-euro',
    fmsVorsorge,
    {
      factKey: 'insurance.pensionAdditional',
      branch: 'no-additional-pension',
      required: false,
    },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag3',
    '6',
    'Gesetzliche Rentenversicherung außerhalb Zeile 4',
    'amount',
    'whole-euro',
    fmsVorsorge,
    {
      factKey: 'insurance.pensionAdditional',
      branch: 'no-additional-pension',
      required: false,
    },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag6',
    '7',
    'Erstattete Beiträge oder steuerfreie Zuschüsse Altersvorsorge',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { branch: 'all', required: true },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag4',
    '8',
    'Zertifizierte Basisrentenverträge',
    'amount',
    'whole-euro',
    fmsVorsorge,
    {
      factKey: 'insurance.pensionAdditional',
      branch: 'no-additional-pension',
      required: false,
    },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag5',
    '9',
    'Arbeitgeberanteil oder Arbeitgeberzuschuss Altersvorsorge',
    'amount',
    'whole-euro',
    fmsVorsorge,
    {
      factKey: 'insurance.pensionAdditional',
      branch: 'no-additional-pension',
      required: false,
    },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag7',
    '10',
    'Arbeitgeberanteil gesetzliche Rentenversicherung Minijob',
    'amount',
    'whole-euro',
    fmsVorsorge,
    {
      factKey: 'insurance.pensionAdditional',
      branch: 'professional',
      required: false,
    },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag15',
    '11',
    'Arbeitnehmerbeiträge Krankenversicherung',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { logicalKey: 'Vorsorgeaufwand.healthContributions' },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag17',
    '12',
    'In Zeile 11 enthaltene Beiträge ohne Krankengeldanspruch',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { factKey: 'insurance.healthWithoutSickPay', required: false },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag18',
    '13',
    'Arbeitnehmerbeiträge soziale Pflegeversicherung',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { factKey: 'insurance.longTermCare' },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag19',
    '14',
    'Erstattete Beiträge Kranken- oder Pflegeversicherung',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { logicalKey: 'Vorsorgeaufwand.insuranceRefunds' },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag20',
    '15',
    'Erstattete Beiträge ohne Krankengeldanspruch',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { branch: 'all', required: true },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag27',
    '16',
    'Weitere Krankenversicherungsbeiträge',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { branch: 'no-private-insurance', required: false },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag29',
    '17',
    'In Zeile 16 enthaltene Beiträge mit Krankengeldanspruch',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { branch: 'no-private-insurance', required: false },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag30',
    '18',
    'Weitere soziale Pflegeversicherungsbeiträge',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { branch: 'no-private-insurance', required: false },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag31',
    '19',
    'Erstattete Beiträge weitere Kranken- oder Pflegeversicherung',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { branch: 'no-private-insurance', required: false },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag32',
    '20',
    'In Zeile 19 enthaltene Beiträge mit Krankengeldanspruch',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { branch: 'no-private-insurance', required: false },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag33',
    '21',
    'Zuschuss zu weiteren Kranken- oder Pflegebeiträgen',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { branch: 'no-private-insurance', required: false },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag46',
    '22',
    'Beiträge über die Basisabsicherung hinaus',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { branch: 'no-private-insurance', required: false },
  ),
  actual(
    'Vorsorgeaufwand',
    'betrag52',
    '22',
    'Beiträge über die Basisabsicherung hinaus Person B',
    'amount',
    'whole-euro',
    fmsVorsorge,
    { branch: 'single', required: false },
  ),

  // The official FMS pages explicitly withhold the G/S paper fields. These
  // entries retain the reporting obligations and their source proof without
  // manufacturing ELSTER XML paths.
  derived(
    'AnlageG',
    'grossReceipts',
    'AnlageG.grossReceipts',
    'Betriebseinnahmen / gross receipts (electronic ELSTER path unresolved)',
    fmsG,
    { branch: 'trade', electronicOnly: true },
  ),
  derived(
    'AnlageG',
    'deductibleExpenses',
    'AnlageG.deductibleExpenses',
    'Betriebsausgaben / deductible expenses (electronic ELSTER path unresolved)',
    fmsG,
    { branch: 'trade', electronicOnly: true },
  ),
  derived(
    'AnlageG',
    'profit',
    'AnlageG.profit',
    'Gewinn aus Gewerbebetrieb (electronic ELSTER path unresolved)',
    fmsG,
    { branch: 'trade', electronicOnly: true },
  ),
  derived(
    'AnlageG',
    'gewerbeertrag',
    'AnlageG.gewerbeertrag',
    'Gewerbeertrag for trade-tax transfer (electronic ELSTER path unresolved)',
    fmsG,
    { branch: 'trade', electronicOnly: true },
  ),
  derived(
    'AnlageG',
    'tradeTaxMeasure',
    'AnlageG.tradeTaxMeasure',
    'Gewerbesteuer-Messbetrag (electronic ELSTER path unresolved)',
    fmsG,
    { branch: 'trade', electronicOnly: true },
  ),
  derived(
    'AnlageG',
    'tradeTax',
    'AnlageG.tradeTax',
    'Municipal trade tax (electronic ELSTER path unresolved)',
    fmsG,
    { branch: 'trade', electronicOnly: true },
  ),
  derived(
    'AnlageG',
    'incomeTaxReduction35',
    'AnlageG.incomeTaxReduction35',
    '§35 EStG income-tax reduction (electronic ELSTER path unresolved)',
    fmsG,
    { branch: 'trade', electronicOnly: true },
  ),
  derived(
    'AnlageS',
    'grossReceipts',
    'AnlageS.grossReceipts',
    'Betriebseinnahmen / gross receipts (electronic ELSTER path unresolved)',
    fmsS,
    { branch: 'professional', electronicOnly: true },
  ),
  derived(
    'AnlageS',
    'deductibleExpenses',
    'AnlageS.deductibleExpenses',
    'Betriebsausgaben / deductible expenses (electronic ELSTER path unresolved)',
    fmsS,
    { branch: 'professional', electronicOnly: true },
  ),
  derived(
    'AnlageS',
    'profit',
    'AnlageS.profit',
    'Gewinn aus selbständiger Arbeit (electronic ELSTER path unresolved)',
    fmsS,
    { branch: 'professional', electronicOnly: true },
  ),

  // Calculated result lines are retained as review-output mappings. They are
  // not falsely presented as physical input controls on the ESt1A paper form.
  output('incomeFromEmployment', 'Income from employment'),
  output('incomeFromBusiness', 'Income from sole-proprietor activity'),
  output('totalIncome', 'Total income'),
  output('specialDeductions', 'Special deductions'),
  output('taxableIncome', 'Taxable income after statutory floor'),
  output('incomeTax', 'Income tax after §35 credit where applicable'),
  output('solidaritySurcharge', 'Solidarity surcharge'),
  output('incomeTaxWithheld', 'Income-tax withholding'),
  output('soliWithheld', 'Solidarity-surcharge withholding'),
  output('incomeTaxAdvances', 'Income-tax advances'),
  output('soliAdvances', 'Solidarity-surcharge advances'),
  output('balanceDue', 'Balance due'),
  output('refund', 'Refund'),
]) as readonly Germany2025FormField[];

// Short aliases make the country-owned inventory discoverable without adding
// a shared registry entry or activating the candidate.
export const GERMANY_2025_FIELD_CATALOG = GERMANY_2025_FORM_FIELD_CATALOG;

const valuesByKey = (
  evaluation: FinanceTaxEvaluation,
): Map<
  string,
  FinanceTaxEvaluation['forms'][number]['fields'][number]['value']
> =>
  new Map<
    string,
    FinanceTaxEvaluation['forms'][number]['fields'][number]['value']
  >(
    evaluation.forms.flatMap((form) =>
      form.fields.map(
        (field) => [`${form.id}.${field.key}`, field.value] as const,
      ),
    ),
  );

const factMap = (intake: FinanceTaxIntake) =>
  new Map(intake.facts.map((fact) => [fact.key, fact]));

const reviewedValue = (
  facts: ReturnType<typeof factMap>,
  key: string,
): string | boolean | null => {
  const fact = facts.get(key);
  if (!fact || fact.reviewState !== 'reviewed') return null;
  return fact.value.value;
};

const isReviewedBoolean = (
  facts: ReturnType<typeof factMap>,
  key: string,
  value: boolean,
) => reviewedValue(facts, key) === value;

const isReviewedText = (
  facts: ReturnType<typeof factMap>,
  key: string,
  value: string,
) => reviewedValue(facts, key) === value;

const isZeroDecimal = (facts: ReturnType<typeof factMap>, key: string) => {
  const value = reviewedValue(facts, key);
  return typeof value === 'string' && /^0(?:\.0+)?$/.test(value);
};

const branchResult = (
  branch: Branch | undefined,
  facts: ReturnType<typeof factMap>,
): { inapplicable: boolean; predicate: string; sourceFactKeys: string[] } => {
  if (!branch || branch === 'all')
    return {
      inapplicable: false,
      predicate: 'applicable to selected form scope',
      sourceFactKeys: [],
    };
  if (branch === 'single')
    return {
      inapplicable: isReviewedText(facts, 'filingStatus', 'single'),
      predicate: 'filingStatus=single',
      sourceFactKeys: ['filingStatus'],
    };
  const branches: Record<
    Exclude<Branch, 'all' | 'single' | 'professional' | 'trade'>,
    readonly [string, boolean, string]
  > = {
    'one-employer': [
      'employment.multipleEmployers',
      false,
      'employment.multipleEmployers=false',
    ],
    'no-special-wages': [
      'employment.specialWages',
      false,
      'employment.specialWages=false',
    ],
    'no-income-replacement': [
      'employment.incomeReplacement',
      false,
      'employment.incomeReplacement=false',
    ],
    'no-foreign-income': [
      'employment.foreignIncome',
      false,
      'employment.foreignIncome=false',
    ],
    'no-church-tax': [
      'churchTax.member',
      false,
      'churchTax.member=false and employment.churchTaxWithheld=0',
    ],
    'no-private-insurance': [
      'insurance.privateOrOther',
      false,
      'insurance.privateOrOther=false',
    ],
    'no-additional-pension': [
      'insurance.pensionAdditional',
      false,
      'insurance.pensionAdditional=0',
    ],
  };
  if (branch === 'professional' || branch === 'trade') {
    return {
      inapplicable:
        reviewedValue(facts, 'business.kind') !== null &&
        !isReviewedText(facts, 'business.kind', branch),
      predicate: `business.kind=${branch}`,
      sourceFactKeys: ['business.kind'],
    };
  }
  const [key, expected, predicate] = branches[branch];
  let inapplicable = isReviewedBoolean(facts, key, expected);
  if (branch === 'no-church-tax')
    inapplicable =
      inapplicable && isZeroDecimal(facts, 'employment.churchTaxWithheld');
  return { inapplicable, predicate, sourceFactKeys: [key] };
};

const exactHasWholeEuroFraction = (trace: Germany2025TraceLike | undefined) => {
  if (!trace?.exactNumerator || !trace.exactDenominator) return false;
  try {
    return BigInt(trace.exactNumerator) % BigInt(trace.exactDenominator) !== 0n;
  } catch {
    return true;
  }
};

const sourceFactsForTrace = (trace: Germany2025TraceLike | undefined) =>
  trace?.sourceFactKeys ? [...trace.sourceFactKeys] : [];

/**
 * Classify every country-owned field against reviewed facts and the exact
 * working-paper graph.  The function reports unresolved controls instead of
 * converting missing facts to zero.  It accepts either the Germany trace as
 * its third argument or the US-style `(requiredKeys, trace)` shape so callers
 * can use the same review harness without changing shared contracts.
 */
export function buildGermany2025FieldCoverage(
  intake: FinanceTaxIntake,
  evaluation: FinanceTaxEvaluation,
  traceOrRequiredKeys:
    readonly Germany2025TraceLike[] | ReadonlySet<string> = [],
  rawTrace: readonly Germany2025TraceLike[] = [],
) {
  const trace = Array.isArray(traceOrRequiredKeys)
    ? traceOrRequiredKeys
    : rawTrace;
  const facts = factMap(intake);
  const values = valuesByKey(evaluation);
  const traceByKey = new Map<string, Germany2025TraceLike>(
    trace.map((row) => [`${row.formId}.${row.line}`, row] as const),
  );
  const decisions = GERMANY_2025_FORM_FIELD_CATALOG.map((field) => {
    const branch = branchResult(field.branch, facts);
    const logicalKey = field.logicalKey;
    const row = logicalKey ? traceByKey.get(logicalKey) : undefined;
    const calculated = logicalKey ? values.get(logicalKey) : undefined;
    const directFact = field.factKey ? facts.get(field.factKey) : undefined;
    const sourceFactKeys = [
      ...new Set([
        ...branch.sourceFactKeys,
        ...(field.factKey ? [field.factKey] : []),
        ...sourceFactsForTrace(row),
      ]),
    ];
    let status: Germany2025FieldStatus;
    let value: string | boolean | null = null;
    let predicate = branch.predicate;
    let calculationKey: string | null = logicalKey ?? null;

    const requestedIncomeTaxReturn =
      intake.requestedFeatures.length === 1 &&
      intake.requestedFeatures[0] === 'income-tax-return';
    const isIncomeTaxSelection =
      field.formId === 'ESt1A' && field.fieldId === 'k1';
    const isUnrequestedSelection =
      field.formId === 'ESt1A' &&
      ['k2', 'k4', 'k7'].includes(field.fieldId ?? '');
    if (isIncomeTaxSelection && requestedIncomeTaxReturn) {
      status = 'populated';
      value = true;
      predicate = 'requestedFeatures contains only income-tax-return';
      sourceFactKeys.length = 0;
      calculationKey = null;
    } else if (isUnrequestedSelection && requestedIncomeTaxReturn) {
      status = 'inapplicable';
      predicate = 'requestedFeatures explicitly excludes this ESt1A request';
      sourceFactKeys.length = 0;
      calculationKey = null;
    } else if (branch.inapplicable) {
      status = 'inapplicable';
      predicate = `${branch.predicate}; explicit reviewed exclusion`;
      calculationKey = null;
    } else if (field.factKey) {
      if (!directFact || directFact.reviewState !== 'reviewed') {
        status = 'user-required';
        predicate = `reviewed ${field.factKey} required`;
      } else {
        value = directFact.value.value;
        if (
          field.precision === 'whole-euro' &&
          directFact.value.type === 'decimal' &&
          /\.[0-9]*[1-9]/.test(directFact.value.value)
        ) {
          status = 'unresolved';
          predicate = `${field.factKey} has cents but ${field.formId}.${field.fieldId} is whole-euro; statutory reporting conversion is unresolved`;
        } else {
          status = 'populated';
          predicate = `reviewed ${field.factKey}`;
        }
      }
    } else if (calculated !== undefined) {
      value = calculated.value;
      if (
        field.actualField &&
        field.precision === 'whole-euro' &&
        exactHasWholeEuroFraction(row)
      ) {
        status = 'unresolved';
        predicate = `${logicalKey} has a fractional exact intermediate and the captured field is whole-euro`;
      } else {
        status = 'populated';
        predicate = `calculated ${logicalKey} from the source-bound graph`;
      }
    } else if (field.electronicOnly && logicalKey) {
      status = 'unresolved';
      predicate = `${logicalKey} is applicable but the official 2025 electronic field path is not captured`;
    } else {
      status = field.actualField ? 'user-required' : 'unresolved';
      predicate = field.actualField
        ? `reviewed input for ${field.formId}.${field.fieldId} required`
        : `no source-bound value for ${field.formId}.${field.line}`;
    }

    // A direct decimal field still needs its exact cent precision checked even
    // when its graph counterpart was not emitted because input was blocked.
    if (
      status === 'populated' &&
      field.precision === 'euro-cent' &&
      field.actualField &&
      directFact?.value.type === 'decimal' &&
      directFact.value.value.split('.')[1]?.length! > 2
    ) {
      status = 'unresolved';
      predicate = `${field.factKey} exceeds captured euro-cent precision`;
    }

    return {
      ...field,
      status,
      value,
      predicate,
      sourceFactKeys,
      calculationKey,
    } satisfies Germany2025FieldDecision;
  });
  const unresolved = decisions.filter(
    (field) =>
      field.status === 'unresolved' || field.status === 'user-required',
  );
  const sourceRefs = GERMANY_2025_SOURCES.filter((reference) =>
    new Set(decisions.map((field) => field.sourceId)).has(reference.id),
  );
  return deepFreeze({
    version: '2025.1-official-form-field-coverage',
    proof: 'official-fms-2025-captures-and-elster-2025-applicability',
    complete: false as const,
    fields: decisions,
    unresolved,
    unresolvedFields: unresolved,
    sourceRefs,
    summary: {
      total: decisions.length,
      populated: decisions.filter((field) => field.status === 'populated')
        .length,
      inapplicable: decisions.filter((field) => field.status === 'inapplicable')
        .length,
      userRequired: decisions.filter(
        (field) => field.status === 'user-required',
      ).length,
      unresolved: decisions.filter((field) => field.status === 'unresolved')
        .length,
    },
    blockers: [
      'review-only-export-no-filing-or-electronic-submission',
      'identity-and-preparer-fields-are-not-part-of-the-bounded-intake',
      'anlage-g-and-anlage-s-electronic-field-paths-not-captured',
      'remaining-conditional-schedule-fields-require-explicit-reviewed-facts',
    ],
  });
}

export type Germany2025FieldCoverage = ReturnType<
  typeof buildGermany2025FieldCoverage
>;

export const buildGermany2025FormFieldCoverage = buildGermany2025FieldCoverage;
