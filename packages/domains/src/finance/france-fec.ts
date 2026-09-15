import { formatFinanceDecimal, parseFinanceDecimal } from './decimal.js';

/**
 * The standard flat-file FEC layout required by LPF article A. 47 A-1,
 * article VII.  The first eighteen columns are deliberately kept in this
 * file instead of being inferred from a report mapping: their order is part
 * of the French legal format.
 */
export const FRANCE_FEC_COLUMNS = [
  'JournalCode',
  'JournalLib',
  'EcritureNum',
  'EcritureDate',
  'CompteNum',
  'CompteLib',
  'CompAuxNum',
  'CompAuxLib',
  'PieceRef',
  'PieceDate',
  'EcritureLib',
  'Debit',
  'Credit',
  'EcritureLet',
  'DateLet',
  'ValidDate',
  'Montantdevise',
  'Idevise',
] as const;

export type FranceFecColumn = (typeof FRANCE_FEC_COLUMNS)[number];

export const FRANCE_FEC_VERSION = 'france-fec.v1';

export const FRANCE_FEC_STANDARD = Object.freeze({
  article: 'LPF A. 47 A-1',
  format: 'flat-file',
  separator: '\t',
  separatorName: 'tab',
  encoding: 'UTF-8',
  lineEnding: '\r\n',
  lineEndingName: 'CRLF',
  headerRequired: true,
  currency: 'EUR',
});

export const FRANCE_FEC_SOURCE_REFERENCES = Object.freeze({
  article:
    'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000027804775',
  dgFiP:
    'https://www.impots.gouv.fr/fichiers-standards-des-ecritures-comptables',
  doctrine:
    'https://bofip.impots.gouv.fr/bofip/9028-PGP.html/identifiant=BOI-CF-IOR-60-40-20-20170607',
});

export type FranceFecSourceLineage = {
  /** Stable persisted identifier for the source journal line. */
  sourceReference: string;
  /** SHA-256 of the reviewed source record/evidence. */
  sourceDigest: string;
};

export type FranceFecEntity = {
  /** SIREN is a legal identifier and is never derived from a workspace ID. */
  siren: string;
  sirenSource: FranceFecSourceLineage;
};

export type FranceFecOpeningBalancePolicy =
  | {
      status: 'included';
      source: FranceFecSourceLineage;
    }
  | {
      /** Explicitly reviewed for a newly-created entity with no prior balance. */
      status: 'not-applicable';
      source: FranceFecSourceLineage;
    };

export type FranceFecEntryKind =
  'opening' | 'normal' | 'inventory' | 'centralization' | 'closing';

export type FranceFecForeignAmount = {
  amount: string;
  currency: string;
};

export type FranceFecLineInput = {
  lineId: string;
  accountNumber: string;
  accountLabel: string;
  auxiliaryAccountNumber?: string | null;
  auxiliaryAccountLabel?: string | null;
  debit: string;
  credit: string;
  lettering?: string | null;
  letteringDate?: string | null;
  foreign?: FranceFecForeignAmount | null;
  source: FranceFecSourceLineage;
};

export type FranceFecEntryInput = {
  entryId: string;
  /** Persisted continuity ordinal. It must be exactly 1..N in output order. */
  sequence: number;
  /** The accounting system's legal EcritureNum value. */
  entryNumber: string;
  kind: FranceFecEntryKind;
  journalCode: string;
  journalLabel: string;
  accountingDate: string;
  pieceReference: string;
  pieceDate: string;
  label: string;
  validationDate: string;
  lines: readonly FranceFecLineInput[];
};

export type FranceFecInput = {
  entity: FranceFecEntity;
  period: { startsOn: string; endsOn: string };
  /** FEC functional amounts are represented in euros. */
  functionalCurrency: 'EUR';
  openingBalances: FranceFecOpeningBalancePolicy;
  entries: readonly FranceFecEntryInput[];
};

export type FranceFecIssue = {
  code: string;
  path: string;
  message: string;
};

export type FranceFecLineageRecord = FranceFecSourceLineage & {
  entryId: string;
  entryNumber: string;
  lineId: string;
  pieceReference: string;
};

export type FranceFecReview = {
  status: 'ready' | 'blocked';
  errors: readonly FranceFecIssue[];
  entryCount: number;
  lineCount: number;
  sourceLineage: readonly FranceFecLineageRecord[];
  fileName: string | null;
  standard: typeof FRANCE_FEC_STANDARD;
};

export type FranceFecExport =
  | {
      status: 'blocked';
      review: FranceFecReview;
      file: null;
    }
  | {
      status: 'ready';
      review: FranceFecReview;
      file: {
        fileName: string;
        content: string;
        byteLength: number;
        columns: readonly FranceFecColumn[];
        encoding: 'UTF-8';
        separator: '\t';
        lineEnding: '\r\n';
      };
      sourceLineage: readonly FranceFecLineageRecord[];
    };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}

function nonEmptyText(value: unknown): value is string {
  return text(value) && value.trim().length > 0;
}

function hasForbiddenControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function source(value: unknown): value is FranceFecSourceLineage {
  if (!isRecord(value)) return false;
  return (
    nonEmptyText(value.sourceReference) &&
    text(value.sourceDigest) &&
    /^[a-f0-9]{64}$/u.test(value.sourceDigest)
  );
}

function isoDate(value: unknown): value is string {
  if (!text(value) || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= days[month - 1]!;
}

function pathIndex(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

function add(
  issues: FranceFecIssue[],
  code: string,
  path: string,
  message: string,
) {
  issues.push({ code, path, message });
}

function validateText(
  value: unknown,
  path: string,
  issues: FranceFecIssue[],
  options: { required?: boolean } = {},
): value is string {
  const required = options.required ?? true;
  if (!text(value)) {
    add(issues, 'france-fec-text-invalid', path, 'Expected a text value.');
    return false;
  }
  if (required && value.trim().length === 0) {
    add(
      issues,
      'france-fec-required-field-missing',
      path,
      'A value is required.',
    );
    return false;
  }
  if (hasForbiddenControl(value)) {
    add(
      issues,
      'france-fec-field-control-character',
      path,
      'FEC fields cannot contain control characters because the tab-separated structure would be ambiguous.',
    );
    return false;
  }
  return true;
}

function validateDate(
  value: unknown,
  path: string,
  issues: FranceFecIssue[],
  options: { required?: boolean } = {},
): value is string {
  if (value === null || value === undefined || value === '') {
    if (options.required === false) return true;
    add(issues, 'france-fec-date-missing', path, 'A date is required.');
    return false;
  }
  if (!isoDate(value)) {
    add(
      issues,
      'france-fec-date-invalid',
      path,
      'Expected a valid ISO calendar date (YYYY-MM-DD).',
    );
    return false;
  }
  return true;
}

function exactAmount(
  value: unknown,
  path: string,
  issues: FranceFecIssue[],
): bigint | null {
  if (!text(value)) {
    add(
      issues,
      'france-fec-amount-invalid',
      path,
      'Expected an exact decimal string.',
    );
    return null;
  }
  try {
    return parseFinanceDecimal(value);
  } catch {
    add(
      issues,
      'france-fec-amount-invalid',
      path,
      'Amounts must be canonical decimal strings with no exponent or grouping separator and at most twelve fractional places.',
    );
    return null;
  }
}

function dateForFec(value: string): string {
  return value.replaceAll('-', '');
}

function numberForFec(value: string): string {
  return formatFinanceDecimal(parseFinanceDecimal(value)).replace('.', ',');
}

function emptyOptional(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function sortIssues(issues: FranceFecIssue[]): FranceFecIssue[] {
  return issues.sort((left, right) =>
    `${left.path}\u0000${left.code}`.localeCompare(
      `${right.path}\u0000${right.code}`,
    ),
  );
}

function safeFileName(siren: string, endsOn: string): string {
  return `${siren}FEC${dateForFec(endsOn)}.txt`;
}

function validateInput(value: unknown): {
  input: FranceFecInput | null;
  review: FranceFecReview;
} {
  const issues: FranceFecIssue[] = [];
  const lineage: FranceFecLineageRecord[] = [];
  if (!isRecord(value)) {
    add(
      issues,
      'france-fec-input-invalid',
      '$',
      'Expected a structured FEC input object.',
    );
    return {
      input: null,
      review: {
        status: 'blocked',
        errors: sortIssues(issues),
        entryCount: 0,
        lineCount: 0,
        sourceLineage: lineage,
        fileName: null,
        standard: FRANCE_FEC_STANDARD,
      },
    };
  }

  const entity = isRecord(value.entity) ? value.entity : null;
  const siren = entity?.siren;
  const sirenSource = entity?.sirenSource;
  if (!text(siren) || !/^\d{9}$/u.test(siren))
    add(
      issues,
      'france-fec-siren-invalid',
      'entity.siren',
      'SIREN must be exactly nine digits and must be supplied by an authoritative legal-entity source.',
    );
  if (!source(sirenSource))
    add(
      issues,
      'france-fec-siren-source-missing',
      'entity.sirenSource',
      'The SIREN source reference and digest are required; the identifier cannot be inferred.',
    );

  const period = isRecord(value.period) ? value.period : null;
  const startsOn = period?.startsOn;
  const endsOn = period?.endsOn;
  const startsValid = validateDate(startsOn, 'period.startsOn', issues);
  const endsValid = validateDate(endsOn, 'period.endsOn', issues);
  if (startsValid && endsValid && startsOn > endsOn)
    add(
      issues,
      'france-fec-period-invalid',
      'period',
      'The fiscal period ends before it starts.',
    );
  if (value.functionalCurrency !== 'EUR')
    add(
      issues,
      'france-fec-functional-currency-invalid',
      'functionalCurrency',
      'The standard FEC Debit and Credit columns must be expressed in EUR.',
    );

  const opening = isRecord(value.openingBalances)
    ? value.openingBalances
    : null;
  if (opening?.status !== 'included' && opening?.status !== 'not-applicable')
    add(
      issues,
      'france-fec-opening-policy-missing',
      'openingBalances.status',
      'The opening-balance policy must be explicitly reviewed as included or not-applicable.',
    );
  if (!source(opening?.source))
    add(
      issues,
      'france-fec-opening-policy-source-missing',
      'openingBalances.source',
      'The opening-balance policy needs a source reference and digest.',
    );

  const rawEntries = value.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    add(
      issues,
      'france-fec-entries-missing',
      'entries',
      'At least one posted accounting entry is required.',
    );
  }

  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  const attemptedEntryCount = entries.length;
  const attemptedLineCount = entries.reduce(
    (total, entry) =>
      total +
      (isRecord(entry) && Array.isArray(entry.lines) ? entry.lines.length : 0),
    0,
  );
  const normalizedEntries: FranceFecEntryInput[] = [];
  const entryIds = new Set<string>();
  const entryNumbers = new Set<string>();
  const lineIds = new Set<string>();

  entries.forEach((rawEntry, entryIndex) => {
    const entryPath = pathIndex('entries', entryIndex);
    if (!isRecord(rawEntry)) {
      add(
        issues,
        'france-fec-entry-invalid',
        entryPath,
        'Expected an entry object.',
      );
      return;
    }
    const entryId = rawEntry.entryId;
    const entryNumber = rawEntry.entryNumber;
    const sequence = rawEntry.sequence;
    const kind = rawEntry.kind;
    const journalCode = rawEntry.journalCode;
    const journalLabel = rawEntry.journalLabel;
    const accountingDate = rawEntry.accountingDate;
    const pieceReference = rawEntry.pieceReference;
    const pieceDate = rawEntry.pieceDate;
    const label = rawEntry.label;
    const validationDate = rawEntry.validationDate;

    if (!validateText(entryId, `${entryPath}.entryId`, issues)) {
      // Continue validating sibling fields to keep the review actionable.
    } else if (entryIds.has(entryId)) {
      add(
        issues,
        'france-fec-entry-id-duplicate',
        `${entryPath}.entryId`,
        'Entry identifiers must be unique.',
      );
    } else entryIds.add(entryId);
    if (!validateText(entryNumber, `${entryPath}.entryNumber`, issues)) {
      // no-op
    } else if (entryNumbers.has(entryNumber.trim())) {
      add(
        issues,
        'france-fec-entry-number-duplicate',
        `${entryPath}.entryNumber`,
        'EcritureNum values must be unique.',
      );
    } else entryNumbers.add(entryNumber.trim());
    if (
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    )
      add(
        issues,
        'france-fec-entry-sequence-invalid',
        `${entryPath}.sequence`,
        'The continuity ordinal must be a positive safe integer.',
      );
    if (
      !['opening', 'normal', 'inventory', 'centralization', 'closing'].includes(
        kind as string,
      )
    )
      add(
        issues,
        'france-fec-entry-kind-invalid',
        `${entryPath}.kind`,
        'Unsupported entry kind.',
      );
    if (kind === 'centralization' || kind === 'closing')
      add(
        issues,
        'france-fec-entry-kind-excluded',
        `${entryPath}.kind`,
        'Centralization and account-closing entries are excluded from the standard FEC.',
      );
    validateText(journalCode, `${entryPath}.journalCode`, issues);
    validateText(journalLabel, `${entryPath}.journalLabel`, issues);
    const accountingDateValid = validateDate(
      accountingDate,
      `${entryPath}.accountingDate`,
      issues,
    );
    validateText(pieceReference, `${entryPath}.pieceReference`, issues);
    validateDate(pieceDate, `${entryPath}.pieceDate`, issues);
    validateText(label, `${entryPath}.label`, issues);
    const validationDateValid = validateDate(
      validationDate,
      `${entryPath}.validationDate`,
      issues,
    );
    if (
      accountingDateValid &&
      startsValid &&
      endsValid &&
      (accountingDate < startsOn || accountingDate > endsOn)
    )
      add(
        issues,
        'france-fec-accounting-date-outside-period',
        `${entryPath}.accountingDate`,
        'The accounting date must be within the exported fiscal period.',
      );
    if (
      accountingDateValid &&
      validationDateValid &&
      validationDate < accountingDate
    )
      add(
        issues,
        'france-fec-validation-date-before-accounting-date',
        `${entryPath}.validationDate`,
        'Validation cannot precede the accounting date.',
      );

    const rawLines = rawEntry.lines;
    if (!Array.isArray(rawLines) || rawLines.length < 2)
      add(
        issues,
        'france-fec-entry-lines-insufficient',
        `${entryPath}.lines`,
        'Each entry needs at least two journal lines.',
      );
    const lines: FranceFecLineInput[] = [];
    let debitTotal = 0n;
    let creditTotal = 0n;
    let hasValidTotals = true;
    (Array.isArray(rawLines) ? rawLines : []).forEach((rawLine, lineIndex) => {
      const linePath = `${entryPath}.lines[${lineIndex}]`;
      if (!isRecord(rawLine)) {
        add(
          issues,
          'france-fec-line-invalid',
          linePath,
          'Expected a journal-line object.',
        );
        hasValidTotals = false;
        return;
      }
      const lineId = rawLine.lineId;
      const accountNumber = rawLine.accountNumber;
      const accountLabel = rawLine.accountLabel;
      const auxiliaryAccountNumber = rawLine.auxiliaryAccountNumber;
      const auxiliaryAccountLabel = rawLine.auxiliaryAccountLabel;
      const lettering = rawLine.lettering;
      const letteringDate = rawLine.letteringDate;
      const debit = rawLine.debit;
      const credit = rawLine.credit;
      const foreign = rawLine.foreign;
      const lineSource = rawLine.source;

      if (!validateText(lineId, `${linePath}.lineId`, issues)) {
        // no-op
      } else if (lineIds.has(lineId)) {
        add(
          issues,
          'france-fec-line-id-duplicate',
          `${linePath}.lineId`,
          'Journal-line identifiers must be unique.',
        );
      } else lineIds.add(lineId);
      if (!validateText(accountNumber, `${linePath}.accountNumber`, issues)) {
        // no-op
      } else if (!/^\d{3}/u.test(accountNumber.trim())) {
        add(
          issues,
          'france-fec-account-number-invalid',
          `${linePath}.accountNumber`,
          'The first three account characters must be digits under the French chart-of-accounts rule.',
        );
      }
      validateText(accountLabel, `${linePath}.accountLabel`, issues);
      const auxNumberEmpty = emptyOptional(auxiliaryAccountNumber);
      const auxLabelEmpty = emptyOptional(auxiliaryAccountLabel);
      if (auxNumberEmpty !== auxLabelEmpty)
        add(
          issues,
          'france-fec-auxiliary-account-pair-incomplete',
          linePath,
          'CompAuxNum and CompAuxLib must be supplied together or both left blank.',
        );
      else {
        if (!auxNumberEmpty)
          validateText(
            auxiliaryAccountNumber,
            `${linePath}.auxiliaryAccountNumber`,
            issues,
          );
        if (!auxLabelEmpty)
          validateText(
            auxiliaryAccountLabel,
            `${linePath}.auxiliaryAccountLabel`,
            issues,
          );
      }
      const parsedDebit = exactAmount(debit, `${linePath}.debit`, issues);
      const parsedCredit = exactAmount(credit, `${linePath}.credit`, issues);
      if (parsedDebit !== null && parsedCredit !== null) {
        if (parsedDebit < 0n || parsedCredit < 0n)
          add(
            issues,
            'france-fec-debit-credit-negative',
            linePath,
            'Debit and Credit must be non-negative functional-currency amounts.',
          );
        if (parsedDebit === 0n && parsedCredit === 0n)
          add(
            issues,
            'france-fec-line-zero',
            linePath,
            'A journal line must carry a non-zero Debit or Credit amount.',
          );
        if (parsedDebit > 0n && parsedCredit > 0n)
          add(
            issues,
            'france-fec-line-both-sides',
            linePath,
            'A journal line cannot carry both Debit and Credit.',
          );
        debitTotal += parsedDebit;
        creditTotal += parsedCredit;
      } else hasValidTotals = false;
      const letteringEmpty = emptyOptional(lettering);
      if (!letteringEmpty)
        validateText(lettering, `${linePath}.lettering`, issues);
      if (letteringEmpty) {
        if (!emptyOptional(letteringDate))
          add(
            issues,
            'france-fec-lettering-date-without-lettering',
            `${linePath}.letteringDate`,
            'DateLet is only valid when EcritureLet is supplied.',
          );
      } else validateDate(letteringDate, `${linePath}.letteringDate`, issues);
      if (!source(lineSource))
        add(
          issues,
          'france-fec-source-reference-missing',
          `${linePath}.source`,
          'Every exported line needs a source reference and SHA-256 digest.',
        );
      const foreignObject =
        foreign === null || foreign === undefined ? null : foreign;
      if (foreignObject !== null) {
        if (!isRecord(foreignObject)) {
          add(
            issues,
            'france-fec-foreign-amount-invalid',
            `${linePath}.foreign`,
            'Foreign amount must be an amount/currency pair.',
          );
        } else {
          const foreignAmount = exactAmount(
            foreignObject.amount,
            `${linePath}.foreign.amount`,
            issues,
          );
          const foreignCurrency = foreignObject.currency;
          if (!text(foreignCurrency) || !/^[A-Z]{3}$/u.test(foreignCurrency))
            add(
              issues,
              'france-fec-foreign-currency-invalid',
              `${linePath}.foreign.currency`,
              'Foreign currency must be a three-letter uppercase ISO code.',
            );
          if (foreignAmount !== null && foreignCurrency === 'EUR')
            add(
              issues,
              'france-fec-foreign-currency-functional',
              `${linePath}.foreign.currency`,
              'EUR must remain in the functional Debit/Credit columns; Montantdevise is for foreign currency.',
            );
        }
      }
      if (
        source(lineSource) &&
        nonEmptyText(entryId) &&
        nonEmptyText(entryNumber) &&
        nonEmptyText(pieceReference) &&
        nonEmptyText(lineId)
      )
        lineage.push({
          entryId,
          entryNumber,
          lineId: lineId as string,
          pieceReference,
          sourceReference: lineSource.sourceReference,
          sourceDigest: lineSource.sourceDigest,
        });
      if (hasValidTotals && parsedDebit !== null && parsedCredit !== null) {
        // Totals are checked after all lines have been inspected.
      }
      lines.push({
        lineId: lineId as string,
        accountNumber: accountNumber as string,
        accountLabel: accountLabel as string,
        auxiliaryAccountNumber:
          (auxiliaryAccountNumber as string | null | undefined) ?? null,
        auxiliaryAccountLabel:
          (auxiliaryAccountLabel as string | null | undefined) ?? null,
        debit: debit as string,
        credit: credit as string,
        lettering: (lettering as string | null | undefined) ?? null,
        letteringDate: (letteringDate as string | null | undefined) ?? null,
        foreign: foreignObject as FranceFecForeignAmount | null,
        source: lineSource as FranceFecSourceLineage,
      });
    });
    if (hasValidTotals && debitTotal !== creditTotal)
      add(
        issues,
        'france-fec-entry-unbalanced',
        `${entryPath}.lines`,
        'Every FEC entry must balance exactly in functional EUR amounts.',
      );

    if (
      nonEmptyText(entryId) &&
      nonEmptyText(entryNumber) &&
      typeof sequence === 'number' &&
      Number.isSafeInteger(sequence) &&
      sequence >= 1 &&
      ['opening', 'normal', 'inventory', 'centralization', 'closing'].includes(
        kind as string,
      ) &&
      nonEmptyText(journalCode) &&
      nonEmptyText(journalLabel) &&
      isoDate(accountingDate) &&
      nonEmptyText(pieceReference) &&
      isoDate(pieceDate) &&
      nonEmptyText(label) &&
      isoDate(validationDate)
    ) {
      normalizedEntries.push({
        entryId,
        sequence,
        entryNumber,
        kind: kind as FranceFecEntryKind,
        journalCode,
        journalLabel,
        accountingDate,
        pieceReference,
        pieceDate,
        label,
        validationDate,
        lines,
      });
    }
  });

  const bySequence = [...normalizedEntries].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const seenSequences = new Set<number>();
  bySequence.forEach((entry, index) => {
    if (seenSequences.has(entry.sequence))
      add(
        issues,
        'france-fec-entry-sequence-duplicate',
        `entries[${index}].sequence`,
        'Continuity ordinals must be unique.',
      );
    seenSequences.add(entry.sequence);
    if (entry.sequence !== index + 1)
      add(
        issues,
        'france-fec-entry-sequence-not-continuous',
        `entries[${index}].sequence`,
        'FEC entry sequence must be exactly 1..N with no gaps.',
      );
    if (
      index > 0 &&
      entry.validationDate < bySequence[index - 1]!.validationDate
    )
      add(
        issues,
        'france-fec-validation-order-invalid',
        `entries[${index}].validationDate`,
        'Entries must be ordered by non-decreasing validation date.',
      );
  });

  const openingEntries = bySequence.filter((entry) => entry.kind === 'opening');
  const nonOpeningBeforeOpening = bySequence.some(
    (entry, index) =>
      entry.kind === 'opening' &&
      bySequence
        .slice(0, index)
        .some((previous) => previous.kind !== 'opening'),
  );
  if (opening?.status === 'included' && openingEntries.length === 0)
    add(
      issues,
      'france-fec-opening-entries-missing',
      'entries',
      'The reviewed policy says opening balances are included, but no opening entry was supplied.',
    );
  if (opening?.status === 'not-applicable' && openingEntries.length > 0)
    add(
      issues,
      'france-fec-opening-entries-unexpected',
      'entries',
      'Opening entries cannot be emitted when the reviewed policy says they are not applicable.',
    );
  if (nonOpeningBeforeOpening)
    add(
      issues,
      'france-fec-opening-entries-not-first',
      'entries',
      'Opening entries must be the first entries in the FEC sequence.',
    );

  const errorList = sortIssues(issues);
  const fileName =
    text(siren) && /^\d{9}$/u.test(siren) && isoDate(endsOn)
      ? safeFileName(siren, endsOn)
      : null;
  const review: FranceFecReview = {
    status: errorList.length === 0 ? 'ready' : 'blocked',
    errors: errorList,
    entryCount: attemptedEntryCount,
    lineCount: attemptedLineCount,
    sourceLineage: lineage,
    fileName: errorList.length === 0 ? fileName : null,
    standard: FRANCE_FEC_STANDARD,
  };
  if (
    errorList.length !== 0 ||
    !isRecord(value.entity) ||
    !isRecord(value.period) ||
    !Array.isArray(value.entries)
  )
    return { input: null, review };

  // The runtime checks above are intentionally strict; this cast is reached
  // only when every required FEC property has passed validation.
  return { input: value as unknown as FranceFecInput, review };
}

/**
 * Performs a complete, reviewable validation without producing bytes. Missing
 * legal identifiers, evidence, or accounting mappings remain visible as
 * blocking issues rather than being filled with a UUID, date, or placeholder.
 */
export function reviewFranceFec(input: unknown): FranceFecReview {
  return validateInput(input).review;
}

function renderEntry(entry: FranceFecEntryInput): string[] {
  return entry.lines.map((line) =>
    [
      entry.journalCode.trim(),
      entry.journalLabel.trim(),
      entry.entryNumber.trim(),
      dateForFec(entry.accountingDate),
      line.accountNumber.trim(),
      line.accountLabel.trim(),
      line.auxiliaryAccountNumber?.trim() ?? '',
      line.auxiliaryAccountLabel?.trim() ?? '',
      entry.pieceReference.trim(),
      dateForFec(entry.pieceDate),
      entry.label.trim(),
      numberForFec(line.debit),
      numberForFec(line.credit),
      line.lettering?.trim() ?? '',
      line.letteringDate ? dateForFec(line.letteringDate) : '',
      dateForFec(entry.validationDate),
      line.foreign ? numberForFec(line.foreign.amount) : '',
      line.foreign?.currency ?? '',
    ].join('\t'),
  );
}

/**
 * Creates a deterministic UTF-8, tab-separated FEC only after the complete
 * input has passed validation. A blocked result contains no file content.
 */
export function createFranceFecExport(input: unknown): FranceFecExport {
  const validated = validateInput(input);
  if (validated.review.status === 'blocked' || !validated.input)
    return { status: 'blocked', review: validated.review, file: null };

  const lines = [FRANCE_FEC_COLUMNS.join('\t')];
  for (const entry of [...validated.input.entries].sort(
    (left, right) => left.sequence - right.sequence,
  ))
    lines.push(...renderEntry(entry));
  const content = `${lines.join('\r\n')}\r\n`;
  const byteLength = new TextEncoder().encode(content).byteLength;
  const fileName = validated.review.fileName;
  if (!fileName) {
    // This is unreachable after validation but keeps the no-file invariant
    // explicit if the input type is extended in the future.
    const blockedReview: FranceFecReview = {
      ...validated.review,
      status: 'blocked',
      errors: [
        ...validated.review.errors,
        {
          code: 'france-fec-file-name-unavailable',
          path: 'entity.siren',
          message:
            'A validated SIREN and closing date are required for the FEC filename.',
        },
      ],
      fileName: null,
    };
    return { status: 'blocked', review: blockedReview, file: null };
  }
  return {
    status: 'ready',
    review: validated.review,
    file: {
      fileName,
      content,
      byteLength,
      columns: FRANCE_FEC_COLUMNS,
      encoding: 'UTF-8',
      separator: '\t',
      lineEnding: '\r\n',
    },
    sourceLineage: validated.review.sourceLineage,
  };
}

export const buildFranceFecExport = createFranceFecExport;

/** Naming aliases for repository adapters that use validate/export verbs. */
export const validateFranceFec = reviewFranceFec;
export const exportFranceFec = createFranceFecExport;
