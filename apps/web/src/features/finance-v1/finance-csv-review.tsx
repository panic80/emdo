import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  SaveFinanceReportMappingFromSourceSchema,
  CanonicalReportFieldSchema,
  type FinanceReportMappingDefinition,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import {
  readStandardizationOriginal,
  downloadStandardizationOriginal,
  StandardizationRequestError,
} from './finance-standardization-api.js';
import './finance-csv-review.css';

const names: Record<string, string> = {
  transactionDate: 'Transaction date',
  description: 'Description',
  amount: 'Amount',
  currency: 'Currency',
  externalId: 'External reference',
  fee: 'Fee',
  commission: 'Commission',
  tax: 'Tax',
  principal: 'Principal',
  interest: 'Interest',
  asOf: 'As-of date',
  instrumentIdentifier: 'Instrument identifier',
  quantity: 'Quantity',
  bookCost: 'Book cost',
  marketValue: 'Market value',
  price: 'Price',
  accruedInterest: 'Accrued interest',
};
type Field = z.infer<typeof CanonicalReportFieldSchema>;
const requiredFields: Record<
  FinanceReportMappingDefinition['reportType'],
  readonly Field[]
> = {
  'bank-transactions': ['transactionDate', 'description', 'amount', 'currency'],
  'investment-positions': [
    'asOf',
    'instrumentIdentifier',
    'quantity',
    'currency',
  ],
};
const optionalFields: Record<
  FinanceReportMappingDefinition['reportType'],
  readonly Field[]
> = {
  'bank-transactions': [
    'externalId',
    'fee',
    'commission',
    'tax',
    'principal',
    'interest',
  ],
  'investment-positions': [
    'description',
    'bookCost',
    'marketValue',
    'price',
    'accruedInterest',
  ],
};
type Props = {
  bookId: string;
  evidenceId: string;
  sourceDigest: string;
  filename: string;
  definition: FinanceReportMappingDefinition;
  questions: string[];
  disabled: boolean;
  onSave: (
    input: z.infer<typeof SaveFinanceReportMappingFromSourceSchema>,
  ) => Promise<void>;
  onClose: () => void;
  onAccessUnavailable: (message: string) => void;
};
/** Displays verified original text; only the server constructs canonical example rows. */
export function FinanceCsvReview(props: Props) {
  const { definition, questions, disabled, onSave, onClose } = props;
  const [original, setOriginal] = useState<string>();
  const [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const [headings, setHeadings] = useState(definition.headers.join('\n'));
  const [bindings, setBindings] = useState(() =>
    definition.bindings.map((binding) => ({ ...binding })),
  );
  const [optionalField, setOptionalField] = useState<Field | ''>('');
  const [addedField, setAddedField] = useState<Field | ''>('');
  const fieldRefs = useRef<Partial<Record<Field, HTMLSelectElement | null>>>(
    {},
  );
  const [checked, setChecked] = useState(false);
  const [viewOffset, setViewOffset] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const identity = {
    bookId: props.bookId,
    evidenceId: props.evidenceId,
    sourceDigest: props.sourceDigest,
    format: 'csv',
  };
  const pageSize = 16_384;
  function failed(cause: unknown) {
    const message =
      cause instanceof z.ZodError
        ? cause.issues.map((issue) => issue.message).join(' ')
        : cause instanceof Error
          ? cause.message
          : 'The CSV source review could not be completed.';
    setError(message);
    if (
      cause instanceof StandardizationRequestError &&
      [401, 403].includes(cause.status)
    ) {
      setOriginal(undefined);
      props.onAccessUnavailable(message);
    }
  }
  async function load() {
    controller.current?.abort();
    const control = new AbortController();
    controller.current = control;
    setBusy(true);
    setError('');
    setOriginal(undefined);
    setChecked(false);
    try {
      const source = await readStandardizationOriginal(
        identity,
        control.signal,
      );
      if (!control.signal.aborted)
        setOriginal(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            source.bytes,
          ),
        );
    } catch (cause) {
      if (!control.signal.aborted) failed(cause);
    } finally {
      if (!control.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, []);
  useEffect(() => {
    const input = addedField ? fieldRefs.current[addedField] : null;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.scrollIntoView?.({
      block: 'center',
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
    setAddedField('');
  }, [addedField, bindings]);
  async function download() {
    const control = controller.current;
    if (!control || control.signal.aborted) return;
    setBusy(true);
    setError('');
    try {
      await downloadStandardizationOriginal(identity, control.signal);
    } catch (cause) {
      if (!control.signal.aborted) failed(cause);
    } finally {
      if (!control.signal.aborted) setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || disabled || !original || !checked) return;
    const form = new FormData(event.currentTarget),
      signal = controller.current?.signal;
    setError('');
    setBusy(true);
    try {
      const headers = headings
        .split('\n')
        .map((value) => value.replace(/\r$/u, ''));
      const responses = questions.map((question, index) => {
        const answer = String(form.get(`answer-${index}`) ?? '').trim();
        if (answer.length < 3)
          throw new Error(
            'Explain how each open question was resolved against the original.',
          );
        return `${question}\nResolution: ${answer}`;
      });
      const notes = String(form.get('notes') ?? '').trim();
      if (notes.length < 3)
        throw new Error('Add the source checks supporting this candidate.');
      const nullable = (key: string) =>
        String(form.get(key) ?? '').trim() || null;
      const payload = SaveFinanceReportMappingFromSourceSchema.parse({
        evidenceId: props.evidenceId,
        expectedSourceDigest: props.sourceDigest,
        proposal: {
          definition: {
            ...definition,
            xlsxSelection: null,
            pdfSelection: null,
            providerKey: form.get('providerKey'),
            reportName: form.get('reportName'),
            layoutVersion: form.get('layoutVersion'),
            headers,
            dateFormat: form.get('dateFormat'),
            decimalSeparator: form.get('decimalSeparator'),
            groupingSeparator: form.get('groupingSeparator'),
            bindings: bindings.map((binding) => ({
              ...binding,
              column: String(form.get(`binding-${binding.field}`)),
              context: null,
            })),
            ...(definition.reportType === 'investment-positions'
              ? {
                  quantityUnit: nullable('quantityUnit'),
                  identifierScheme: nullable('identifierScheme'),
                  identifierNamespace: nullable('identifierNamespace'),
                  valuationMultiplier: nullable('valuationMultiplier'),
                }
              : {}),
          },
          rationale: [notes, ...responses].join('\n\n'),
          unresolvedQuestions: [],
        },
      });
      await onSave(payload);
    } catch (cause) {
      if (!signal?.aborted) failed(cause);
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }
  const locked = disabled || busy;
  const headers = headings
    .split('\n')
    .map((value) => value.replace(/\r$/u, ''));
  const required = requiredFields[definition.reportType];
  const availableFields = CanonicalReportFieldSchema.options.filter(
    (field) =>
      optionalFields[definition.reportType].includes(field) &&
      !bindings.some((binding) => binding.field === field),
  );
  const unmappedHeaders = headers.flatMap((header, index) =>
    header && !bindings.some((binding) => binding.column === header)
      ? [{ header, index }]
      : [],
  );
  function changeHeadings(value: string) {
    const nextHeaders = value
      .split('\n')
      .map((header) => header.replace(/\r$/u, ''));
    setHeadings(value);
    setBindings((current) =>
      current.map((binding) =>
        binding.column && !nextHeaders.includes(binding.column)
          ? { ...binding, column: null, context: null }
          : binding,
      ),
    );
    setChecked(false);
  }
  function removeField(field: Field) {
    if (required.includes(field) || locked) return;
    setBindings((current) =>
      current.filter((binding) => binding.field !== field),
    );
    setChecked(false);
  }
  return (
    <section className="finance-csv-review" aria-label="CSV source review">
      <div className="finance-csv-review-heading">
        <div>
          <span className="finance-standardization-eyebrow">Source review</span>
          <h4>Review the CSV field meanings</h4>
          <p>
            {props.filename} ·{' '}
            {original
              ? 'Original fingerprint verified'
              : 'Original verification required'}
          </p>
        </div>
        <Button
          type="button"
          variant="quiet"
          disabled={locked}
          onClick={onClose}
        >
          Close CSV review
        </Button>
      </div>
      <p>
        Check the original headings, signs, dates and units. Saving creates a
        candidate from the saved CSV. Approval and financial review remain
        separate decisions.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && !original && <p role="status">Loading the saved original…</p>}
      {!original && !busy && (
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() => void load()}
        >
          Retry original
        </Button>
      )}
      {original && (
        <>
          <details className="finance-csv-original" open>
            <summary>Verified original CSV text</summary>
            <p>
              Exact original text, characters {viewOffset + 1}–
              {Math.min(viewOffset + pageSize, original.length)} of{' '}
              {original.length}. Values appear exactly as saved, including
              quoted content. Review all pages or download the original.
            </p>
            <pre tabIndex={0} aria-label="Original CSV text">
              {original.slice(viewOffset, viewOffset + pageSize)}
            </pre>
            <div className="finance-standardization-actions">
              {original.length > pageSize && (
                <>
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={locked || viewOffset === 0}
                    onClick={() =>
                      setViewOffset(Math.max(0, viewOffset - pageSize))
                    }
                  >
                    Previous source text
                  </Button>
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={
                      locked || viewOffset + pageSize >= original.length
                    }
                    onClick={() => setViewOffset(viewOffset + pageSize)}
                  >
                    Next source text
                  </Button>
                </>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={locked}
                onClick={() => void download()}
              >
                Download original CSV
              </Button>
            </div>
          </details>
          <form
            onSubmit={(event) => void submit(event)}
            onChange={() => setChecked(false)}
          >
            <fieldset disabled={locked}>
              <legend>1. Confirm this report</legend>
              <div className="finance-csv-fields">
                <label>
                  Report provider
                  <input
                    name="providerKey"
                    defaultValue={definition.providerKey}
                    required
                    maxLength={100}
                  />
                </label>
                <label>
                  Report name
                  <input
                    name="reportName"
                    defaultValue={definition.reportName}
                    required
                    maxLength={200}
                  />
                </label>
                <label>
                  Layout version
                  <input
                    name="layoutVersion"
                    defaultValue={definition.layoutVersion}
                    required
                    maxLength={100}
                  />
                </label>
              </div>
              <p>
                Report section:{' '}
                {definition.reportType === 'bank-transactions'
                  ? 'Bank transactions'
                  : 'Investment positions'}
                . CSV values must come from source columns.
              </p>
              <label>
                Source headings, in original order
                <textarea
                  value={headings}
                  rows={Math.min(8, Math.max(3, headers.length))}
                  maxLength={20100}
                  required
                  onChange={(event) => changeHeadings(event.target.value)}
                />
              </label>
              <p>
                One heading per line. Preserve spelling and spaces from the CSV.
                The saved original must match every heading and its order.
              </p>
            </fieldset>
            <fieldset disabled={locked}>
              <legend>2. Confirm field meanings and formats</legend>
              <div className="finance-csv-fields">
                {bindings.map((binding) => (
                  <div className="finance-csv-binding" key={binding.field}>
                    <label>
                      {names[binding.field] ?? binding.field}
                      <select
                        ref={(element) => {
                          fieldRefs.current[binding.field] = element;
                        }}
                        name={`binding-${binding.field}`}
                        required
                        value={binding.column ?? ''}
                        onChange={(event) =>
                          setBindings((current) =>
                            current.map((item) =>
                              item.field === binding.field
                                ? {
                                    ...item,
                                    column: event.target.value,
                                    context: null,
                                  }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="" disabled>
                          Select a source heading
                        </option>
                        {headers.map((header, i) => (
                          <option key={`${i}:${header}`} value={header}>
                            {header || '(empty heading)'}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!required.includes(binding.field) && (
                      <Button
                        type="button"
                        variant="quiet"
                        className="finance-csv-remove"
                        onClick={() => removeField(binding.field)}
                      >
                        Remove {names[binding.field]} mapping
                      </Button>
                    )}
                  </div>
                ))}
                <label>
                  Date format
                  <select
                    name="dateFormat"
                    defaultValue={definition.dateFormat}
                  >
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
                  Grouping separator
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
                        {['share', 'unit', 'face-value', 'contract'].map(
                          (unit) => (
                            <option value={unit} key={unit}>
                              {unit.replace('-', ' ')}
                            </option>
                          ),
                        )}
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
              </div>
            </fieldset>
            <fieldset disabled={locked}>
              <legend>Unmapped columns and optional financial fields</legend>
              <div className="finance-csv-add-field">
                <label>
                  Optional financial field
                  <select
                    value={optionalField}
                    disabled={!availableFields.length}
                    onChange={(event) =>
                      setOptionalField(
                        event.target.value
                          ? CanonicalReportFieldSchema.parse(event.target.value)
                          : '',
                      )
                    }
                  >
                    <option value="">Choose a field to add</option>
                    {availableFields.map((field) => (
                      <option key={field} value={field}>
                        {names[field]}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!optionalField || locked}
                  onClick={() => {
                    if (
                      !optionalField ||
                      !availableFields.includes(optionalField)
                    )
                      return;
                    setBindings((current) => [
                      ...current,
                      { field: optionalField, column: null, context: null },
                    ]);
                    setAddedField(optionalField);
                    setOptionalField('');
                    setChecked(false);
                  }}
                >
                  Add financial field
                </Button>
              </div>
              <div
                className="finance-csv-unmapped"
                aria-label="Unmapped source headings"
              >
                <strong>
                  Unmapped source headings · {unmappedHeaders.length}
                </strong>
                {unmappedHeaders.length ? (
                  <>
                    <p>
                      These columns have no assigned financial meaning. Map any
                      needed values and review every remaining omission before
                      saving.
                    </p>
                    <ul>
                      {unmappedHeaders.map(({ header, index }) => (
                        <li key={index}>
                          Column {index + 1}: {header}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p>Every source heading is assigned to a financial field.</p>
                )}
              </div>
            </fieldset>
            <fieldset disabled={locked}>
              <legend>3. Resolve uncertainties against the source</legend>
              {questions.map((question, index) => (
                <label key={`${index}:${question}`}>
                  {question}
                  <textarea
                    name={`answer-${index}`}
                    rows={2}
                    minLength={3}
                    maxLength={500}
                    required
                  />
                </label>
              ))}
              <label>
                Source review notes
                <textarea
                  name="notes"
                  rows={3}
                  minLength={3}
                  maxLength={1500}
                  required
                  placeholder="Explain the source checks and any corrected field meanings."
                />
              </label>
            </fieldset>
            <label className="finance-csv-check">
              <input
                type="checkbox"
                checked={checked}
                disabled={locked}
                onChange={(event) => {
                  event.stopPropagation();
                  setChecked(event.target.checked);
                }}
              />
              I checked the full original, exact headings, field meanings,
              number signs and formats, resolved the questions above, and
              reviewed every unmapped column.
            </label>
            <Button disabled={locked || !checked}>
              Save reviewed CSV candidate
            </Button>
            <p className="finance-csv-boundary">
              This saves a new candidate with a server-derived source example.
              It does not approve the mapping or import financial records.
            </p>
          </form>
        </>
      )}
    </section>
  );
}
