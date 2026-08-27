import { useEffect, useRef, useState } from 'react';

import type { FinanceImportDestinations } from '@emdo/contracts/browser';

import { Button } from '../../components/button.js';
import {
  financeCopy,
  type FinanceImportCopy,
} from '../finance-v1/finance-locales.js';
import {
  type FinanceImportApi,
  type FinanceImportPreview,
} from './finance-import-api.js';

const MAXIMUM_FILE_BYTES = 1_048_576;
const MAXIMUM_COLUMNS = 50;
const MAXIMUM_COLUMN_NAME_LENGTH = 200;

type ImportFormat = 'csv' | 'ofx';
type CsvColumns = {
  readonly postedOn: string;
  readonly description: string;
  readonly amount: string;
  readonly debit: string;
  readonly credit: string;
  readonly externalId: string;
  readonly categoryId: string;
};

function parseCsvHeader(source: string): string[] | undefined {
  const newline = source.search(/\r?\n/u);
  const line = source.slice(0, newline === -1 ? source.length : newline);
  if (!line || line.length > 16_384) return undefined;
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"') {
      if (value.length !== 0) return undefined;
      quoted = true;
    } else if (character === ',') {
      values.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  if (quoted) return undefined;
  values.push(value.trim());
  const normalized = values.filter(
    (item) =>
      item.length > 0 &&
      item.length <= MAXIMUM_COLUMN_NAME_LENGTH &&
      !/\p{Cc}/u.test(item),
  );
  if (
    normalized.length !== values.length ||
    normalized.length > MAXIMUM_COLUMNS ||
    new Set(normalized).size !== normalized.length
  ) {
    return undefined;
  }
  return normalized;
}

function detectFormat(file: File): ImportFormat | undefined {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') && (!file.type || /csv/u.test(file.type))) {
    return 'csv';
  }
  if (
    (name.endsWith('.ofx') || name.endsWith('.qfx')) &&
    (!file.type || /ofx|qfx|octet-stream/u.test(file.type))
  ) {
    return 'ofx';
  }
  return undefined;
}

function suggestedColumn(headers: readonly string[], terms: readonly string[]) {
  return (
    headers.find((header) =>
      terms.some((term) => header.toLowerCase().includes(term)),
    ) ?? ''
  );
}

function planIsExpired(plan: FinanceImportPreview['plan']): boolean {
  return Date.parse(plan.expiresAt) <= Date.now();
}

function clearFileInput(input: HTMLInputElement | null): void {
  if (input) input.value = '';
}

export function FinanceImportPanel({
  api,
  copy = financeCopy['en-CA'].importPanel,
  csrfToken,
  online,
  onRequestCommit = () => false,
}: {
  readonly api: FinanceImportApi;
  readonly copy?: FinanceImportCopy;
  readonly csrfToken?: string;
  readonly online: boolean;
  readonly onRequestCommit?: (
    plan: FinanceImportPreview['plan'],
  ) => Promise<boolean> | boolean;
  /** @deprecated kept only for callers migrating to guarded EMDO requests. */
  readonly onCommitted?: () => void | Promise<void>;
}) {
  const sourceRef = useRef<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const sourceGenerationRef = useRef(0);
  const operationRef = useRef({
    generation: 0,
    controller: undefined as AbortController | undefined,
  });
  const planSourceRef = useRef<
    | {
        readonly id: string;
        readonly source: string;
        readonly sourceGeneration: number;
      }
    | undefined
  >(undefined);
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [open, setOpen] = useState(false);
  const [destinations, setDestinations] = useState<FinanceImportDestinations>();
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [format, setFormat] = useState<ImportFormat>();
  const [headers, setHeaders] = useState<readonly string[]>([]);
  const [accountId, setAccountId] = useState('');
  const [defaultCategoryId, setDefaultCategoryId] = useState('');
  const [columns, setColumns] = useState<CsvColumns>({
    postedOn: '',
    description: '',
    amount: '',
    debit: '',
    credit: '',
    externalId: '',
    categoryId: '',
  });
  const [dateFormat, setDateFormat] = useState<
    'yyyy-mm-dd' | 'mm/dd/yyyy' | 'dd/mm/yyyy'
  >('yyyy-mm-dd');
  const [plan, setPlan] = useState<FinanceImportPreview['plan']>();
  const [reviewed, setReviewed] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'previewing' | 'requesting'>(
    'idle',
  );
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const effectiveOnline = online && browserOnline;

  const abortOperation = () => {
    operationRef.current.controller?.abort();
    operationRef.current = {
      generation: operationRef.current.generation + 1,
      controller: undefined,
    };
  };

  const beginOperation = () => {
    abortOperation();
    const controller = new AbortController();
    const generation = operationRef.current.generation + 1;
    operationRef.current = { generation, controller };
    return { generation, controller };
  };

  const operationIsCurrent = (generation: number) =>
    mountedRef.current && operationRef.current.generation === generation;

  const sourceIsCurrent = (generation: number, source: string) =>
    mountedRef.current &&
    sourceGenerationRef.current === generation &&
    sourceRef.current === source;

  const sourceGenerationIsCurrent = (generation: number) =>
    mountedRef.current && sourceGenerationRef.current === generation;

  const clearSource = () => {
    sourceGenerationRef.current += 1;
    abortOperation();
    sourceRef.current = undefined;
    planSourceRef.current = undefined;
    clearFileInput(fileInputRef.current);
    setFormat(undefined);
    setHeaders([]);
    setPlan(undefined);
    setReviewed(false);
    setPhase('idle');
  };

  const invalidatePlanForInputChange = () => {
    abortOperation();
    planSourceRef.current = undefined;
    setPlan(undefined);
    setReviewed(false);
    setError(undefined);
    setPhase('idle');
  };

  useEffect(() => {
    const goOffline = () => {
      setBrowserOnline(false);
      clearSource();
      setOpen(false);
    };
    const goOnline = () => setBrowserOnline(true);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  useEffect(() => {
    if (!effectiveOnline || !csrfToken) {
      clearSource();
      setOpen(false);
    }
  }, [effectiveOnline, csrfToken]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortOperation();
      sourceRef.current = undefined;
      planSourceRef.current = undefined;
      clearFileInput(fileInputRef.current);
    };
  }, []);

  const activate = async () => {
    if (!effectiveOnline || !csrfToken) return;
    const operation = beginOperation();
    setOpen(true);
    setError(undefined);
    setMessage(undefined);
    setLoadingOptions(true);
    try {
      const result = await api.listDestinations({
        signal: operation.controller.signal,
      });
      if (!operationIsCurrent(operation.generation)) return;
      setDestinations(result);
      if (!result.accounts.some((account) => account.id === accountId)) {
        setAccountId('');
      }
      if (
        !result.categories.some((category) => category.id === defaultCategoryId)
      ) {
        setDefaultCategoryId('');
      }
    } catch {
      if (!operationIsCurrent(operation.generation)) return;
      setError(copy.destinationsUnavailable);
    } finally {
      if (operationIsCurrent(operation.generation)) setLoadingOptions(false);
    }
  };

  const onFileChange = async (file: File | undefined) => {
    clearSource();
    const sourceGeneration = sourceGenerationRef.current;
    setError(undefined);
    setMessage(undefined);
    if (!file) return;
    const nextFormat = detectFormat(file);
    if (!nextFormat) {
      setError(copy.invalidFile);
      return;
    }
    if (file.size === 0 || file.size > MAXIMUM_FILE_BYTES) {
      setError(copy.fileSize);
      return;
    }
    let source: string;
    try {
      source = await file.text();
    } catch {
      if (!sourceGenerationIsCurrent(sourceGeneration)) return;
      setError(copy.unreadableFile);
      return;
    }
    if (
      !mountedRef.current ||
      sourceGenerationRef.current !== sourceGeneration ||
      !effectiveOnline ||
      !csrfToken
    )
      return;
    if (
      !source ||
      new TextEncoder().encode(source).byteLength > MAXIMUM_FILE_BYTES
    ) {
      setError(copy.fileSize);
      return;
    }
    const nextHeaders = nextFormat === 'csv' ? parseCsvHeader(source) : [];
    if (nextFormat === 'csv' && !nextHeaders) {
      setError(copy.invalidCsvHeader);
      return;
    }
    sourceRef.current = source;
    setFormat(nextFormat);
    setHeaders(nextHeaders ?? []);
    if (nextHeaders) {
      setColumns({
        postedOn: suggestedColumn(nextHeaders, ['date', 'posted']),
        description: suggestedColumn(nextHeaders, [
          'description',
          'memo',
          'payee',
        ]),
        amount: suggestedColumn(nextHeaders, ['amount']),
        debit: suggestedColumn(nextHeaders, ['debit', 'withdrawal']),
        credit: suggestedColumn(nextHeaders, ['credit', 'deposit']),
        externalId: suggestedColumn(nextHeaders, ['id', 'reference']),
        categoryId: suggestedColumn(nextHeaders, ['category']),
      });
    }
  };

  const preview = async () => {
    const source = sourceRef.current;
    const sourceGeneration = sourceGenerationRef.current;
    if (!effectiveOnline || !csrfToken || !source || !format || !accountId)
      return;
    if (
      format === 'csv' &&
      (!columns.postedOn ||
        !columns.description ||
        (!columns.amount && !(columns.debit && columns.credit)) ||
        (columns.amount && (columns.debit || columns.credit)))
    ) {
      setError(copy.incompleteMapping);
      return;
    }
    const operation = beginOperation();
    planSourceRef.current = undefined;
    setPhase('previewing');
    setError(undefined);
    setMessage(undefined);
    setPlan(undefined);
    setReviewed(false);
    try {
      const result = await api.preview(
        format === 'csv'
          ? {
              csrfToken,
              sourceText: source,
              format,
              accountId,
              mapping: {
                defaultCategoryId: defaultCategoryId || null,
                dateFormat,
                columns: {
                  postedOn: columns.postedOn,
                  description: columns.description,
                  ...(columns.amount ? { amount: columns.amount } : {}),
                  ...(columns.debit ? { debit: columns.debit } : {}),
                  ...(columns.credit ? { credit: columns.credit } : {}),
                  ...(columns.externalId
                    ? { externalId: columns.externalId }
                    : {}),
                  ...(columns.categoryId
                    ? { categoryId: columns.categoryId }
                    : {}),
                },
              },
              signal: operation.controller.signal,
            }
          : {
              csrfToken,
              sourceText: source,
              format,
              accountId,
              mapping: { defaultCategoryId: defaultCategoryId || null },
              signal: operation.controller.signal,
            },
      );
      if (
        !operationIsCurrent(operation.generation) ||
        !sourceIsCurrent(sourceGeneration, source)
      )
        return;
      setPlan(result.plan);
      planSourceRef.current = {
        id: result.plan.id,
        source,
        sourceGeneration,
      };
    } catch {
      if (!operationIsCurrent(operation.generation)) return;
      setError(copy.previewUnavailable);
    } finally {
      if (operationIsCurrent(operation.generation)) setPhase('idle');
    }
  };

  const commit = async () => {
    const planSource = planSourceRef.current;
    if (
      !effectiveOnline ||
      !csrfToken ||
      !plan ||
      !planSource ||
      planSource.id !== plan.id ||
      !sourceIsCurrent(planSource.sourceGeneration, planSource.source) ||
      !reviewed ||
      planIsExpired(plan)
    )
      return;
    const operation = beginOperation();
    setPhase('requesting');
    setError(undefined);
    try {
      const requested = await onRequestCommit(plan);
      if (
        !operationIsCurrent(operation.generation) ||
        !sourceIsCurrent(planSource.sourceGeneration, planSource.source)
      )
        return;
      setMessage(requested ? copy.commitRequested : copy.commitUnavailable);
    } catch {
      if (!operationIsCurrent(operation.generation)) return;
      setError(copy.commitUnavailable);
    } finally {
      if (operationIsCurrent(operation.generation)) setPhase('idle');
    }
  };

  if (!effectiveOnline) {
    return (
      <p className="import-panel" role="status">
        {copy.offline}
      </p>
    );
  }
  if (!csrfToken) {
    return (
      <p className="import-panel" role="status">
        {copy.secureSessionRequired}
      </p>
    );
  }
  if (!open) {
    return (
      <section
        className="import-panel"
        aria-labelledby="statement-import-heading"
      >
        <h2 id="statement-import-heading">{copy.heading}</h2>
        <p>{copy.description}</p>
        <Button
          busy={loadingOptions}
          onClick={() => void activate()}
          type="button"
        >
          {copy.open}
        </Button>
      </section>
    );
  }

  const noAccounts = destinations?.accounts.length === 0;
  const commitDisabled =
    !plan ||
    plan.summary.accepted === 0 ||
    planIsExpired(plan) ||
    !reviewed ||
    phase !== 'idle';
  return (
    <section
      className="import-panel finance-import-panel"
      aria-labelledby="statement-import-heading"
    >
      <h2 id="statement-import-heading">{copy.heading}</h2>
      <p>{copy.description}</p>
      {loadingOptions ? <p role="status">{copy.loadingDestinations}</p> : null}
      {noAccounts ? <p role="status">{copy.noAccounts}</p> : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {destinations && !noAccounts ? (
        <>
          <label htmlFor="finance-import-account">{copy.accountLabel}</label>
          <select
            id="finance-import-account"
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
              clearSource();
            }}
          >
            <option value="">{copy.chooseAccount}</option>
            {destinations.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
          <label htmlFor="finance-import-category">
            {copy.defaultCategoryLabel}
          </label>
          <select
            id="finance-import-category"
            value={defaultCategoryId}
            onChange={(event) => {
              invalidatePlanForInputChange();
              setDefaultCategoryId(event.target.value);
            }}
          >
            <option value="">{copy.noDefaultCategory}</option>
            {destinations.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <label htmlFor="finance-import-file">{copy.statementFileLabel}</label>
          <input
            ref={fileInputRef}
            id="finance-import-file"
            type="file"
            accept=".csv,.ofx,.qfx,text/csv,application/x-ofx"
            onChange={(event) =>
              void onFileChange(event.currentTarget.files?.[0])
            }
          />
          {format === 'csv' ? (
            <fieldset className="finance-import-panel__mapping">
              <legend>{copy.mappingLegend}</legend>
              <ColumnSelect
                id="finance-import-posted-date-column"
                label={copy.postedOnColumn}
                emptyLabel={copy.chooseColumn}
                value={columns.postedOn}
                headers={headers}
                onChange={(value) => {
                  invalidatePlanForInputChange();
                  setColumns((current) => ({ ...current, postedOn: value }));
                }}
              />
              <ColumnSelect
                id="finance-import-description-column"
                label={copy.descriptionColumn}
                emptyLabel={copy.chooseColumn}
                value={columns.description}
                headers={headers}
                onChange={(value) => {
                  invalidatePlanForInputChange();
                  setColumns((current) => ({ ...current, description: value }));
                }}
              />
              <ColumnSelect
                id="finance-import-signed-amount-column"
                label={copy.amountColumn}
                emptyLabel={copy.chooseColumn}
                value={columns.amount}
                headers={headers}
                onChange={(value) => {
                  invalidatePlanForInputChange();
                  setColumns((current) => ({
                    ...current,
                    amount: value,
                    ...(value ? { debit: '', credit: '' } : {}),
                  }));
                }}
              />
              <ColumnSelect
                id="finance-import-debit-column"
                label={copy.debitColumn}
                emptyLabel={copy.chooseColumn}
                value={columns.debit}
                headers={headers}
                onChange={(value) => {
                  invalidatePlanForInputChange();
                  setColumns((current) => ({
                    ...current,
                    debit: value,
                    ...(value ? { amount: '' } : {}),
                  }));
                }}
              />
              <ColumnSelect
                id="finance-import-credit-column"
                label={copy.creditColumn}
                emptyLabel={copy.chooseColumn}
                value={columns.credit}
                headers={headers}
                onChange={(value) => {
                  invalidatePlanForInputChange();
                  setColumns((current) => ({
                    ...current,
                    credit: value,
                    ...(value ? { amount: '' } : {}),
                  }));
                }}
              />
              <ColumnSelect
                id="finance-import-external-id-column"
                label={copy.externalIdColumn}
                emptyLabel={copy.chooseColumn}
                value={columns.externalId}
                headers={headers}
                onChange={(value) => {
                  invalidatePlanForInputChange();
                  setColumns((current) => ({ ...current, externalId: value }));
                }}
              />
              <ColumnSelect
                id="finance-import-category-column"
                label={copy.categoryColumn}
                emptyLabel={copy.chooseColumn}
                value={columns.categoryId}
                headers={headers}
                onChange={(value) => {
                  invalidatePlanForInputChange();
                  setColumns((current) => ({ ...current, categoryId: value }));
                }}
              />
              <label htmlFor="finance-import-date-format">
                {copy.dateFormatLabel}
              </label>
              <select
                id="finance-import-date-format"
                value={dateFormat}
                onChange={(event) => {
                  invalidatePlanForInputChange();
                  setDateFormat(event.target.value as typeof dateFormat);
                }}
              >
                <option value="yyyy-mm-dd">YYYY-MM-DD</option>
                <option value="mm/dd/yyyy">MM/DD/YYYY</option>
                <option value="dd/mm/yyyy">DD/MM/YYYY</option>
              </select>
            </fieldset>
          ) : null}
          <div className="finance-import-panel__actions">
            <Button
              busy={phase === 'previewing'}
              disabled={!format || !accountId}
              onClick={() => void preview()}
              type="button"
            >
              {copy.preview}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                clearSource();
                setOpen(false);
              }}
              type="button"
            >
              {copy.cancel}
            </Button>
          </div>
        </>
      ) : null}
      {plan ? (
        <section
          className="finance-import-panel__preview"
          aria-labelledby="import-preview-heading"
        >
          <h3 id="import-preview-heading">{copy.reviewHeading}</h3>
          <p role="status">
            {plan.summary.accepted} {copy.accepted} · {plan.summary.rejected}{' '}
            {copy.rejected} · {plan.summary.duplicates} {copy.duplicates}
          </p>
          {plan.rejectedRows.slice(0, 100).map((row) => (
            <p key={`rejected-${row.sourceRow}`}>
              {copy.row} {row.sourceRow}: {row.code}
            </p>
          ))}
          {plan.duplicateRows.slice(0, 100).map((row) => (
            <p key={`duplicate-${row.sourceRow}`}>
              {copy.row} {row.sourceRow}: {row.reason}
            </p>
          ))}
          {planIsExpired(plan) ? (
            <p className="inline-error" role="alert">
              {copy.previewExpired}
            </p>
          ) : null}
          <label className="finance-import-panel__review">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            {copy.reviewedLabel}
          </label>
          <Button
            busy={phase === 'requesting'}
            disabled={commitDisabled}
            onClick={() => void commit()}
            type="button"
          >
            {copy.commit} {plan.summary.accepted} {copy.transactions}
          </Button>
        </section>
      ) : null}
    </section>
  );
}

function ColumnSelect({
  id,
  label,
  emptyLabel,
  value,
  headers,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly emptyLabel: string;
  readonly value: string;
  readonly headers: readonly string[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{emptyLabel}</option>
        {headers.map((header) => (
          <option key={header} value={header}>
            {header}
          </option>
        ))}
      </select>
    </>
  );
}
