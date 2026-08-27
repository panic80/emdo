import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../components/button.js';
import {
  createFinanceDocumentApi,
  type FinanceDocumentApi,
  type FinanceDocumentEnvelopeV1,
  type FinanceDocumentMatchList,
  type FinanceDocumentReviewDraft,
  type FinanceDocumentSummary,
  type FinanceLocale,
} from './finance-document-api.js';
import { financeCopy, financeReviewLabel } from './finance-locales.js';

const MAXIMUM_FILES = 20;
const MAXIMUM_CONCURRENT_UPLOADS = 3;
const DOCUMENT_LIST_PAGE_SIZE = 50;
const MAXIMUM_VISIBLE_DOCUMENTS = 10_000;
const REVIEW_COLLECTION_PAGE_SIZE = 100;
const textFields = [
  'issuer',
  'recipient',
  'merchant',
  'vendor',
  'invoiceNumber',
  'institution',
  'employer',
  'provider',
  'policyType',
  'lender',
  'loanType',
  'slipType',
  'summary',
  'accountLast4',
  'paymentMethodLast4',
  'policyLast4',
] as const;
const dateFields = [
  'issuedOn',
  'dueOn',
  'periodStart',
  'periodEnd',
  'purchasedOn',
] as const;
const numberFields = ['taxYear', 'annualRateBasisPoints'] as const;
const moneyFields = [
  'subtotal',
  'tax',
  'total',
  'tip',
  'openingBalance',
  'closingBalance',
  'minimumPayment',
  'grossPay',
  'deductions',
  'netPay',
  'premium',
  'balance',
  'marketValue',
] as const;
const invoicePaymentStatuses = ['unpaid', 'paid', 'unknown'] as const;
type InvoicePaymentStatus = (typeof invoicePaymentStatuses)[number];
type RequestState = 'idle' | 'requesting' | 'requested' | 'error';
type EditableEnvelope = Record<string, unknown>;
const reviewCollectionFields = [
  'facts',
  'lineItems',
  'transactions',
  'boxes',
  'holdings',
] as const;
type ReviewCollectionField = (typeof reviewCollectionFields)[number];

function mutationKey(operation: string): string {
  return `finance-document:${operation}:${crypto.randomUUID()}`;
}
function runBounded<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await worker(item);
    }
  };
  return Promise.all(
    Array.from(
      { length: Math.min(MAXIMUM_CONCURRENT_UPLOADS, items.length) },
      run,
    ),
  ).then(() => undefined);
}

function appendDocuments(
  current: readonly FinanceDocumentSummary[],
  next: readonly FinanceDocumentSummary[],
): readonly FinanceDocumentSummary[] {
  const documents = [...current];
  const indices = new Map(
    documents.map((document, index) => [document.id, index]),
  );
  for (const document of next) {
    const existing = indices.get(document.id);
    if (existing !== undefined) documents[existing] = document;
    else if (documents.length < MAXIMUM_VISIBLE_DOCUMENTS) {
      indices.set(document.id, documents.length);
      documents.push(document);
    }
  }
  return documents;
}

function prependDocuments(
  current: readonly FinanceDocumentSummary[],
  next: readonly FinanceDocumentSummary[],
): readonly FinanceDocumentSummary[] {
  const seen = new Set<string>();
  return [...next, ...current].flatMap((document) => {
    if (seen.has(document.id) || seen.size >= MAXIMUM_VISIBLE_DOCUMENTS)
      return [];
    seen.add(document.id);
    return [document];
  });
}

function documentLabel(
  document: FinanceDocumentSummary,
  locale: FinanceLocale,
): string {
  return `${document.mimeType ?? ''} · ${new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(document.updatedAt))}`;
}
function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function integerValue(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : '';
}
function moneyValue(value: unknown): { currency: string; minorUnits: string } {
  if (!value || typeof value !== 'object')
    return { currency: '', minorUnits: '' };
  const money = value as Record<string, unknown>;
  return {
    currency: textValue(money.currency),
    minorUnits:
      typeof money.minorUnits === 'string'
        ? money.minorUnits
        : integerValue(money.minorUnits),
  };
}

function invoicePaymentStatus(value: unknown): InvoicePaymentStatus {
  return invoicePaymentStatuses.includes(value as InvoicePaymentStatus)
    ? (value as InvoicePaymentStatus)
    : 'unknown';
}

function formatReviewCollectionRange(
  template: string,
  locale: FinanceLocale,
  start: number,
  end: number,
  total: number,
): string {
  const numbers = new Intl.NumberFormat(locale);
  return template
    .replace('{start}', numbers.format(start))
    .replace('{end}', numbers.format(end))
    .replace('{total}', numbers.format(total));
}

function ReviewCollectionEditor({
  collection,
  items,
  locale,
  disabled,
  page,
  revisionKey,
  onPageChange,
  onChangeItem,
}: {
  readonly collection: ReviewCollectionField;
  readonly items: readonly unknown[];
  readonly locale: FinanceLocale;
  readonly disabled: boolean;
  readonly page: number;
  readonly revisionKey: string;
  readonly onPageChange: (page: number) => void;
  readonly onChangeItem: (index: number, value: string) => void;
}) {
  const copy = financeCopy[locale];
  const totalPages = Math.max(
    1,
    Math.ceil(items.length / REVIEW_COLLECTION_PAGE_SIZE),
  );
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = currentPage * REVIEW_COLLECTION_PAGE_SIZE;
  const pageItems = items.slice(
    startIndex,
    startIndex + REVIEW_COLLECTION_PAGE_SIZE,
  );
  const start = items.length === 0 ? 0 : startIndex + 1;
  const end = startIndex + pageItems.length;
  const label = financeReviewLabel(locale, collection);
  return (
    <fieldset>
      <legend>{label}</legend>
      <p>{copy.reviewCollectionHint}</p>
      <p aria-live="polite">
        {formatReviewCollectionRange(
          copy.reviewCollectionRange,
          locale,
          start,
          end,
          items.length,
        )}
      </p>
      <div>
        <Button
          type="button"
          variant="quiet"
          disabled={disabled || currentPage === 0}
          onClick={() => onPageChange(currentPage - 1)}
        >
          {copy.reviewPreviousPage}
        </Button>
        <Button
          type="button"
          variant="quiet"
          disabled={
            disabled || currentPage >= totalPages - 1 || items.length === 0
          }
          onClick={() => onPageChange(currentPage + 1)}
        >
          {copy.reviewNextPage}
        </Button>
      </div>
      <ul>
        {pageItems.map((item, pageIndex) => {
          const index = startIndex + pageIndex;
          return (
            <li key={index}>
              <label>
                {copy.reviewCollectionItem} {index + 1}
                <textarea
                  defaultValue={JSON.stringify(item)}
                  key={`${revisionKey}-${collection}-${index}`}
                  onChange={(event) =>
                    onChangeItem(index, event.currentTarget.value)
                  }
                  disabled={disabled}
                />
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

function ReviewProposedRecordEditor({
  value,
  locale,
  disabled,
  revisionKey,
  onChange,
}: {
  readonly value: unknown;
  readonly locale: FinanceLocale;
  readonly disabled: boolean;
  readonly revisionKey: string;
  readonly onChange: (value: string) => void;
}) {
  const copy = financeCopy[locale];
  const label = financeReviewLabel(locale, 'proposedRecord');
  return (
    <fieldset>
      <legend>{label}</legend>
      <p>{copy.reviewProposedRecordHint}</p>
      <textarea
        aria-label={label}
        defaultValue={JSON.stringify(value)}
        key={`${revisionKey}-proposed-record`}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={disabled}
      />
    </fieldset>
  );
}

function ReviewEditor({
  draft,
  locale,
  disabled,
  onSave,
}: {
  readonly draft: FinanceDocumentReviewDraft;
  readonly locale: FinanceLocale;
  readonly disabled: boolean;
  readonly onSave: (envelope: FinanceDocumentEnvelopeV1) => void;
}) {
  const copy = financeCopy[locale];
  const [envelope, setEnvelope] = useState<EditableEnvelope>(() => ({
    ...draft.envelope,
  }));
  const [collectionPages, setCollectionPages] = useState<
    Partial<Record<ReviewCollectionField, number>>
  >({});
  useEffect(() => {
    setEnvelope({ ...draft.envelope });
    setCollectionPages({});
  }, [draft]);
  const setField = (field: string, value: unknown) =>
    setEnvelope((current) => ({ ...current, [field]: value }));
  const setMoney = (
    field: string,
    patch: { readonly currency?: string; readonly minorUnits?: string },
  ) => {
    const current = moneyValue(envelope[field]);
    const currency = (patch.currency ?? current.currency).trim().toUpperCase();
    const minorUnits = patch.minorUnits ?? current.minorUnits;
    setField(
      field,
      !currency && !minorUnits
        ? null
        : {
            currency,
            minorUnits: /^-?\d+$/u.test(minorUnits)
              ? Number(minorUnits)
              : minorUnits,
          },
    );
  };
  const changeCollectionItem = (
    collection: ReviewCollectionField,
    index: number,
    rawValue: string,
  ) => {
    try {
      const item = JSON.parse(rawValue) as unknown;
      setEnvelope((current) => {
        const currentItems = current[collection];
        if (
          !Array.isArray(currentItems) ||
          index < 0 ||
          index >= currentItems.length
        )
          return current;
        const nextItems = [...currentItems];
        nextItems[index] = item;
        return { ...current, [collection]: nextItems };
      });
    } catch {
      /* retain the complete, redacted item until its edit parses */
    }
  };
  const changeProposedRecord = (rawValue: string) => {
    try {
      setField('proposedRecord', JSON.parse(rawValue) as unknown);
    } catch {
      /* retain the reviewed proposal until its edit parses */
    }
  };
  return (
    <section aria-label={copy.review}>
      <h3>{copy.review}</h3>
      <p>{copy.reviewPending}</p>
      <p>
        <strong>{copy.documentType}:</strong> {textValue(envelope.documentType)}
      </p>
      <label htmlFor="finance-review-source-locale">{copy.sourceLocale}</label>
      <select
        id="finance-review-source-locale"
        value={textValue(envelope.sourceLocale)}
        onChange={(event) =>
          setField('sourceLocale', event.currentTarget.value)
        }
        disabled={disabled}
      >
        {(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR'] as const).map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <label htmlFor="finance-review-currency">{copy.currency}</label>
      <input
        id="finance-review-currency"
        value={textValue(envelope.currency)}
        maxLength={3}
        onChange={(event) =>
          setField('currency', event.currentTarget.value.toUpperCase() || null)
        }
        disabled={disabled}
      />
      {envelope.documentType === 'invoice' ? (
        <label htmlFor="finance-review-payment-status">
          {financeReviewLabel(locale, 'paymentStatus')}
          <select
            id="finance-review-payment-status"
            value={invoicePaymentStatus(envelope.paymentStatus)}
            onChange={(event) =>
              setField(
                'paymentStatus',
                event.currentTarget.value as InvoicePaymentStatus,
              )
            }
            disabled={disabled}
          >
            {invoicePaymentStatuses.map((status) => (
              <option key={status} value={status}>
                {copy.paymentStatus[status]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {textFields
        .filter((field) => field in envelope)
        .map((field) => (
          <label key={field}>
            {financeReviewLabel(locale, field)}
            <input
              value={textValue(envelope[field])}
              maxLength={2000}
              onChange={(event) =>
                setField(field, event.currentTarget.value || null)
              }
              disabled={disabled}
            />
          </label>
        ))}
      {dateFields
        .filter((field) => field in envelope)
        .map((field) => (
          <label key={field}>
            {financeReviewLabel(locale, field)}
            <input
              type="date"
              value={textValue(envelope[field])}
              onChange={(event) =>
                setField(field, event.currentTarget.value || null)
              }
              disabled={disabled}
            />
          </label>
        ))}
      {numberFields
        .filter((field) => field in envelope)
        .map((field) => (
          <label key={field}>
            {financeReviewLabel(locale, field)}
            <input
              inputMode="numeric"
              value={integerValue(envelope[field])}
              onChange={(event) =>
                setField(
                  field,
                  event.currentTarget.value === ''
                    ? null
                    : Number(event.currentTarget.value),
                )
              }
              disabled={disabled}
            />
          </label>
        ))}
      {moneyFields
        .filter((field) => field in envelope)
        .map((field) => {
          const money = moneyValue(envelope[field]);
          return (
            <fieldset key={field}>
              <legend>{financeReviewLabel(locale, field)}</legend>
              <label>
                {copy.currency}
                <input
                  value={money.currency}
                  maxLength={3}
                  onChange={(event) =>
                    setMoney(field, { currency: event.currentTarget.value })
                  }
                  disabled={disabled}
                />
              </label>
              <label>
                {copy.minorUnits}
                <input
                  inputMode="numeric"
                  value={money.minorUnits}
                  onChange={(event) =>
                    setMoney(field, { minorUnits: event.currentTarget.value })
                  }
                  disabled={disabled}
                />
              </label>
            </fieldset>
          );
        })}
      {reviewCollectionFields.map((collection) =>
        Array.isArray(envelope[collection]) ? (
          <ReviewCollectionEditor
            collection={collection}
            disabled={disabled}
            items={envelope[collection] as readonly unknown[]}
            key={collection}
            locale={locale}
            page={collectionPages[collection] ?? 0}
            revisionKey={draft.payloadHash}
            onChangeItem={(index, value) =>
              changeCollectionItem(collection, index, value)
            }
            onPageChange={(page) =>
              setCollectionPages((current) => ({
                ...current,
                [collection]: page,
              }))
            }
          />
        ) : null,
      )}
      {'proposedRecord' in envelope ? (
        <ReviewProposedRecordEditor
          disabled={disabled}
          locale={locale}
          revisionKey={draft.payloadHash}
          value={envelope.proposedRecord}
          onChange={changeProposedRecord}
        />
      ) : null}
      <Button
        disabled={disabled}
        onClick={() => onSave(envelope as FinanceDocumentEnvelopeV1)}
      >
        {copy.saveReview}
      </Button>
    </section>
  );
}

export function FinanceDocuments({
  locale,
  online,
  csrfToken,
  onRequestDeletion,
  onRequestCommit,
  onRequestMatchDecision,
  api: suppliedApi,
}: {
  readonly locale: FinanceLocale;
  readonly online: boolean;
  readonly csrfToken?: string;
  readonly onRequestDeletion: (
    document: FinanceDocumentSummary,
  ) => Promise<boolean> | boolean;
  readonly onRequestCommit: (
    review: FinanceDocumentReviewDraft,
  ) => Promise<boolean> | boolean;
  readonly onRequestMatchDecision: (input: {
    readonly documentId: string;
    readonly matchId: string;
    readonly decision: 'accept' | 'reject';
  }) => Promise<boolean> | boolean;
  readonly api?: FinanceDocumentApi;
}) {
  const copy = financeCopy[locale];
  const api = useMemo(
    () => suppliedApi ?? createFinanceDocumentApi(),
    [suppliedApi],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const loadedCursorsRef = useRef(new Set<string>());
  const [documents, setDocuments] = useState<readonly FinanceDocumentSummary[]>(
    [],
  );
  const [nextCursor, setNextCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading',
  );
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
  const [review, setReview] = useState<FinanceDocumentReviewDraft>();
  const [matches, setMatches] = useState<FinanceDocumentMatchList>();
  const [actionError, setActionError] = useState<string>();
  const [reviewSaving, setReviewSaving] = useState(false);
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const canMutate = online && Boolean(csrfToken);
  const authority = (operation: string) => ({
    csrfToken: csrfToken ?? '',
    idempotencyKey: mutationKey(operation),
  });
  const refresh = () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState('loading');
    setLoadingMore(false);
    setNextCursor(undefined);
    loadedCursorsRef.current.clear();
    void api
      .list({ limit: DOCUMENT_LIST_PAGE_SIZE, signal: controller.signal })
      .then(
        (page) => {
          if (!controller.signal.aborted) {
            setDocuments(() => appendDocuments([], page.items));
            setNextCursor(page.nextCursor);
            setState('ready');
          }
        },
        () => {
          if (!controller.signal.aborted) setState('unavailable');
        },
      );
  };
  const loadMore = () => {
    const cursor = nextCursor;
    if (!cursor || loadingMore || documents.length >= MAXIMUM_VISIBLE_DOCUMENTS)
      return;
    if (loadedCursorsRef.current.has(cursor)) {
      setNextCursor(undefined);
      setActionError(copy.documentsUnavailable);
      return;
    }
    loadedCursorsRef.current.add(cursor);
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoadingMore(true);
    void api
      .list({
        cursor,
        limit: DOCUMENT_LIST_PAGE_SIZE,
        signal: controller.signal,
      })
      .then(
        (page) => {
          if (!controller.signal.aborted) {
            setDocuments((current) => appendDocuments(current, page.items));
            if (
              page.nextCursor !== undefined &&
              loadedCursorsRef.current.has(page.nextCursor)
            ) {
              setNextCursor(undefined);
              setActionError(copy.documentsUnavailable);
            } else {
              setNextCursor(page.nextCursor);
            }
            setLoadingMore(false);
          }
        },
        () => {
          if (!controller.signal.aborted) {
            loadedCursorsRef.current.delete(cursor);
            setActionError(copy.documentsUnavailable);
            setLoadingMore(false);
          }
        },
      );
  };
  const updateDocument = (next: FinanceDocumentSummary) =>
    setDocuments((current) =>
      current.map((document) => (document.id === next.id ? next : document)),
    );
  useEffect(() => {
    if (online) refresh();
    else setState('unavailable');
    return () => controllerRef.current?.abort();
  }, [api, online]);
  const upload = async (files: FileList | null) => {
    const selected = Array.from(files ?? []).slice(0, MAXIMUM_FILES);
    if (inputRef.current) inputRef.current.value = '';
    if (!canMutate || selected.length === 0) return;
    setUploading(true);
    setUploadError(undefined);
    const uploaded: FinanceDocumentSummary[] = [];
    let failed = false;
    await runBounded(selected, async (file) => {
      try {
        uploaded.push(await api.upload(file, authority('upload')));
      } catch {
        failed = true;
      }
    });
    setDocuments((current) => prependDocuments(current, uploaded));
    setState('ready');
    if (failed) setUploadError(copy.uploadError);
    setUploading(false);
  };
  const openReview = async (document: FinanceDocumentSummary) => {
    setActionError(undefined);
    setMatches(undefined);
    setRequestState('idle');
    try {
      setReview(await api.readReview(document.id));
    } catch {
      setActionError(copy.reviewError);
    }
  };
  const saveReview = async (envelope: FinanceDocumentEnvelopeV1) => {
    if (!review || !canMutate) return;
    setReviewSaving(true);
    setActionError(undefined);
    try {
      setReview(
        await api.updateReview({
          id: review.documentId,
          expectedExtractionRevision: review.extractionRevision,
          envelope,
          ...authority('review'),
        }),
      );
    } catch {
      setActionError(copy.reviewError);
    } finally {
      setReviewSaving(false);
    }
  };
  const retry = async (document: FinanceDocumentSummary) => {
    if (!canMutate) return;
    setActionError(undefined);
    try {
      updateDocument(
        (await api.retry(document.id, authority('retry'))).document,
      );
    } catch {
      setActionError(copy.reviewError);
    }
  };
  const request = async (work: () => Promise<boolean> | boolean) => {
    if (!canMutate) return;
    setRequestState('requesting');
    setActionError(undefined);
    try {
      setRequestState((await work()) ? 'requested' : 'error');
    } catch {
      setRequestState('error');
    }
  };
  const openMatches = async (document: FinanceDocumentSummary) => {
    setActionError(undefined);
    try {
      setMatches(await api.readMatches(document.id));
    } catch {
      setActionError(copy.matchError);
    }
  };
  return (
    <section aria-labelledby="finance-documents-heading">
      <div className="section-title-row">
        <h2 id="finance-documents-heading">{copy.documents}</h2>
        <Button
          disabled={!canMutate || uploading}
          onClick={() => inputRef.current?.click()}
        >
          {copy.addDocuments}
        </Button>
      </div>
      <input
        ref={inputRef}
        accept="application/pdf,image/jpeg,image/png"
        aria-label={copy.addDocuments}
        hidden
        multiple
        type="file"
        onChange={(event) => void upload(event.currentTarget.files)}
      />
      <p>{copy.uploadHint}</p>
      <p>{copy.uploadLimit}</p>
      <p>
        <a
          href={copy.dataControlsUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {copy.dataControls}
        </a>
      </p>
      {uploading ? <p role="status">{copy.uploadBusy}</p> : null}
      {uploadError ? (
        <p className="inline-error" role="alert">
          {uploadError}
        </p>
      ) : null}
      {actionError ? (
        <p className="inline-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {state === 'unavailable' ? (
        <p role="status">{copy.documentsUnavailable}</p>
      ) : null}
      {state === 'ready' && documents.length === 0 ? (
        <p>{copy.noDocuments}</p>
      ) : null}
      {documents.length > 0 ? (
        <ul aria-label={copy.documents}>
          {documents.map((document) => (
            <li key={document.id}>
              <strong>{document.displayName ?? copy.deletedDocument}</strong>
              <span> {documentLabel(document, locale)}</span>
              {document.currency && document.currency !== 'CAD' ? (
                <span> · {copy.nonCad}</span>
              ) : null}
              <div>
                {document.state !== 'deleted' &&
                document.state !== 'deleting' &&
                document.displayName !== null ? (
                  <a download href={api.originalUrl(document.id)}>
                    {copy.openOriginal}
                  </a>
                ) : null}
                {document.state === 'failed' ? (
                  <Button
                    variant="quiet"
                    disabled={!canMutate}
                    onClick={() => void retry(document)}
                  >
                    {copy.retry}
                  </Button>
                ) : null}
                {document.state === 'awaiting-review' ? (
                  <Button
                    variant="quiet"
                    onClick={() => void openReview(document)}
                  >
                    {copy.review}
                  </Button>
                ) : null}
                {document.state === 'committed' ? (
                  <Button
                    variant="quiet"
                    onClick={() => void openMatches(document)}
                  >
                    {copy.matches}
                  </Button>
                ) : null}
                {document.state !== 'deleted' &&
                document.state !== 'deleting' ? (
                  <Button
                    variant="quiet"
                    disabled={!canMutate || requestState === 'requesting'}
                    onClick={() =>
                      void request(() => onRequestDeletion(document))
                    }
                  >
                    {copy.requestDeletion}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {nextCursor && documents.length < MAXIMUM_VISIBLE_DOCUMENTS ? (
        <Button
          busy={loadingMore}
          type="button"
          variant="quiet"
          onClick={loadMore}
        >
          {copy.loadMoreDocuments}
        </Button>
      ) : null}
      {review ? (
        <>
          <ReviewEditor
            draft={review}
            locale={locale}
            disabled={!canMutate || reviewSaving}
            onSave={(envelope) => void saveReview(envelope)}
          />
          <Button
            disabled={
              !canMutate || reviewSaving || requestState === 'requesting'
            }
            onClick={() => void request(() => onRequestCommit(review))}
          >
            {copy.commitReview}
          </Button>
        </>
      ) : null}
      {requestState === 'requesting' || requestState === 'requested' ? (
        <p role="status">{copy.actionRequested}</p>
      ) : null}
      {requestState === 'error' ? (
        <p className="inline-error" role="alert">
          {copy.actionRequestError}
        </p>
      ) : null}
      {matches ? (
        <section aria-label={copy.matches}>
          <h3>{copy.matches}</h3>
          <ul>
            {matches.items.map((match) => (
              <li key={match.id}>
                {match.recordType} · {match.scoreBasisPoints / 100}%
                <Button
                  variant="quiet"
                  disabled={!canMutate || requestState === 'requesting'}
                  onClick={() =>
                    void request(() =>
                      onRequestMatchDecision({
                        documentId: match.documentId,
                        matchId: match.id,
                        decision: 'accept',
                      }),
                    )
                  }
                >
                  {copy.accept}
                </Button>
                <Button
                  variant="quiet"
                  disabled={!canMutate || requestState === 'requesting'}
                  onClick={() =>
                    void request(() =>
                      onRequestMatchDecision({
                        documentId: match.documentId,
                        matchId: match.id,
                        decision: 'reject',
                      }),
                    )
                  }
                >
                  {copy.reject}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
