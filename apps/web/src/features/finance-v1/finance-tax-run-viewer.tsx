import { useEffect, useRef, useState } from 'react';
import { ReviewPrivateTaxCalculationRunSchema } from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';
import {
  readTaxJson,
  TaxRequestError,
  type TaxCaseDetail,
} from './finance-tax-model.js';
import {
  TaxRunReviewReceiptSchema,
  taxRunLabel,
  verifyTaxExport,
  verifyTaxRun,
  type TaxRunDetail,
} from './finance-tax-working-model.js';
import type { TaxCaseOperation } from './finance-tax-workspace.js';

const reportingLabels = {
  'official-whole-dollar-rounding': 'IRS elected whole-dollar reporting',
  'lossless-at-proven-precision': 'Exact at published form precision',
  'lossless-cents': 'Exact cents established',
  'blocked-input': 'Input is blocked',
  'field-proof-missing': 'Paper-field evidence missing',
  'dependency-unresolved': 'An input or earlier field is unresolved',
  'rounding-unproven': 'Rounding has not been established',
  'field-width-exceeded': 'Amount exceeds the paper field width',
} as const;
const incompleteLabels: Record<string, string> = {
  'annual-return-intermediate-and-final-rounding-unverified':
    'Intermediate and final return rounding has not been verified.',
  'independent-complete-return-fixtures-not-certified':
    'Independent complete-return examples still require review.',
  'independent-complete-return-fixtures-not-validated':
    'Independent complete-return examples still require validation.',
  'identification-and-all-applicable-form-field-completeness-not-certified':
    'Identification and all applicable form fields have not been established as complete.',
  'identification-and-all-applicable-form-field-completeness-not-validated':
    'Identification and all applicable form fields have not been established as complete.',
  'eligibility-exclusion-inventory-requires-independent-review':
    'Eligibility rules and exclusions still require independent review.',
};

export function TaxRunViewer({
  runId,
  detail,
  disabled,
  operate,
  onBack,
  onAccessUnavailable,
}: {
  runId: string;
  detail: TaxCaseDetail;
  disabled: boolean;
  operate: TaxCaseOperation;
  onBack: () => void;
  onAccessUnavailable: (message: string) => void;
}) {
  const [run, setRun] = useState<TaxRunDetail>();
  const [busy, setBusy] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [formId, setFormId] = useState('');
  const [fieldPage, setFieldPage] = useState(0);
  const [issuePage, setIssuePage] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [checked, setChecked] = useState(false);
  const [reviewId, setReviewId] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const base = `/api/v2/finance/tax/cases/${detail.caseId}/runs/${runId}`;
  const canReview =
    detail.caseRole === 'owner' || detail.caseRole === 'reviewer';
  function readFailure(failure: unknown, control: AbortController) {
    if (control.signal.aborted) return;
    setRun(undefined);
    setChecked(false);
    setReviewId('');
    const message =
      failure instanceof Error
        ? failure.message
        : 'This saved run could not be loaded.';
    setError(message);
    if (
      failure instanceof TaxRequestError &&
      ([401, 403].includes(failure.status) ||
        failure.code === 'finance-tax-source-revoked')
    )
      onAccessUnavailable(message);
  }
  async function load() {
    controller.current?.abort();
    const control = new AbortController();
    controller.current = control;
    setRun(undefined);
    setBusy(true);
    setError('');
    setConfirm(false);
    setChecked(false);
    try {
      const value = verifyTaxRun(
        await readTaxJson(base, control.signal),
        runId,
        detail,
      );
      if (control.signal.aborted) return;
      setRun(value);
      setFormId(value.schedules[0]?.formId ?? '');
      setFieldPage(0);
      setIssuePage(0);
      setReviewId(value.reviews[0]?.reviewId ?? '');
    } catch (failure) {
      readFailure(failure, control);
    } finally {
      if (!control.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, []);
  async function review() {
    if (!run || !checked || disabled) return;
    setError('');
    try {
      await operate(
        `runs/${runId}/reviews`,
        ReviewPrivateTaxCalculationRunSchema.parse({
          expectedOutputHash: run.summary.outputHash,
          acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
        }),
        TaxRunReviewReceiptSchema.refine(
          (receipt) =>
            receipt.runId === runId &&
            receipt.outputHash === run.summary.outputHash,
          'The review receipt does not match this saved output.',
        ),
        'Incomplete working papers reviewed. This acknowledgement does not make a complete or fileable return.',
      );
    } catch (failure) {
      if (!controller.current?.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Unable to save this review.',
        );
    }
  }
  async function download() {
    const control = controller.current;
    if (!run || !reviewId || !control || control.signal.aborted || downloading)
      return;
    setDownloading(true);
    setError('');
    setNotice('');
    try {
      const file = await verifyTaxExport(
        await readTaxJson(
          `${base}/export?reviewId=${encodeURIComponent(reviewId)}`,
          control.signal,
        ),
        run,
        reviewId,
      );
      if (control.signal.aborted) return;
      saveMemoryFile(file.filename, file.content, file.mimeType);
      setNotice(
        `Downloaded ${file.filename}. This is an incomplete working-paper CSV, not a tax return.`,
      );
    } catch (failure) {
      readFailure(failure, control);
    } finally {
      if (!control.signal.aborted) setDownloading(false);
    }
  }
  const schedule = run?.schedules.find((item) => item.formId === formId);
  const fields = schedule
    ? [...schedule.content].sort((a, b) => a.ordinal - b.ordinal)
    : [];
  const earlierSnapshot =
    !!run &&
    (run.summary.snapshotRevision !== detail.currentRevision ||
      run.summary.snapshotHash !== detail.snapshotHash);
  return (
    <section className="finance-tax-run" aria-label="Saved working-paper run">
      <div className="finance-tax-actions">
        <Button
          variant="quiet"
          disabled={downloading || disabled}
          onClick={onBack}
        >
          Back to run history
        </Button>
        <Button
          variant="quiet"
          disabled={busy || downloading || disabled}
          onClick={() => void load()}
        >
          Refresh saved run
        </Button>
      </div>
      {busy && (
        <p role="status">
          Verifying this saved run and its source authorizations…
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {run && (
        <>
          <div className="finance-tax-heading">
            <div>
              <span className="finance-tax-eyebrow">
                Immutable calculation record
              </span>
              <h3>{taxRunLabel(run.summary.status)}</h3>
              <p>
                Created {run.summary.createdAt} · questionnaire revision{' '}
                {run.summary.snapshotRevision}
              </p>
            </div>
            <span className="finance-tax-badge">Not fileable</span>
          </div>
          <div className="finance-tax-working-boundary">
            <Icon name="info" size={19} />
            <div>
              <strong>No final refund or balance owing is established.</strong>
              <p>
                These are incomplete working papers. Exact calculations and any
                paper-field amounts below are for review; they do not constitute
                a completed tax return.
              </p>
            </div>
          </div>
          {earlierSnapshot && (
            <p className="finance-tax-note">
              This run uses an earlier saved snapshot. Its inputs and approvals
              have not been transferred to questionnaire revision{' '}
              {detail.currentRevision}.
            </p>
          )}
          <div className="finance-tax-working-progress">
            <div>
              <span>Saved snapshot</span>
              <strong>
                {run.summary.snapshotRevision}
                <small>
                  {earlierSnapshot ? 'Earlier revision' : 'Current revision'}
                </small>
              </strong>
            </div>
            <div>
              <span>Input blockers</span>
              <strong>
                {run.output.issues.length}
                <small>Recorded assessment findings</small>
              </strong>
            </div>
            <div>
              <span>Working-paper review</span>
              <p>
                {run.reviews.length
                  ? `${run.reviews.length} saved review${run.reviews.length === 1 ? '' : 's'} · still incomplete`
                  : 'Awaiting explicit output review'}
              </p>
            </div>
          </div>
          {run.output.formAudit && (
            <section
              className="finance-tax-panel"
              aria-label="Required form data"
            >
              <h3>Required form data</h3>
              <p>
                {
                  run.output.formAudit.requirements.filter(
                    (r) => r.required && !r.satisfied,
                  ).length
                }{' '}
                required inputs are missing or need review.{' '}
                {run.output.formAudit.unresolvedCount} form fields still need
                input, applicability or reporting proof.
              </p>
              <p>
                Taxpayer signature and date remain manual and unperformed. These
                working papers are incomplete.
              </p>
              <ul>
                {run.output.formAudit.requirements.map((r) => (
                  <li key={r.key}>
                    {r.key
                      .replace(/^identity\./, 'Personal: ')
                      .replace(/^businessIdentity\./, 'Business: ')
                      .replace(/([a-z])([A-Z])/g, '$1 $2')}
                    :{' '}
                    {r.satisfied
                      ? r.sourceBinding
                        ? 'Input validated for this run'
                        : 'Not requested or not applicable'
                      : r.required
                        ? 'Missing or unreviewed'
                        : 'Conditional input not supplied'}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!run.output.issues.length && (
            <section
              className="finance-tax-run-blockers"
              aria-label="Run input blockers"
            >
              <h4>Inputs to resolve</h4>
              <ul className="finance-tax-findings">
                {run.output.issues
                  .slice(issuePage * 20, issuePage * 20 + 20)
                  .map((issue, index) => (
                    <li key={`${issue.path}:${index}`}>
                      <Icon name="info" size={16} />
                      <span>
                        {issue.message}
                        <small>Input reference: {issue.path}</small>
                      </span>
                    </li>
                  ))}
              </ul>
              {run.output.issues.length > 20 && (
                <div className="finance-tax-pagination">
                  <Button
                    variant="quiet"
                    disabled={!issuePage}
                    onClick={() => setIssuePage((value) => value - 1)}
                  >
                    Previous blockers
                  </Button>
                  <span>Page {issuePage + 1}</span>
                  <Button
                    variant="quiet"
                    disabled={(issuePage + 1) * 20 >= run.output.issues.length}
                    onClick={() => setIssuePage((value) => value + 1)}
                  >
                    Next blockers
                  </Button>
                </div>
              )}
              <p>
                Correct and review the saved inputs, then create a new run. This
                record will retain the original blockers.
              </p>
            </section>
          )}
          <section
            className="finance-tax-run-fields"
            aria-label="Exact working-paper fields"
          >
            <div className="finance-tax-heading">
              <div>
                <h4>Exact field calculations</h4>
                <p>
                  Exact calculations are shown alongside amounts established for
                  the form. A missing form amount is not zero.
                </p>
              </div>
              {run.schedules.length > 0 && (
                <label>
                  Schedule
                  <select
                    value={formId}
                    onChange={(event) => {
                      setFormId(event.target.value);
                      setFieldPage(0);
                    }}
                  >
                    {run.schedules.map((item) => (
                      <option key={item.formId} value={item.formId}>
                        {item.formId} · {item.content.length} fields
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {fields.length ? (
              <div
                className="finance-tax-table-scroll"
                role="region"
                aria-label={`${formId} exact fields`}
                tabIndex={0}
              >
                <table>
                  <caption className="sr-only">
                    {formId}: exact calculations, paper-field amounts and
                    provenance
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col">Exact calculation</th>
                      <th scope="col">Paper-field amount</th>
                      <th scope="col">Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields
                      .slice(fieldPage * 20, fieldPage * 20 + 20)
                      .map(({ field }) => (
                        <tr key={field.id}>
                          <th scope="row">
                            <strong>{field.label}</strong>
                            <small>
                              {field.form} · line {field.line}
                            </small>
                          </th>
                          <td data-label="Exact calculation">
                            <strong className="finance-tax-exact">
                              {field.reporting.status === 'blocked-input'
                                ? 'Not calculated'
                                : (field.exactDecimal ??
                                  `${field.exactRational.numerator} / ${field.exactRational.denominator}`)}
                            </strong>
                            <small>
                              {field.exactDecimal === null
                                ? 'Exact rational; no decimal approximation'
                                : 'Exact decimal'}
                            </small>
                            <details>
                              <summary>Rational value</summary>
                              <code>
                                {field.exactRational.numerator} /{' '}
                                {field.exactRational.denominator}
                              </code>
                            </details>
                          </td>
                          <td data-label="Paper-field amount">
                            <strong className="finance-tax-exact">
                              {field.reportableAmount ?? 'Not established'}
                            </strong>
                            <small>
                              {reportingLabels[field.reporting.status]}
                            </small>
                          </td>
                          <td data-label="Evidence">
                            <details>
                              <summary>Field provenance</summary>
                              <p>{field.locator}</p>
                              <small>Authority reference</small>
                              <code>{field.sourceId}</code>
                              <small>Input dependencies</small>
                              {field.dependencies.length ? (
                                field.dependencies.map((dependency) => (
                                  <code key={dependency}>{dependency}</code>
                                ))
                              ) : (
                                <p>No input dependencies recorded.</p>
                              )}
                              {!!field.reporting.blockedDependencies.length && (
                                <>
                                  <small>Unresolved dependencies</small>
                                  {field.reporting.blockedDependencies.map(
                                    (dependency) => (
                                      <code key={dependency}>{dependency}</code>
                                    ),
                                  )}
                                </>
                              )}
                              {field.reporting.fieldPath && (
                                <>
                                  <small>Paper field</small>
                                  <code>{field.reporting.fieldPath}</code>
                                </>
                              )}
                            </details>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="finance-tax-note">
                No field calculations were saved for this run. Review the input
                blockers.
              </p>
            )}
            {fields.length > 20 && (
              <div className="finance-tax-pagination">
                <Button
                  variant="quiet"
                  disabled={!fieldPage}
                  onClick={() => setFieldPage((value) => value - 1)}
                >
                  Previous fields
                </Button>
                <span>Page {fieldPage + 1}</span>
                <Button
                  variant="quiet"
                  disabled={(fieldPage + 1) * 20 >= fields.length}
                  onClick={() => setFieldPage((value) => value + 1)}
                >
                  Next fields
                </Button>
              </div>
            )}
          </section>
          <section className="finance-tax-run-limits">
            <h4>Why these working papers are incomplete</h4>
            {run.output.releaseBlockers.length ? (
              <ul>
                {run.output.releaseBlockers.map((blocker) => (
                  <li key={blocker}>
                    {incompleteLabels[blocker] ?? blocker.replaceAll('-', ' ')}
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                The run remains incomplete. No completed return or final amount
                has been established.
              </p>
            )}
          </section>
          <section
            className="finance-tax-working-next"
            aria-label="Working-paper review and export"
          >
            <div>
              <h4>Review this saved output</h4>
              <p>
                An owner or reviewer can acknowledge this exact output as
                incomplete working papers. A saved review permits an authorized
                CSV download and does not certify a tax return.
              </p>
            </div>
            <div className="finance-tax-actions">
              {canReview &&
                run.summary.status === 'incomplete-working-papers' && (
                  <Button
                    variant="secondary"
                    disabled={disabled || confirm || downloading}
                    onClick={() => {
                      setConfirm(true);
                      setChecked(false);
                    }}
                  >
                    Review incomplete working papers
                  </Button>
                )}
              {run.summary.status === 'blocked-input' && (
                <p>
                  Input blockers must be resolved in a new run before output
                  review or export.
                </p>
              )}
            </div>
          </section>
          {confirm && (
            <section
              className="finance-tax-confirm"
              aria-label="Confirm incomplete working-paper review"
            >
              <h4>Review this exact saved output</h4>
              <p>
                Questionnaire revision {run.summary.snapshotRevision} · package{' '}
                {run.summary.packageVersion}
              </p>
              <small>Output fingerprint</small>
              <code>{run.summary.outputHash}</code>
              <label className="finance-tax-check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(event) => setChecked(event.target.checked)}
                />
                <span>
                  I have reviewed these incomplete working papers, their exact
                  fields, sources and limitations. They are not a complete tax
                  return and are not fileable.
                </span>
              </label>
              <div className="finance-tax-actions">
                <Button
                  disabled={disabled || !checked}
                  onClick={() => void review()}
                >
                  Save incomplete working-paper review
                </Button>
                <Button
                  variant="quiet"
                  disabled={disabled}
                  onClick={() => setConfirm(false)}
                >
                  Cancel output review
                </Button>
              </div>
            </section>
          )}
          {!!run.reviews.length && (
            <section
              className="finance-tax-run-download"
              aria-label="Reviewed working-paper download"
            >
              <div>
                <h4>Download reviewed working papers</h4>
                <p>
                  The CSV includes the saved run, snapshot, package and review
                  references. Current source permissions are checked again for
                  each download.
                </p>
                <label>
                  Saved output review
                  <select
                    value={reviewId}
                    disabled={downloading}
                    onChange={(event) => setReviewId(event.target.value)}
                  >
                    {run.reviews.map((review) => (
                      <option key={review.reviewId} value={review.reviewId}>
                        {review.reviewedAt} · {review.reviewedBy}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Button
                disabled={disabled || downloading || !reviewId}
                onClick={() => void download()}
              >
                {downloading
                  ? 'Verifying export…'
                  : 'Download incomplete working papers (CSV)'}
              </Button>
            </section>
          )}
          <details className="finance-tax-history">
            <summary>Run and source provenance</summary>
            <dl className="finance-tax-facts">
              {[
                ['Run', run.summary.runId],
                ['Created by', run.summary.createdBy],
                ['Package version', run.summary.packageVersion],
                ['Snapshot fingerprint', run.summary.snapshotHash],
                ['Input fingerprint', run.summary.inputHash],
                ['Output fingerprint', run.summary.outputHash],
                ['Package fingerprint', run.summary.packageHash],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <code>{value}</code>
                  </dd>
                </div>
              ))}
            </dl>
            <h4>Exact declaration versions</h4>
            <ul className="finance-tax-working-review-list">
              {run.inputBinding.declarations.map((input) => (
                <li key={input.sourceId}>
                  <code>{input.sourceId}</code>
                  <small>Revision {input.sourceRevision}</small>
                  <code>{input.contentHash}</code>
                  {run.inputBinding.inputReviews
                    .filter((review) => review.sourceId === input.sourceId)
                    .map((review) => (
                      <p key={review.sourceId}>
                        Reviewed by {review.reviewedBy} · {review.reviewedAt}
                      </p>
                    ))}
                </li>
              ))}
            </ul>
            {!run.inputBinding.declarations.length && (
              <p>No declaration sources were bound.</p>
            )}
            <h4>Authorized book snapshots</h4>
            <ul className="finance-tax-working-review-list">
              {run.inputBinding.sourceBooks.map((book) => (
                <li key={book.authorizationId}>
                  <code>{book.bookId}</code>
                  <small>Book snapshot {book.snapshotRevision}</small>
                  <code>{book.snapshotHash}</code>
                  <small>
                    Authorization revision {book.authorizationRevision}
                  </small>
                  <code>{book.authorizationId}</code>
                </li>
              ))}
            </ul>
            {!run.inputBinding.sourceBooks.length && (
              <p>No book snapshots were bound.</p>
            )}
          </details>
          <details className="finance-tax-history">
            <summary>Authority documents ({run.authorities.length})</summary>
            <ul className="finance-tax-working-review-list">
              {run.authorities.map((authority) => (
                <li key={authority.id}>
                  {/^https?:\/\//u.test(authority.url) ? (
                    <a href={authority.url} target="_blank" rel="noreferrer">
                      {authority.formVersion}
                    </a>
                  ) : (
                    <strong>{authority.formVersion}</strong>
                  )}
                  <small>
                    {authority.id} · retrieved {authority.retrievedAt}
                  </small>
                  <code>{authority.documentHash}</code>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
