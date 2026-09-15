import {
  imageAllowedFields,
  imageFieldNames,
  imageRequiredFields,
  type ImageDraft,
  type ImageMappingSettings,
} from './finance-image-review-model.js';

export function ImageReviewFields({
  settings,
  bindings,
  draft,
  locked,
  onSettings,
  onBindings,
}: {
  settings: ImageMappingSettings;
  bindings: Record<string, string>;
  draft: ImageDraft;
  locked: boolean;
  onSettings: (value: ImageMappingSettings) => void;
  onBindings: (value: Record<string, string>) => void;
}) {
  const required = imageRequiredFields(settings.reportType),
    fields = imageAllowedFields(settings.reportType);
  const mapped = new Set(
    Object.values(bindings).filter((value) => value !== 'context'),
  );
  const unassigned = draft.headers.flatMap((cell, index) =>
    !mapped.has(String(index))
      ? [cell.reviewedText || `Heading ${index + 1}`]
      : [],
  );
  function change<K extends keyof ImageMappingSettings>(
    key: K,
    value: ImageMappingSettings[K],
  ) {
    onSettings({ ...settings, [key]: value });
  }
  return (
    <section
      aria-label="Image report field meanings"
      className="finance-image-fields-review"
    >
      <span className="finance-image-eyebrow">Meaning and conventions</span>
      <h5>Match the selected source to report fields</h5>
      <p>
        Choose every field deliberately. A heading does not establish its
        financial meaning.
      </p>
      <div className="finance-image-fields">
        <label>
          Report provider
          <input
            value={settings.providerKey}
            disabled={locked}
            maxLength={100}
            onChange={(event) => change('providerKey', event.target.value)}
          />
        </label>
        <label>
          Report name
          <input
            value={settings.reportName}
            disabled={locked}
            maxLength={200}
            onChange={(event) => change('reportName', event.target.value)}
          />
        </label>
        <label>
          Report layout version
          <input
            value={settings.layoutVersion}
            disabled={locked}
            maxLength={100}
            onChange={(event) => change('layoutVersion', event.target.value)}
          />
        </label>
        <label>
          Report section
          <select
            value={settings.reportType}
            disabled={locked}
            onChange={(event) => {
              const reportType = event.target
                .value as ImageMappingSettings['reportType'];
              onSettings({
                ...settings,
                reportType,
                quantityUnit: null,
                valuationMultiplier: null,
                identifierScheme: null,
                identifierNamespace: null,
              });
              onBindings({});
            }}
          >
            <option value="bank-transactions">Account transactions</option>
            <option value="investment-positions">Investment positions</option>
          </select>
        </label>
      </div>
      <div className="finance-image-field-bindings">
        {fields.map((field) => (
          <label key={field}>
            <span>
              {imageFieldNames[field]}
              <small>
                {required.includes(field) ? 'Required' : 'Optional'}
              </small>
            </span>
            <select
              aria-label={`Image mapping: ${imageFieldNames[field]}`}
              value={bindings[field] ?? ''}
              disabled={locked}
              onChange={(event) =>
                onBindings({ ...bindings, [field]: event.target.value })
              }
            >
              <option value="">
                {required.includes(field) ? 'Select a source' : 'Not mapped'}
              </option>
              {draft.headers.map((cell, index) => (
                <option value={String(index)} key={index}>
                  {cell.reviewedText || `Heading ${index + 1} · source missing`}
                </option>
              ))}
              {(field === 'currency' || field === 'asOf') && (
                <option value="context">
                  Reviewed {imageFieldNames[field]?.toLowerCase()} context
                  {draft.context[field] ? '' : ' · not selected'}
                </option>
              )}
            </select>
          </label>
        ))}
      </div>
      <div className="finance-image-coverage">
        <strong>Unmapped selected headings</strong>
        <p>
          {unassigned.length
            ? unassigned.join(' · ')
            : 'Every selected heading has an assigned field.'}
        </p>
        <small>
          Unmapped headings remain part of the reviewed example. Their values
          are not silently assigned to another meaning.
        </small>
      </div>
      <details className="finance-image-conventions" open>
        <summary>Date, number and investment conventions</summary>
        <div className="finance-image-fields">
          <label>
            Dates in the original
            <select
              disabled={locked}
              value={settings.dateFormat}
              onChange={(event) =>
                change(
                  'dateFormat',
                  event.target.value as ImageMappingSettings['dateFormat'],
                )
              }
            >
              <option value="yyyy-mm-dd">Year-month-day · 2026-09-14</option>
              <option value="mm/dd/yyyy">Month/day/year · 09/14/2026</option>
              <option value="dd/mm/yyyy">Day/month/year · 14/09/2026</option>
              <option value="dd.mm.yyyy">Day.month.year · 14.09.2026</option>
              <option value="yyyy/mm/dd">Year/month/day · 2026/09/14</option>
            </select>
          </label>
          <label>
            Decimal mark
            <select
              disabled={locked}
              value={settings.decimalSeparator}
              onChange={(event) =>
                change('decimalSeparator', event.target.value as '.' | ',')
              }
            >
              <option value=".">Period · 1234.56</option>
              <option value=",">Comma · 1234,56</option>
            </select>
          </label>
          <label>
            Thousands separator
            <select
              disabled={locked}
              value={settings.groupingSeparator}
              onChange={(event) =>
                change(
                  'groupingSeparator',
                  event.target
                    .value as ImageMappingSettings['groupingSeparator'],
                )
              }
            >
              <option value="">None</option>
              <option value=",">Comma · 1,234</option>
              <option value=".">Period · 1.234</option>
              <option value=" ">Space · 1 234</option>
            </select>
          </label>
          {settings.reportType === 'investment-positions' && (
            <>
              <label>
                Quantity unit
                <select
                  disabled={locked}
                  value={settings.quantityUnit ?? ''}
                  onChange={(event) =>
                    change(
                      'quantityUnit',
                      (event.target
                        .value as ImageMappingSettings['quantityUnit']) || null,
                    )
                  }
                >
                  <option value="">Select a unit</option>
                  {['share', 'unit', 'face-value', 'contract'].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Instrument identifier type
                <select
                  disabled={locked}
                  value={settings.identifierScheme ?? ''}
                  onChange={(event) =>
                    change(
                      'identifierScheme',
                      (event.target
                        .value as ImageMappingSettings['identifierScheme']) ||
                        null,
                    )
                  }
                >
                  <option value="">Select identifier type</option>
                  {['ISIN', 'CUSIP', 'SEDOL', 'ticker', 'provider'].map(
                    (value) => (
                      <option key={value}>{value}</option>
                    ),
                  )}
                </select>
              </label>
              <label>
                Identifier market or provider
                <input
                  disabled={locked}
                  maxLength={100}
                  value={settings.identifierNamespace ?? ''}
                  onChange={(event) =>
                    change('identifierNamespace', event.target.value || null)
                  }
                />
              </label>
              <label>
                Price quote multiplier
                <input
                  disabled={locked}
                  inputMode="decimal"
                  value={settings.valuationMultiplier ?? ''}
                  onChange={(event) =>
                    change('valuationMultiplier', event.target.value || null)
                  }
                />
                <small>
                  Required when mapping a quoted price. Confirm the original
                  convention.
                </small>
              </label>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
