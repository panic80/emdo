import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  FinanceReportMappingDefinitionSchema,
  SaveReviewedFinanceXlsxMappingSchema,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';

type Definition = z.infer<typeof FinanceReportMappingDefinitionSchema>;
export function FinanceXlsxReview({
  evidenceId,
  definition,
  questions,
  sheet,
  disabled,
  onSave,
  onDownload,
}: {
  evidenceId: string;
  definition: Definition;
  questions: string[];
  sheet?: string | null;
  disabled: boolean;
  onSave: (
    input: z.infer<typeof SaveReviewedFinanceXlsxMappingSchema>,
  ) => Promise<void>;
  onDownload: () => void;
}) {
  const [error, setError] = useState('');
  const selection = definition.xlsxSelection;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    try {
      if (form.get('sourceChecked') !== 'on')
        throw new Error(
          'Confirm the original range and field meanings before saving.',
        );
      const responses = questions.map((question, index) => {
        const answer = String(form.get(`answer-${index}`) ?? '').trim();
        if (answer.length < 3)
          throw new Error('Explain how each open question was resolved.');
        return `${question}\nResolution: ${answer}`;
      });
      const notes = String(form.get('notes') ?? '').trim();
      if (notes.length < 3)
        throw new Error('Add a review note explaining the source checks.');
      const dates = String(form.get('dateColumns') ?? '').trim();
      if (dates && !/^\d+(?:\s*,\s*\d+)*$/.test(dates))
        throw new Error(
          'Enter date column numbers separated by commas, or leave them empty.',
        );
      const payload = SaveReviewedFinanceXlsxMappingSchema.parse({
        evidenceId,
        proposal: {
          definition: {
            ...definition,
            ...(definition.reportType === 'investment-positions'
              ? Object.fromEntries(
                  [
                    'quantityUnit',
                    'identifierScheme',
                    'identifierNamespace',
                    'valuationMultiplier',
                  ].map((name) => [
                    name,
                    String(form.get(name) ?? '').trim() || null,
                  ]),
                )
              : {}),
            dateFormat: form.get('dateFormat'),
            decimalSeparator: form.get('decimalSeparator'),
            groupingSeparator: form.get('groupingSeparator'),
            bindings: definition.bindings.map((binding, index) => {
              const choice = String(form.get(`binding-${index}`));
              if (!choice)
                throw new Error(
                  'Select a source heading for every required field.',
                );
              return choice === 'context'
                ? { ...binding, column: null }
                : {
                    ...binding,
                    column: definition.headers[Number(choice)],
                    context: null,
                  };
            }),
            xlsxSelection: {
              sheet: String(form.get('sheet')).trim(),
              ...Object.fromEntries(
                [
                  'headerRow',
                  'firstColumn',
                  'lastColumn',
                  'firstDataRow',
                  'lastDataRow',
                ].map((name) => [name, Number(form.get(name))]),
              ),
              dateColumns: dates
                ? dates.split(',').map((value) => Number(value.trim()))
                : [],
              confirmedHeaderAndDataRange: true,
              confirmedDateSystem: form.get('dateSystem'),
              acknowledgeCachedFormulaValues:
                form.get('formulaCaches') === 'on',
              acknowledgeHiddenContent: form.get('hiddenContent') === 'on',
            },
          },
          rationale: [notes, ...responses].join('\n\n'),
          unresolvedQuestions: [],
        },
      });
      await onSave(payload);
    } catch (failure) {
      setError(
        failure instanceof z.ZodError
          ? failure.issues.map((issue) => issue.message).join(' ')
          : failure instanceof Error
            ? failure.message
            : 'Unable to save the reviewed selection.',
      );
    }
  }
  return (
    <details className="finance-xlsx-review">
      <summary>Review XLSX source and create a revised candidate</summary>
      <p>
        Check the original workbook, then confirm the exact sheet, range and
        field meanings. Saving creates a new candidate; approval remains a
        separate decision.
      </p>
      <Button
        type="button"
        variant="quiet"
        disabled={disabled}
        onClick={onDownload}
      >
        Download original workbook
      </Button>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={disabled}>
          <legend>Source range</legend>
          <label>
            Worksheet name
            <input
              name="sheet"
              required
              maxLength={200}
              defaultValue={selection?.sheet ?? sheet ?? ''}
            />
          </label>
          {(
            [
              ['headerRow', 'Header row'],
              ['firstColumn', 'First column number'],
              ['lastColumn', 'Last column number'],
              ['firstDataRow', 'First data row'],
              ['lastDataRow', 'Last data row'],
            ] as const
          ).map(([name, label]) => (
            <label key={name}>
              {label}
              <input
                name={name}
                type="number"
                required
                min={1}
                max={name.includes('Column') ? 100 : 1048576}
                step={1}
                defaultValue={selection?.[name] ?? ''}
              />
            </label>
          ))}
          <p>
            Columns use numbers: A = 1, B = 2. Include every intended data row.
            Blank rows and subtotals are retained for validation.
          </p>
          <label>
            Workbook date system
            <select
              name="dateSystem"
              required
              defaultValue={selection?.confirmedDateSystem ?? ''}
            >
              <option value="" disabled>
                Select the workbook setting
              </option>
              <option value="1900">1900 date system</option>
              <option value="1904">1904 date system</option>
            </select>
          </label>
          <label>
            Date columns to convert
            <input
              name="dateColumns"
              placeholder="For example, 1, 4"
              defaultValue={selection?.dateColumns.join(', ') ?? ''}
            />
          </label>
          <p>
            Only these columns convert serial dates to YYYY-MM-DD. Leave empty
            for text dates that already match the selected format.
          </p>
        </fieldset>
        <fieldset disabled={disabled}>
          <legend>Field meanings and number formats</legend>
          {definition.bindings.map((binding, index) => (
            <label key={binding.field}>
              {binding.field}
              <select
                name={`binding-${index}`}
                required
                defaultValue={
                  !binding.column
                    ? binding.context
                      ? 'context'
                      : ''
                    : String(definition.headers.indexOf(binding.column))
                }
              >
                <option value="" disabled>
                  Select a source heading
                </option>
                {definition.headers.map((header, columnIndex) => (
                  <option key={header} value={columnIndex}>
                    {header}
                  </option>
                ))}
                {binding.context && (
                  <option value="context">
                    Report context: {binding.context}
                  </option>
                )}
              </select>
            </label>
          ))}
          <label>
            Date format
            <select name="dateFormat" defaultValue={definition.dateFormat}>
              <option value="yyyy-mm-dd">YYYY-MM-DD</option>
              <option value="mm/dd/yyyy">MM/DD/YYYY</option>
              <option value="dd/mm/yyyy">DD/MM/YYYY</option>
              <option value="dd.mm.yyyy">DD.MM.YYYY</option>
              <option value="yyyy/mm/dd">YYYY/MM/DD</option>
            </select>
          </label>
          <label>
            Decimal separator
            <select
              name="decimalSeparator"
              defaultValue={definition.decimalSeparator}
            >
              <option value=".">Period (.)</option>
              <option value=",">Comma (,)</option>
            </select>
          </label>
          <label>
            Thousands separator
            <select
              name="groupingSeparator"
              defaultValue={definition.groupingSeparator}
            >
              <option value="">None</option>
              <option value=",">Comma (,)</option>
              <option value=".">Period (.)</option>
              <option value=" ">Space</option>
            </select>
          </label>
          {definition.reportType === 'investment-positions' && (
            <>
              <label>
                Quantity unit
                <select
                  name="quantityUnit"
                  required
                  defaultValue={definition.quantityUnit ?? ''}
                >
                  <option value="" disabled>
                    Select unit
                  </option>
                  {['share', 'unit', 'face-value', 'contract'].map((unit) => (
                    <option value={unit} key={unit}>
                      {unit.replace('-', ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Identifier type
                <select
                  name="identifierScheme"
                  required
                  defaultValue={definition.identifierScheme ?? ''}
                >
                  <option value="" disabled>
                    Select type
                  </option>
                  {['ISIN', 'CUSIP', 'SEDOL', 'ticker', 'provider'].map(
                    (value) => (
                      <option value={value} key={value}>
                        {value}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label>
                Identifier market or namespace
                <input
                  name="identifierNamespace"
                  defaultValue={definition.identifierNamespace ?? ''}
                  maxLength={100}
                  required
                />
              </label>
              <label>
                Quote multiplier
                <input
                  name="valuationMultiplier"
                  defaultValue={definition.valuationMultiplier ?? ''}
                  maxLength={60}
                />
              </label>
            </>
          )}
          <label>
            <input type="checkbox" name="formulaCaches" />I checked the saved
            formula results and accept using those cached values.
          </label>
          <label>
            <input type="checkbox" name="hiddenContent" />I checked and intend
            to include any hidden content within this range.
          </label>
        </fieldset>
        <fieldset disabled={disabled}>
          <legend>Review findings</legend>
          {questions.map((question, index) => (
            <label key={index}>
              {question}
              <textarea
                name={`answer-${index}`}
                required
                minLength={3}
                maxLength={500}
              />
            </label>
          ))}
          <label>
            Source review notes
            <textarea name="notes" required minLength={3} maxLength={1500} />
          </label>
          <label>
            <input type="checkbox" name="sourceChecked" required />I checked the
            range, currency, units and field meanings against the original
            workbook, and resolved the questions above.
          </label>
          <Button disabled={disabled}>Save revised XLSX candidate</Button>
        </fieldset>
      </form>
    </details>
  );
}
