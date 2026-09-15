import { z } from 'zod';
import type { CorporateXfaField } from './xfa-inventory.js';
import { encodeCorporateFieldLosslessly } from './reporting.js';

/** Only explicit XFA constraints are enforced. No invented name length,
 * national-ID checksum, character whitelist or filing-software rule. */
export function validateCorporateFieldValue(
  field: CorporateXfaField,
  value: unknown,
) {
  const checks: { rule: string; valid: boolean }[] = [];
  const assist = field.assist ?? '';
  const isDate = /Year 4 digits. Month 2 digits. Day 2 digits/.test(assist);
  const check = (rule: string, valid: boolean) => checks.push({ rule, valid });
  if (typeof value === 'boolean') check('checkbox-selected-state', true);
  else if (typeof value === 'string') {
    const controlValue = isDate ? value.replace(/-/g, '') : value;
    if (field.maxChars !== null)
      check(
        `XFA maxChars=${field.maxChars}`,
        controlValue.length <= field.maxChars,
      );
    if (field.combCells !== null)
      check(
        `XFA comb numberOfCells=${field.combCells}`,
        controlValue.length <= field.combCells,
      );
    if (/Sequence number. 2 numbers/.test(assist))
      check('two-digit sequence', /^\d{2}$/.test(value));
    else if (field.decimalPlaces !== null && field.maxIntegerDigits !== null) {
      let valid = false;
      try {
        valid =
          encodeCorporateFieldLosslessly(value, field).status ===
          'lossless-at-proven-precision';
      } catch {
        /* Malformed supplied value fails the numeric control. */
      }
      check('XFA numeric control precision and range', valid);
    } else if (/9 digits, 2 letters, and 4 digits/.test(assist))
      check(
        '9 digits + 2 program letters + 4 digits',
        /^\d{9}[A-Z]{2}\d{4}$/.test(value),
      );
    else if (/First 9 digits|Social insurance number. 9 digits/.test(assist))
      check('exactly nine digits', /^\d{9}$/.test(value));
    else if (/Last 4 digits/.test(assist))
      check('exactly four digits', /^\d{4}$/.test(value));
    else if (/Telephone.*10 digits/.test(assist))
      check('exactly ten digits', /^\d{10}$/.test(value));
    else if (/Year 4 digits. Month 2 digits. Day 2 digits/.test(assist))
      check(
        'calendar date with four-digit year, two-digit month/day',
        z.iso.date().safeParse(value).success,
      );
    else if (/Field [Cc]ode. Row/.test(assist))
      check('four-digit GIFI field code', /^\d{4}$/.test(value));
  }
  return {
    status: checks.some((c) => !c.valid)
      ? 'invalid'
      : checks.length
        ? 'proven-rules-pass'
        : 'rules-unresolved',
    checks,
    complete: false as const,
  };
}
