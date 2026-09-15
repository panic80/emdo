import { deepFreeze } from '@emdo/contracts';
import { NY_FIELD_CATALOG_DATA } from './field-catalog-data.js';
export const NY_FIELD_CATALOG: readonly {
  formId: string;
  fieldId: string;
  kind: string;
  label: string;
  maxLength: number | null;
  widgetCount: number;
  states: readonly string[];
  choices: readonly string[];
  sourceId: string;
  sourceHash: string;
}[] = deepFreeze(NY_FIELD_CATALOG_DATA);

export type NyPhysicalFieldDecision = {
  fieldId: string;
  status: 'populated' | 'inapplicable' | 'user-required' | 'unresolved';
  value: string | null;
  reason: string;
  sourceId: string;
  sourceHash: string;
  maxLength: number | null;
  widgetCount: number;
};
/** Limits are the actual published AcroForm limits, not guessed taxpayer-name rules.
 * A missing limit is not permission to truncate or invent a limit. Choice/checkbox
 * values are checked against the published export values. All widget copies share
 * the exact field value; the PDF renderer must preserve each widget.
 */
export function nyPhysicalFieldDecision(
  formId: string,
  fieldId: string,
  value: string | null,
  reason: string,
  absentStatus: NyPhysicalFieldDecision['status'] = 'inapplicable',
): NyPhysicalFieldDecision {
  const field = NY_FIELD_CATALOG.find(
    (entry) => entry.formId === formId && entry.fieldId === fieldId,
  );
  if (!field) throw new Error(`ny-unknown-physical-field:${formId}:${fieldId}`);
  if (value !== null) {
    if (
      [...value].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
      throw new Error(`ny-form-control-character:${fieldId}`);
    if (field.maxLength !== null && value.length > field.maxLength)
      throw new Error(`ny-form-field-length:${fieldId}`);
    if (
      field.states.length &&
      !(field.states as readonly string[]).includes(value)
    )
      throw new Error(`ny-form-checkbox-value:${fieldId}`);
    if (
      field.choices.length &&
      !(field.choices as readonly string[]).includes(value)
    )
      throw new Error(`ny-form-choice-value:${fieldId}`);
  }
  return deepFreeze({
    fieldId,
    status: value === null ? absentStatus : 'populated',
    value,
    reason,
    sourceId: field.sourceId,
    sourceHash: field.sourceHash,
    maxLength: field.maxLength,
    widgetCount: field.widgetCount,
  });
}
