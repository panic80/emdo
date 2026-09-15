import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  SaveReviewedFinancePdfMappingSchema,
  type FinancePdfInspection,
  type FinanceReportMappingDefinition,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import { useAuth } from '../auth/auth-context.js';
import {
  blankPdfDraft,
  draftFromPdfSelection,
  emptyPdfCell,
  pdfCellText,
  pdfPageLimitation,
  pdfReviewCells,
  pdfSpanLimitation,
  pdfTargetLabel,
  updatePdfCell,
  verifiedPdfInspection,
  verifyPdfSelection,
  type PdfReviewCell,
  type PdfReviewDraft,
} from './finance-pdf-review-model.js';
import './finance-pdf-review.css';

type Props = {
  bookId: string;
  evidenceId: string;
  filename: string;
  role: string;
  definition?: FinanceReportMappingDefinition;
  questions?: string[];
  disabled: boolean;
  onSave: (
    input: z.infer<typeof SaveReviewedFinancePdfMappingSchema>,
  ) => Promise<void>;
  onDownload: () => void;
  onClose: () => void;
};
const bankFields = [
  'transactionDate',
  'description',
  'amount',
  'currency',
  'externalId',
  'fee',
  'commission',
  'tax',
  'principal',
  'interest',
] as const;
const positionFields = [
  'asOf',
  'instrumentIdentifier',
  'quantity',
  'currency',
  'description',
  'bookCost',
  'marketValue',
  'price',
  'accruedInterest',
] as const;
const fieldNames: Record<string, string> = {
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
const unchecked = () => ({ cells: false, context: false, omissions: false });
const extractionFindings: Record<string, string> = {
  'text-order-and-financial-meaning-unconfirmed':
    'Text order and financial meanings require your review.',
  'no-text-pages-may-be-blank-or-scanned':
    'Some pages have no extracted text. They may be blank or scanned.',
  'text-decoding-needs-review': 'Some text could not be decoded reliably.',
};

export function FinancePdfReview(props: Props) {
  const auth = useAuth();
  return (
    <PdfReviewEditor
      key={`${auth.sessionBinding}:${props.bookId}:${props.evidenceId}:${props.role}`}
      {...props}
    />
  );
}

function PdfReviewEditor({
  bookId,
  evidenceId,
  filename,
  role,
  definition,
  questions = [],
  disabled,
  onSave,
  onDownload,
  onClose,
}: Props) {
  const proposed = definition?.pdfSelection;
  const [viewPage, setViewPage] = useState(proposed?.page ?? 1);
  const [tablePage, setTablePage] = useState(proposed?.page ?? 1);
  const [inspection, setInspection] = useState<FinancePdfInspection>();
  const [tableInspection, setTableInspection] =
    useState<FinancePdfInspection>();
  const [draft, setDraft] = useState<PdfReviewDraft>(() =>
    blankPdfDraft(definition?.headers.length),
  );
  const [target, setTarget] = useState<string>();
  const [spanOffset, setSpanOffset] = useState(0),
    [rowOffset, setRowOffset] = useState(0);
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [reload, setReload] = useState(0);
  const [error, setError] = useState(''),
    [proposalWarning, setProposalWarning] = useState('');
  const [checks, setChecks] = useState(unchecked);
  const [reportType, setReportType] = useState(
    definition?.reportType ?? 'bank-transactions',
  );
  const [bindings, setBindings] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (definition?.bindings ?? []).map((binding) => [
        binding.field,
        binding.context
          ? 'context'
          : String(definition!.headers.indexOf(binding.column!)),
      ]),
    ),
  );
  const baseline = useRef<{ digest: string; inventory: string } | undefined>(
    undefined,
  );
  const initialized = useRef(false),
    mounted = useRef(true),
    submitting = useRef(false);
  const sourcePanel = useRef<HTMLElement>(null);
  const activeCell = useRef<HTMLButtonElement>(null);
  const canPrepare = ['administrator', 'preparer', 'approver'].includes(role);
  const locked = disabled || loading || saving || !canPrepare;
  const viewed = inspection?.selectedPage;
  const limitation = inspection ? pdfPageLimitation(inspection) : undefined;
  const cells = pdfReviewCells(draft);
  const active = cells.find((entry) => entry.key === target);
  const used = new Map(
    cells.flatMap(({ key, cell }) =>
      cell.spans.map((span) => [span.index, key] as const),
    ),
  );
  const unselected = tableInspection?.pages.reduce(
    (sum, page) => sum + page.spanCount,
    0,
  );
  const omittedCount = unselected === undefined ? 0 : unselected - used.size;
  const omittedPages =
    tableInspection?.pages.filter((page) => page.page !== tablePage) ?? [];
  const fields =
    reportType === 'bank-transactions' ? bankFields : positionFields;
  const requiredFields = new Set(
    reportType === 'bank-transactions'
      ? ['transactionDate', 'description', 'amount', 'currency']
      : ['asOf', 'instrumentIdentifier', 'quantity', 'currency'],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setInspection(undefined);
    setSpanOffset(0);
    setError('');
    void (async () => {
      try {
        const response = await fetch(
          `/api/v2/finance/books/${bookId}/evidence/${evidenceId}/pdf-inspection?page=${viewPage}`,
          {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (!response.ok)
          throw new Error(
            [401, 403].includes(response.status)
              ? 'Current book access does not permit this PDF inspection. The review has been cleared.'
              : response.status === 503
                ? 'PDF text inspection is not available right now. Retry when the service is available.'
                : response.status === 404
                  ? 'This PDF original or page is no longer available.'
                  : 'Unable to inspect this PDF original. Retry the inspection.',
          );
        const result = verifiedPdfInspection(await response.json(), {
          bookId,
          evidenceId,
          page: viewPage,
        });
        if (controller.signal.aborted) return;
        const inventory = JSON.stringify(result.pages);
        if (
          baseline.current &&
          (baseline.current.digest !== result.sourceDigest ||
            baseline.current.inventory !== inventory)
        )
          throw new Error(
            'The original or its page inventory changed. Close this review and open the current original.',
          );
        if (result.status !== 'unavailable')
          baseline.current ??= { digest: result.sourceDigest, inventory };
        setInspection(result);
        if (viewPage === tablePage) setTableInspection(result);
        if (!initialized.current) {
          initialized.current = true;
          if (proposed) {
            try {
              const selection = verifyPdfSelection(
                { ...proposed, acknowledgeUnselectedContent: true },
                result,
              );
              setDraft(draftFromPdfSelection(selection));
            } catch {
              setProposalWarning(
                'The proposed spans could not be matched to this original. Select the source cells again; no proposed text has been copied into the table.',
              );
              setDraft(blankPdfDraft(definition?.headers.length));
            }
          }
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(
            failure instanceof z.ZodError
              ? 'The complete PDF inspection response could not be verified.'
              : failure instanceof Error
                ? failure.message
                : 'Unable to inspect this original.',
          );
          setInspection(undefined);
          setTableInspection(undefined);
          setDraft(blankPdfDraft(definition?.headers.length));
          setChecks(unchecked());
          setTarget(undefined);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [bookId, evidenceId, viewPage, reload]); // The editor is remounted for source, session, role or proposal changes.

  function changeDraft(next: PdfReviewDraft) {
    setDraft(next);
    setChecks(unchecked());
  }
  function changeCell(key: string, cell: PdfReviewCell) {
    changeDraft(updatePdfCell(draft, key, cell));
  }
  function moveToSource() {
    requestAnimationFrame(() => {
      if (window.innerWidth <= 1050)
        sourcePanel.current?.scrollIntoView?.({ block: 'start' });
      sourcePanel.current?.focus({ preventScroll: true });
    });
  }
  function cellButton(key: string, cell: PdfReviewCell) {
    return (
      <button
        ref={target === key ? activeCell : undefined}
        type="button"
        className="finance-pdf-review__cell"
        disabled={locked || !tableInspection}
        aria-pressed={target === key}
        aria-label={`Select spans for ${pdfTargetLabel(key).toLowerCase()}`}
        onClick={() => {
          setTarget(key);
          setViewPage(tablePage);
          moveToSource();
        }}
      >
        <span>{pdfCellText(cell) || 'Choose source spans'}</span>
        <small>
          {cell.spans.length
            ? `Page ${tablePage} · spans ${cell.spans.map((span) => span.index).join(', ')}`
            : 'No text selected'}
        </small>
      </button>
    );
  }
  function useViewedPage() {
    if (!inspection || !viewed || limitation) return;
    setTablePage(viewPage);
    setTableInspection(inspection);
    changeDraft(blankPdfDraft(draft.headers.length));
    setTarget(undefined);
    setRowOffset(0);
    setProposalWarning(
      'The table page changed. Select every heading, row and context field on this page.',
    );
  }
  function fieldControl(field: (typeof fields)[number]) {
    return (
      <label key={field}>
        {fieldNames[field]}
        {requiredFields.has(field) ? ' · required' : ' · optional'}
        <select
          value={bindings[field] ?? ''}
          required={requiredFields.has(field)}
          onChange={(event) =>
            setBindings((old) => ({ ...old, [field]: event.target.value }))
          }
        >
          <option value="">
            {requiredFields.has(field) ? 'Choose its source' : 'Not mapped'}
          </option>
          {draft.headers.map((header, column) => (
            <option value={column} key={column} disabled={!header.spans.length}>
              {pdfCellText(header) ||
                `Heading ${column + 1} (select source spans)`}
            </option>
          ))}
          {(field === 'asOf' || field === 'currency') && (
            <option
              value="context"
              disabled={!draft.context[field].spans.length}
            >
              Selected {field === 'asOf' ? 'as-of date' : 'currency'} context
            </option>
          )}
        </select>
      </label>
    );
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      submitting.current ||
      locked ||
      !tableInspection ||
      !inspection ||
      limitation ||
      viewPage !== tablePage
    )
      return;
    const form = new FormData(event.currentTarget);
    setError('');
    submitting.current = true;
    setSaving(true);
    try {
      if (!checks.cells || !checks.context)
        throw new Error(
          'Complete the source-cell and context reviews before saving.',
        );
      const selection = verifyPdfSelection(
        {
          expectedSourceDigest: tableInspection.sourceDigest,
          page: tablePage,
          reviewedPageInventory: tableInspection.pages,
          headerCells: draft.headers,
          rows: draft.rows.map((row) => ({ cells: row })),
          context: {
            asOf: draft.context.asOf.spans.length ? draft.context.asOf : null,
            currency: draft.context.currency.spans.length
              ? draft.context.currency
              : null,
          },
          confirmedHeaderAndCellSelection: true,
          confirmedContextSelection: true,
          acknowledgeUnselectedContent: checks.omissions,
        },
        tableInspection,
      );
      const notes = String(form.get('notes') ?? '').trim();
      if (notes.length < 3)
        throw new Error(
          'Add a note explaining what you checked against the original.',
        );
      const resolutions = questions.map((question, index) => {
        const answer = String(form.get(`answer-${index}`) ?? '').trim();
        if (answer.length < 3)
          throw new Error(
            'Resolve each open question before saving a candidate.',
          );
        return `${question}\nResolution: ${answer}`;
      });
      const headers = draft.headers.map(pdfCellText);
      const payload = SaveReviewedFinancePdfMappingSchema.parse({
        evidenceId,
        proposal: {
          definition: {
            providerKey: form.get('providerKey'),
            reportName: form.get('reportName'),
            layoutVersion: form.get('layoutVersion'),
            reportType,
            headers,
            bindings: fields
              .filter(
                (field) =>
                  bindings[field] !== undefined && bindings[field] !== '',
              )
              .map((field) => ({
                field,
                column:
                  bindings[field] === 'context'
                    ? null
                    : headers[Number(bindings[field])],
                context: bindings[field] === 'context' ? field : null,
              })),
            dateFormat: form.get('dateFormat'),
            decimalSeparator: form.get('decimalSeparator'),
            groupingSeparator: form.get('groupingSeparator'),
            quantityUnit:
              reportType === 'investment-positions'
                ? form.get('quantityUnit')
                : null,
            identifierScheme:
              reportType === 'investment-positions'
                ? form.get('identifierScheme')
                : null,
            identifierNamespace:
              reportType === 'investment-positions'
                ? form.get('identifierNamespace')
                : null,
            valuationMultiplier:
              reportType === 'investment-positions'
                ? String(form.get('valuationMultiplier') ?? '').trim() || null
                : null,
            pdfSelection: selection,
          },
          rationale: [notes, ...resolutions].join('\n\n'),
          unresolvedQuestions: [],
        },
      });
      await onSave(payload);
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof z.ZodError
            ? failure.issues.map((issue) => issue.message).join(' ')
            : failure instanceof Error
              ? failure.message
              : 'Unable to save this PDF candidate.',
        );
    } finally {
      submitting.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <section className="finance-pdf-review" aria-label="PDF source review">
      <div className="finance-pdf-review__heading">
        <div>
          <span className="finance-pdf-review__eyebrow">Source review</span>
          <h4>Build a reviewed PDF table</h4>
          <p>{filename}</p>
        </div>
        <Button
          type="button"
          variant="quiet"
          onClick={onClose}
          disabled={saving}
        >
          Close PDF review
        </Button>
      </div>
      <p>
        Choose complete source spans and verify their meaning against the
        original. Saving creates a candidate. Approval and import review remain
        separate decisions.
      </p>
      <div className="finance-pdf-review__tools">
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || saving}
          onClick={onDownload}
        >
          Download original PDF
        </Button>
        <Button
          type="button"
          variant="quiet"
          disabled={loading || saving || disabled}
          onClick={() => {
            setChecks(unchecked());
            setReload((value) => value + 1);
          }}
        >
          Refresh PDF inspection
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {proposalWarning && (
        <p className="finance-pdf-review__note">{proposalWarning}</p>
      )}
      {loading && <p role="status">Inspecting the original PDF…</p>}
      {inspection && (
        <>
          <div className="finance-pdf-review__source-bar">
            <label>
              Inspect source page
              <select
                value={viewPage}
                disabled={loading || saving || disabled}
                onChange={(event) => setViewPage(Number(event.target.value))}
              >
                {inspection.pages.map((page) => (
                  <option key={page.page} value={page.page}>
                    Page {page.page} · {page.spanCount} spans
                    {page.textStatus === 'no-extractable-text'
                      ? ' · needs OCR'
                      : ''}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <strong>{inspection.totalPages ?? 'Unknown'} pages</strong>
              <span>One page per reviewed table</span>
            </div>
            <details>
              <summary>Original identity and page inventory</summary>
              <p>
                SHA-256: <code>{inspection.sourceDigest}</code>
              </p>
              <ul>
                {inspection.pages.map((page) => (
                  <li key={page.page}>
                    Page {page.page}: {page.textLength} text characters,{' '}
                    {page.spanCount} spans, {page.width} × {page.height},
                    rotation {page.rotation}° ·{' '}
                    {page.textStatus === 'text-extracted'
                      ? 'embedded text'
                      : 'no extractable text'}
                  </li>
                ))}
              </ul>
            </details>
          </div>
          {limitation && (
            <p className="finance-pdf-review__note" role="status">
              {limitation}
            </p>
          )}
          {inspection.issues.length > 0 && (
            <details>
              <summary>
                Extraction findings ({inspection.issues.length})
              </summary>
              <ul>
                {inspection.issues.map((issue, index) => (
                  <li key={index}>
                    {extractionFindings[issue] ?? issue.replaceAll('-', ' ')}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {viewPage !== tablePage && (
            <div className="finance-pdf-review__note">
              <p>
                You are inspecting page {viewPage}. The table still uses page{' '}
                {tablePage}. Changing its page clears all selected cells and
                context.
              </p>
              <Button
                type="button"
                variant="secondary"
                disabled={locked || !!limitation}
                onClick={useViewedPage}
              >
                Use page {viewPage} for this table
              </Button>
              <Button
                type="button"
                variant="quiet"
                onClick={() => setViewPage(tablePage)}
              >
                Return to table page {tablePage}
              </Button>
            </div>
          )}
          {viewed && (
            <div className="finance-pdf-review__workspace">
              <aside
                ref={sourcePanel}
                tabIndex={-1}
                className="finance-pdf-review__source"
                aria-label="Exact PDF source spans"
              >
                <div className="finance-pdf-review__section-title">
                  <span>01</span>
                  <div>
                    <h5>Exact source spans</h5>
                    <p>
                      {active && viewPage === tablePage
                        ? `Selecting for ${pdfTargetLabel(active.key).toLowerCase()}`
                        : 'Choose a table cell, then its source spans.'}
                    </p>
                  </div>
                </div>
                <p className="finance-pdf-review__hint">
                  Whole spans only. A span containing several columns cannot be
                  split. Use another original format if the PDF joins unrelated
                  fields.
                </p>
                <div
                  className="finance-pdf-review__spans"
                  role="region"
                  aria-label="Source span choices"
                  tabIndex={0}
                >
                  {viewed.spans
                    .slice(spanOffset, spanOffset + 30)
                    .map((span) => {
                      const owner =
                        viewPage === tablePage
                          ? used.get(span.index)
                          : undefined;
                      const issue = pdfSpanLimitation(span, viewed);
                      const taken = owner !== undefined && owner !== target;
                      return (
                        <label
                          key={span.index}
                          className="finance-pdf-review__span"
                        >
                          <input
                            type="checkbox"
                            aria-label={`Source span ${span.index}: ${span.text}`}
                            checked={
                              (viewPage === tablePage &&
                                active?.cell.spans.some(
                                  (value) => value.index === span.index,
                                )) ||
                              false
                            }
                            disabled={
                              locked ||
                              !!limitation ||
                              !active ||
                              viewPage !== tablePage ||
                              !!issue ||
                              taken ||
                              (active.cell.spans.length >= 20 &&
                                owner !== target)
                            }
                            onChange={(event) => {
                              if (!active) return;
                              changeCell(active.key, {
                                ...active.cell,
                                spans: event.target.checked
                                  ? [...active.cell.spans, span]
                                  : active.cell.spans.filter(
                                      (value) => value.index !== span.index,
                                    ),
                              });
                            }}
                          />
                          <span>
                            <small>
                              Span {span.index} · page {viewPage}
                            </small>
                            <span className="finance-pdf-review__exact-text">
                              {span.text || '(empty span)'}
                            </span>
                            {(issue || taken) && (
                              <small>
                                {issue ??
                                  `Used in ${pdfTargetLabel(owner!).toLowerCase()}`}
                              </small>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  {!viewed.spans.length && (
                    <p>No source spans are available on this page.</p>
                  )}
                </div>
                <div className="finance-pdf-review__pagination">
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={spanOffset === 0}
                    onClick={() =>
                      setSpanOffset((value) => Math.max(0, value - 30))
                    }
                  >
                    Previous spans
                  </Button>
                  <span>
                    {viewed.spans.length
                      ? `${spanOffset + 1}–${Math.min(spanOffset + 30, viewed.spans.length)} of ${viewed.spans.length}`
                      : '0 spans'}
                  </span>
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={spanOffset + 30 >= viewed.spans.length}
                    onClick={() => setSpanOffset((value) => value + 30)}
                  >
                    Next spans
                  </Button>
                </div>
                {active && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      activeCell.current?.scrollIntoView?.({ block: 'center' });
                      activeCell.current?.focus({ preventScroll: true });
                    }}
                  >
                    Back to {pdfTargetLabel(active.key).toLowerCase()}
                  </Button>
                )}
                <details>
                  <summary>Complete extracted page text</summary>
                  <pre
                    className="finance-pdf-review__page-text"
                    role="region"
                    aria-label={`Extracted text for page ${viewPage}`}
                    tabIndex={0}
                  >
                    {viewed.text || 'No extractable text.'}
                  </pre>
                </details>
              </aside>
              {canPrepare && (
                <div className="finance-pdf-review__table-panel">
                  <div className="finance-pdf-review__section-title">
                    <span>02</span>
                    <div>
                      <h5>Selected table</h5>
                      <p>
                        Page {tablePage} · {draft.headers.length} columns ·{' '}
                        {draft.rows.length} logical rows
                      </p>
                    </div>
                  </div>
                  <div className="finance-pdf-review__tools">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={
                        locked || !!limitation || draft.headers.length >= 100
                      }
                      onClick={() => {
                        const column = draft.headers.length;
                        changeDraft({
                          ...draft,
                          headers: [...draft.headers, emptyPdfCell()],
                          rows: draft.rows.length
                            ? draft.rows.map((row) => [...row, emptyPdfCell()])
                            : [[emptyPdfCell()]],
                        });
                        setTarget(`h:${column}`);
                      }}
                    >
                      Add column
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={
                        locked ||
                        !draft.headers.length ||
                        draft.rows.length >= 2000
                      }
                      onClick={() => {
                        changeDraft({
                          ...draft,
                          rows: [
                            ...draft.rows,
                            draft.headers.map(emptyPdfCell),
                          ],
                        });
                        setRowOffset(Math.floor(draft.rows.length / 10) * 10);
                      }}
                    >
                      Add row
                    </Button>
                  </div>
                  {!draft.headers.length && (
                    <div className="finance-pdf-review__empty">
                      <Icon name="plus" size={22} />
                      <p>
                        Add one column for each heading you intend to review. No
                        rows or columns are inferred from the PDF.
                      </p>
                    </div>
                  )}
                  {!!draft.headers.length && (
                    <div
                      className="finance-pdf-review__table-scroll"
                      role="region"
                      aria-label="Selected PDF table"
                      tabIndex={0}
                    >
                      <table>
                        <caption>Explicitly selected PDF cells</caption>
                        <thead>
                          <tr>
                            <th scope="col">Logical row</th>
                            {draft.headers.map((cell, column) => (
                              <th scope="col" key={column}>
                                <span>Heading {column + 1}</span>
                                {cellButton(`h:${column}`, cell)}
                                <button
                                  type="button"
                                  className="finance-pdf-review__remove"
                                  disabled={locked}
                                  aria-label={`Remove column ${column + 1}`}
                                  onClick={() => {
                                    changeDraft({
                                      ...draft,
                                      headers: draft.headers.filter(
                                        (_, index) => index !== column,
                                      ),
                                      rows: draft.rows.map((row) =>
                                        row.filter(
                                          (_, index) => index !== column,
                                        ),
                                      ),
                                    });
                                    setBindings({});
                                    setTarget(undefined);
                                  }}
                                >
                                  Remove column
                                </button>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {draft.rows
                            .slice(rowOffset, rowOffset + 10)
                            .map((row, index) => (
                              <tr key={rowOffset + index}>
                                <th scope="row">
                                  {rowOffset + index + 1}
                                  <button
                                    type="button"
                                    className="finance-pdf-review__remove"
                                    disabled={locked}
                                    aria-label={`Remove row ${rowOffset + index + 1}`}
                                    onClick={() => {
                                      changeDraft({
                                        ...draft,
                                        rows: draft.rows.filter(
                                          (_, i) => i !== rowOffset + index,
                                        ),
                                      });
                                      setTarget(undefined);
                                      setRowOffset(0);
                                    }}
                                  >
                                    Remove
                                  </button>
                                </th>
                                {row.map((cell, column) => (
                                  <td key={column}>
                                    {cellButton(
                                      `r:${rowOffset + index}:${column}`,
                                      cell,
                                    )}
                                  </td>
                                ))}
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {draft.rows.length > 10 && (
                    <div className="finance-pdf-review__pagination">
                      <Button
                        type="button"
                        variant="quiet"
                        disabled={rowOffset === 0}
                        onClick={() => setRowOffset((value) => value - 10)}
                      >
                        Previous rows
                      </Button>
                      <span>
                        {rowOffset + 1}–
                        {Math.min(rowOffset + 10, draft.rows.length)} of{' '}
                        {draft.rows.length}
                      </span>
                      <Button
                        type="button"
                        variant="quiet"
                        disabled={rowOffset + 10 >= draft.rows.length}
                        onClick={() => setRowOffset((value) => value + 10)}
                      >
                        Next rows
                      </Button>
                    </div>
                  )}
                  <p className="finance-pdf-review__hint">
                    Row numbers describe your selection order. Page and span
                    references identify the original source.
                  </p>
                  <div className="finance-pdf-review__context">
                    <div>
                      <h6>As-of date context · optional</h6>
                      {cellButton('c:asOf', draft.context.asOf)}
                    </div>
                    <div>
                      <h6>Currency context · optional</h6>
                      {cellButton('c:currency', draft.context.currency)}
                    </div>
                  </div>
                  {active && (
                    <div className="finance-pdf-review__active">
                      <h6>{pdfTargetLabel(active.key)}</h6>
                      <p className="finance-pdf-review__exact-text">
                        {pdfCellText(active.cell) ||
                          'Select whole spans from the source list.'}
                      </p>
                      {!!active.cell.spans.length && (
                        <>
                          <label>
                            Join selected spans with
                            <select
                              value={active.cell.joiner}
                              disabled={locked}
                              onChange={(event) =>
                                changeCell(active.key, {
                                  ...active.cell,
                                  joiner: event.target.value as '' | ' ',
                                })
                              }
                            >
                              <option value=" ">One space</option>
                              <option value="">No separator</option>
                            </select>
                          </label>
                          <ol>
                            {active.cell.spans.map((span, index) => (
                              <li key={span.index}>
                                <span>Span {span.index}</span>
                                <button
                                  type="button"
                                  disabled={locked || index === 0}
                                  aria-label={`Move span ${span.index} earlier`}
                                  onClick={() => {
                                    const spans = [...active.cell.spans];
                                    [spans[index - 1], spans[index]] = [
                                      spans[index]!,
                                      spans[index - 1]!,
                                    ];
                                    changeCell(active.key, {
                                      ...active.cell,
                                      spans,
                                    });
                                  }}
                                >
                                  Move earlier
                                </button>
                                <button
                                  type="button"
                                  disabled={locked}
                                  aria-label={`Remove span ${span.index} from cell`}
                                  onClick={() =>
                                    changeCell(active.key, {
                                      ...active.cell,
                                      spans: active.cell.spans.filter(
                                        (value) => value.index !== span.index,
                                      ),
                                    })
                                  }
                                >
                                  Remove
                                </button>
                              </li>
                            ))}
                          </ol>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {canPrepare && tableInspection && !pdfPageLimitation(tableInspection) && (
        <form
          className="finance-pdf-review__form"
          onSubmit={(event) => void save(event)}
          onChange={(event) => {
            const control = event.target;
            const name =
              control instanceof HTMLInputElement ||
              control instanceof HTMLSelectElement ||
              control instanceof HTMLTextAreaElement
                ? control.name
                : '';
            if (
              !name.startsWith('confirm') &&
              name !== 'notes' &&
              !name.startsWith('answer-')
            )
              setChecks(unchecked());
          }}
        >
          <div className="finance-pdf-review__section-title">
            <span>03</span>
            <div>
              <h5>Field meanings and review</h5>
              <p>
                Every value remains the exact joined source text until the
                server validates this candidate.
              </p>
            </div>
          </div>
          <fieldset disabled={locked}>
            <legend>Report identity</legend>
            <div className="finance-pdf-review__form-grid">
              <label>
                PDF report provider
                <input
                  name="providerKey"
                  required
                  maxLength={100}
                  defaultValue={definition?.providerKey ?? ''}
                />
              </label>
              <label>
                PDF report name
                <input
                  name="reportName"
                  required
                  maxLength={200}
                  defaultValue={definition?.reportName ?? ''}
                />
              </label>
              <label>
                Layout version
                <input
                  name="layoutVersion"
                  required
                  maxLength={100}
                  defaultValue={definition?.layoutVersion ?? ''}
                />
              </label>
              <label>
                Report section
                <select
                  value={reportType}
                  onChange={(event) => {
                    setReportType(event.target.value as typeof reportType);
                    setBindings({});
                  }}
                >
                  <option value="bank-transactions">Bank transactions</option>
                  <option value="investment-positions">
                    Investment positions
                  </option>
                </select>
              </label>
            </div>
          </fieldset>
          <fieldset disabled={locked}>
            <legend>Source field meanings</legend>
            <div className="finance-pdf-review__form-grid">
              {fields
                .filter((field) => requiredFields.has(field))
                .map(fieldControl)}
            </div>
            <details
              className="finance-pdf-review__optional-fields"
              open={
                fields.some(
                  (field) => !requiredFields.has(field) && !!bindings[field],
                ) || undefined
              }
            >
              <summary>Optional field meanings</summary>
              <div className="finance-pdf-review__form-grid">
                {fields
                  .filter((field) => !requiredFields.has(field))
                  .map(fieldControl)}
              </div>
            </details>
          </fieldset>
          <fieldset disabled={locked}>
            <legend>Formats and units</legend>
            <div className="finance-pdf-review__form-grid">
              <label>
                Date format
                <select
                  name="dateFormat"
                  defaultValue={definition?.dateFormat ?? ''}
                  required
                >
                  <option value="" disabled>
                    Choose the source format
                  </option>
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
                  defaultValue={definition?.decimalSeparator ?? ''}
                  required
                >
                  <option value="" disabled>
                    Choose the source format
                  </option>
                  <option value=".">Period (.)</option>
                  <option value=",">Comma (,)</option>
                </select>
              </label>
              <label>
                Thousands separator
                <select
                  name="groupingSeparator"
                  defaultValue={definition?.groupingSeparator ?? ''}
                >
                  <option value="">None</option>
                  <option value=",">Comma (,)</option>
                  <option value=".">Period (.)</option>
                  <option value=" ">Space</option>
                </select>
              </label>
              {reportType === 'investment-positions' && (
                <>
                  <label>
                    Quantity unit
                    <select
                      name="quantityUnit"
                      required
                      defaultValue={definition?.quantityUnit ?? ''}
                    >
                      <option value="" disabled>
                        Choose the source unit
                      </option>
                      {['share', 'unit', 'face-value', 'contract'].map(
                        (value) => (
                          <option key={value}>{value}</option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    Identifier scheme
                    <select
                      name="identifierScheme"
                      required
                      defaultValue={definition?.identifierScheme ?? ''}
                    >
                      <option value="" disabled>
                        Choose the identifier
                      </option>
                      {['ISIN', 'CUSIP', 'SEDOL', 'ticker', 'provider'].map(
                        (value) => (
                          <option key={value}>{value}</option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    Identifier namespace
                    <input
                      name="identifierNamespace"
                      required
                      maxLength={100}
                      defaultValue={definition?.identifierNamespace ?? ''}
                    />
                  </label>
                  <label>
                    Quote multiplier
                    <input
                      name="valuationMultiplier"
                      maxLength={100}
                      defaultValue={definition?.valuationMultiplier ?? ''}
                    />
                    <small>
                      Required when price is mapped. Enter the source's explicit
                      quote basis.
                    </small>
                  </label>
                </>
              )}
            </div>
          </fieldset>
          <div className="finance-pdf-review__coverage">
            <Icon name="info" size={18} />
            <div>
              <strong>Selected spans only</strong>
              <p>
                {used.size} selected spans. {omittedCount} unselected spans
                across {tableInspection.pages.length} pages.{' '}
                {omittedPages.length
                  ? `Other pages: ${omittedPages.map((page) => page.page).join(', ')}.`
                  : 'No other pages.'}{' '}
                Images and unextractable content are outside this table.
              </p>
              <p>
                Inspect the page inventory and omitted text, including subtotals
                or notes. This selection does not establish complete statement
                coverage.
              </p>
            </div>
          </div>
          <fieldset disabled={locked}>
            <legend>Confirm your review</legend>
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
              PDF source review notes
              <textarea name="notes" required minLength={3} maxLength={1500} />
            </label>
            <label className="finance-pdf-review__check">
              <input
                name="confirmCells"
                type="checkbox"
                required
                checked={checks.cells}
                onChange={(event) =>
                  setChecks((old) => ({ ...old, cells: event.target.checked }))
                }
              />
              <span>
                I checked every selected heading and cell, their order and field
                meanings against the original PDF.
              </span>
            </label>
            <label className="finance-pdf-review__check">
              <input
                name="confirmContext"
                type="checkbox"
                required
                checked={checks.context}
                onChange={(event) =>
                  setChecks((old) => ({
                    ...old,
                    context: event.target.checked,
                  }))
                }
              />
              <span>
                I checked date and currency context, including any context left
                unselected, and verified formats and units.
              </span>
            </label>
            <label className="finance-pdf-review__check">
              <input
                name="confirmOmissions"
                type="checkbox"
                required={omittedCount > 0 || omittedPages.length > 0}
                checked={checks.omissions}
                onChange={(event) =>
                  setChecks((old) => ({
                    ...old,
                    omissions: event.target.checked,
                  }))
                }
              />
              <span>
                I reviewed the omitted pages and unselected content and accept
                saving only this selected table.
              </span>
            </label>
            <Button
              disabled={
                locked ||
                viewPage !== tablePage ||
                !draft.headers.length ||
                !draft.rows.length
              }
            >
              {saving ? 'Saving PDF candidate…' : 'Save reviewed PDF candidate'}
            </Button>
            <p className="finance-pdf-review__hint">
              The server rechecks the original and derives the example from
              these exact spans. This action does not approve the mapping or
              post transactions.
            </p>
          </fieldset>
        </form>
      )}
    </section>
  );
}
