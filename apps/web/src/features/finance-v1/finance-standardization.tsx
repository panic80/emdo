import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  FinanceStandardizationRunSchema,
  type FinanceStandardizationRun,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import { useAuth } from '../auth/auth-context.js';
import {
  StandardizationRequestError,
  StandardizationUploadReceiptSchema,
  downloadStandardizationOriginal,
  readStandardizationList,
  readStandardizationOptions,
  readStandardizationRun,
  standardizationBase,
  standardizationChange,
  standardizationMutation,
  standardizationStart,
  standardizationUpload,
  type StandardizationAvailability,
  type StandardizationSource,
} from './finance-standardization-api.js';
import './finance-standardization.css';
import { FinanceStandardizationReconciliation } from './finance-standardization-reconciliation.js';

const statuses: Record<
  FinanceStandardizationRun['status'],
  { label: string; description: string }
> = {
  queued: {
    label: 'Waiting to start',
    description:
      'Your original and analysis authorization are saved. Progress will appear here when analysis begins.',
  },
  extracting: {
    label: 'Inspecting original',
    description:
      'The saved original is being inspected for source structure. Extracted content is not an approved financial interpretation.',
  },
  extracted: {
    label: 'Extraction saved',
    description:
      'Source observations are saved. Review the original and field meanings before creating and separately approving a mapping.',
  },
  proposing: {
    label: 'Preparing proposal',
    description:
      'EMDO is preparing a mapping candidate from the inspected source. Any uncertainties must still be reviewed.',
  },
  'needs-review': {
    label: 'Proposal saved',
    description:
      'A proposal is ready. Check its source selections and field meanings before a separate mapping approval.',
  },
  blocked: {
    label: 'Needs attention',
    description:
      'The analysis stopped with findings that need attention. Review the original and the next steps below.',
  },
  'authority-revoked': {
    label: 'Authorization changed',
    description:
      'The saved analysis no longer has the authority it needs. Current book permissions determine the available recovery actions.',
  },
  cancelled: {
    label: 'Cancelled',
    description:
      'This saved analysis has been cancelled. The original remains available through the book’s document permissions.',
  },
  indeterminate: {
    label: 'Outcome needs checking',
    description:
      'The final outcome could not be established. Refresh the saved record and inspect any linked candidate before starting another action.',
  },
};
const active = (status: FinanceStandardizationRun['status']) =>
  ['queued', 'extracting', 'proposing'].includes(status);
type Props = {
  bookId: string;
  role: string;
  sources: StandardizationSource[];
  refreshToken?: number;
  onOriginalSaved: () => Promise<void>;
  onOpenMapping: (run: FinanceStandardizationRun) => Promise<void>;
  onReviewSource: (run: FinanceStandardizationRun) => Promise<void>;
  onAccessUnavailable: (message: string) => void;
};
type Confirmation =
  | { kind: 'start'; source: StandardizationSource }
  | { kind: 'retry' | 'cancel'; run: FinanceStandardizationRun };
export function FinanceStandardization(props: Props) {
  const auth = useAuth();
  return (
    <StandardizationWorkspace
      key={`${auth.sessionBinding}:${auth.state}:${props.bookId}:${props.role}`}
      {...props}
      {...(auth.csrfToken ? { csrfToken: auth.csrfToken } : {})}
      authenticated={!auth.state || auth.state === 'authenticated'}
    />
  );
}
function StandardizationWorkspace({
  bookId,
  role,
  sources,
  onOriginalSaved,
  onOpenMapping,
  onReviewSource,
  onAccessUnavailable,
  csrfToken,
  authenticated,
  refreshToken,
}: Props & { csrfToken?: string; authenticated: boolean }) {
  const [availability, setAvailability] =
    useState<StandardizationAvailability>();
  const [page, setPage] =
    useState<Awaited<ReturnType<typeof readStandardizationList>>>();
  const [offset, setOffset] = useState(0);
  const [run, setRun] = useState<FinanceStandardizationRun>();
  const [busy, setBusy] = useState(true),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [file, setFile] = useState<File>();
  const [authorize, setAuthorize] = useState(false);
  const [savedSource, setSavedSource] = useState<StandardizationSource>();
  const [sourceId, setSourceId] = useState('');
  const [confirm, setConfirm] = useState<Confirmation>();
  const [checked, setChecked] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const alive = useRef(true),
    working = useRef(false);
  const readController = useRef<AbortController | undefined>(undefined),
    actionController = useRef<AbortController | undefined>(undefined);
  const selectedId = useRef<string | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const postUpload = useRef(standardizationMutation()).current,
    postRun = useRef(standardizationMutation()).current;
  const canPrepare =
    authenticated && ['administrator', 'preparer', 'approver'].includes(role);
  const readLocked = saving || busy || uncertain || !authenticated;
  const locked = readLocked || !csrfToken;
  const source = sources.find((item) => item.id === sourceId);
  function supports(format: string) {
    return (
      availability?.registry.adapters.some(
        (adapter) =>
          adapter.availability === 'implemented' &&
          adapter.workflow === 'dynamic-mapping' &&
          adapter.formats.some((candidate) => candidate === format),
      ) ?? false
    );
  }
  function failed(cause: unknown, clear = false) {
    const message =
      cause instanceof z.ZodError
        ? 'This saved analysis response could not be verified. Refresh before continuing.'
        : cause instanceof Error
          ? cause.message
          : 'Unable to load or save this analysis.';
    setError(message);
    if (clear) {
      setPage(undefined);
      setRun(undefined);
      setAvailability(undefined);
    }
    if (
      cause instanceof StandardizationRequestError &&
      [401, 403].includes(cause.status)
    ) {
      setRun(undefined);
      setPage(undefined);
      setSavedSource(undefined);
      setConfirm(undefined);
      selectedId.current = undefined;
      onAccessUnavailable(message);
    }
  }
  async function refresh(nextOffset = offset, quiet = false) {
    readController.current?.abort();
    const control = new AbortController();
    readController.current = control;
    if (!quiet) {
      setBusy(true);
      setError('');
      setConfirm(undefined);
      setChecked(false);
    }
    try {
      const [options, list, selected] = await Promise.all([
        readStandardizationOptions(bookId, control.signal),
        readStandardizationList(bookId, nextOffset, control.signal),
        selectedId.current
          ? readStandardizationRun(bookId, selectedId.current, control.signal)
          : Promise.resolve(undefined),
      ]);
      if (!alive.current || control.signal.aborted) return;
      setAvailability(options);
      setPage(list);
      setRun(selected);
      setOffset(nextOffset);
      setUncertain(false);
    } catch (cause) {
      if (alive.current && !control.signal.aborted) failed(cause, true);
    } finally {
      if (alive.current && !control.signal.aborted) setBusy(false);
      if (readController.current === control)
        readController.current = undefined;
    }
  }
  useEffect(() => {
    alive.current = true;
    if (authenticated) void refresh(0);
    else {
      setBusy(false);
      setError('Sign in to access saved report analyses.');
    }
    return () => {
      alive.current = false;
      readController.current?.abort();
      actionController.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (refreshToken && authenticated) void refresh(offset);
  }, [refreshToken]);
  const hasActive =
    !!page?.runs.some((item) => active(item.status)) ||
    (!!run && active(run.status));
  useEffect(() => {
    if (!hasActive || confirm || !authenticated) return;
    const tick = () => {
      if (
        document.visibilityState !== 'hidden' &&
        !working.current &&
        !readController.current
      )
        void refresh(offset, true);
    };
    const timer = window.setInterval(tick, 5000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [hasActive, confirm, offset, authenticated]);
  useEffect(() => {
    if (!run || !detailHeading.current) return;
    detailHeading.current.focus({ preventScroll: true });
    detailHeading.current.scrollIntoView?.({
      block: 'start',
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }, [run?.id]);
  async function action(
    work: (signal: AbortSignal) => Promise<void>,
    mutation: boolean | (() => boolean) = true,
  ) {
    if (working.current || !authenticated) return;
    working.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    readController.current?.abort();
    const control = new AbortController();
    actionController.current = control;
    try {
      await work(control.signal);
    } catch (cause) {
      if (alive.current && !control.signal.aborted) {
        failed(cause);
        if (typeof mutation === 'function' ? mutation() : mutation)
          setUncertain(true);
      }
    } finally {
      working.current = false;
      if (alive.current && !control.signal.aborted) {
        setSaving(false);
        setBusy(false);
      }
    }
  }
  async function start(original: StandardizationSource, signal: AbortSignal) {
    const receipt = await postRun(
      `${standardizationBase(bookId)}/standardizations`,
      standardizationStart(original),
      FinanceStandardizationRunSchema.refine(
        (value) =>
          value.bookId === bookId &&
          value.evidenceId === original.id &&
          value.sourceDigest === original.sourceDigest,
        'Analysis receipt does not match the saved original.',
      ),
      signal,
      csrfToken,
    );
    if (!alive.current || signal.aborted) return;
    selectedId.current = receipt.id;
    setRun(receipt);
    setConfirm(undefined);
    setChecked(false);
    await refresh(0);
    if (alive.current && !signal.aborted)
      setNotice(
        'Analysis saved. It can be resumed here after reload. Source review, mapping approval and financial review remain separate.',
      );
  }
  function saveOriginal(analyze: boolean) {
    if (!canPrepare || locked) return;
    if (analyze && (!authorize || !availability?.ready)) return;
    let dispatched = false;
    void action(
      async (signal) => {
        if (!file)
          throw new Error('Choose the original CSV, XLSX or PDF report.');
        const payload = await standardizationUpload(file);
        if (signal.aborted || !alive.current) return;
        if (analyze && !supports(payload.format))
          throw new Error(
            'Background mapping analysis is not available for this format. Save the original for manual review.',
          );
        dispatched = true;
        const receipt = await postUpload(
          `${standardizationBase(bookId)}/evidence`,
          payload,
          StandardizationUploadReceiptSchema,
          signal,
          csrfToken,
        );
        if (signal.aborted || !alive.current) return;
        const original = {
          id: receipt.id,
          filename: payload.filename,
          format: payload.format,
          ...(receipt.sourceDigest
            ? { sourceDigest: receipt.sourceDigest }
            : {}),
        };
        setSavedSource(original);
        setFile(undefined);
        setAuthorize(false);
        if (fileInput.current) fileInput.current.value = '';
        await onOriginalSaved();
        if (signal.aborted || !alive.current) return;
        if (analyze) {
          if (!original.sourceDigest)
            throw new Error(
              'The original was saved, but its fingerprint was not returned. Refresh saved originals before starting analysis; do not upload it again.',
            );
          await start(original, signal);
        } else
          setNotice(
            `${payload.format.toUpperCase()} original saved securely. Start a saved analysis when available, or use the manual source-review controls below.`,
          );
      },
      () => dispatched,
    );
  }
  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveOriginal(false);
  }
  function reviewAction(value: Confirmation) {
    setConfirm(value);
    setChecked(false);
    setNotice('');
  }
  function apply() {
    if (!confirm || !checked || locked) return;
    const reviewed = confirm;
    void action(async (signal) => {
      if (reviewed.kind === 'start') {
        await start(reviewed.source, signal);
        return;
      }
      const saved = await postRun(
        `${standardizationBase(bookId)}/standardizations/${reviewed.run.id}/${reviewed.kind}`,
        standardizationChange(reviewed.run),
        FinanceStandardizationRunSchema.refine(
          (value) =>
            value.id === reviewed.run.id &&
            value.bookId === bookId &&
            value.evidenceId === reviewed.run.evidenceId &&
            value.sourceDigest === reviewed.run.sourceDigest,
          'Analysis response does not match the reviewed original.',
        ),
        signal,
        csrfToken,
      );
      if (!alive.current || signal.aborted) return;
      selectedId.current = saved.id;
      setRun(saved);
      setConfirm(undefined);
      setChecked(false);
      await refresh();
      if (alive.current && !signal.aborted)
        setNotice(
          reviewed.kind === 'retry'
            ? 'Retry saved for this original. Check the current analysis state below.'
            : 'Cancellation response saved. Check the final state below; the original has not been deleted.',
        );
    });
  }
  function open(runId: string) {
    selectedId.current = runId;
    setRun(undefined);
    void refresh();
  }
  const extraction = run?.extraction;
  return (
    <section
      className="finance-standardization"
      aria-label="Saved report analysis"
    >
      <div className="finance-standardization-heading">
        <div>
          <span className="finance-standardization-eyebrow">
            Original → inspection → proposal → review
          </span>
          <h4>Saved report analysis</h4>
          <p>
            Inspect an original, review its mapping proposal and resume saved
            work from this list.
          </p>
        </div>
        <Button
          type="button"
          variant="quiet"
          disabled={saving || busy || !authenticated}
          onClick={() => void refresh()}
        >
          Refresh saved analyses
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {uncertain && (
        <p className="finance-standardization-note">
          The last action needs a status check. Refresh saved analyses before
          retrying. A saved original does not need to be uploaded again.
        </p>
      )}
      {availability && !availability.ready && (
        <div className="finance-standardization-note">
          <strong>Background analysis is not available right now.</strong>
          <p>
            You can save originals and continue with the manual review controls.
            This does not change the status of previously saved proposals.
          </p>
        </div>
      )}
      {canPrepare && (
        <form className="finance-standardization-upload" onSubmit={upload}>
          <div>
            <h5>Start with an original</h5>
            <p>
              CSV, XLSX, PDF, PNG, JPEG or WebP · maximum 2 MiB. Images require
              a saved OCR extraction and visual review. PDF inspection reads
              embedded text; image-only PDF pages are not supported.
            </p>
          </div>
          <label>
            Report or image original
            <input
              ref={fileInput}
              type="file"
              name="file"
              accept=".csv,.xlsx,.pdf,.png,.jpg,.jpeg,.webp,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/png,image/jpeg,image/webp"
              required
              disabled={saving}
              onChange={(event) => {
                setFile(event.target.files?.[0]);
                setAuthorize(false);
                setSavedSource(undefined);
              }}
            />
          </label>
          <label className="finance-standardization-check">
            <input
              type="checkbox"
              checked={authorize}
              disabled={locked || !availability?.ready}
              onChange={(event) => setAuthorize(event.target.checked)}
            />
            <span>
              Allow EMDO to inspect this saved original and prepare a proposal,
              even after this page closes. This does not approve a mapping or
              post financial records.
            </span>
          </label>
          <div className="finance-standardization-actions">
            <Button
              type="button"
              disabled={locked || !availability?.ready || !authorize || !file}
              onClick={() => saveOriginal(true)}
            >
              Save original and start analysis
            </Button>
            <Button type="submit" variant="secondary" disabled={locked}>
              Save original report
            </Button>
          </div>
        </form>
      )}
      {savedSource && (
        <div className="finance-standardization-saved">
          <Icon name="check" size={17} />
          <div>
            <strong>{savedSource.filename} is saved</strong>
            <p>
              Use its saved record to start or resume analysis; another upload
              is not required.
            </p>
          </div>
          {canPrepare &&
            savedSource.sourceDigest &&
            availability?.ready &&
            supports(savedSource.format) && (
              <Button
                type="button"
                variant="quiet"
                disabled={locked}
                onClick={() =>
                  reviewAction({ kind: 'start', source: savedSource })
                }
              >
                Review analysis for saved original
              </Button>
            )}
        </div>
      )}
      {canPrepare && !!sources.length && (
        <details className="finance-standardization-existing">
          <summary>Analyze an existing saved original</summary>
          <label>
            Saved original for analysis
            <select
              value={sourceId}
              disabled={locked}
              onChange={(event) => setSourceId(event.target.value)}
            >
              <option value="">Choose an original on this page</option>
              {sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.filename} · {item.format.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <p>
            Use the original-list controls below to browse other pages. Analysis
            uses the saved source fingerprint.
          </p>
          {source && !source.sourceDigest && (
            <p className="finance-standardization-note">
              A verified source fingerprint is not available in this response.
              Refresh the originals before starting analysis.
            </p>
          )}
          {source && !supports(source.format) && (
            <p className="finance-standardization-note">
              This format does not use background mapping analysis. Check format
              availability below for its manual review path.
            </p>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={
              locked ||
              !availability?.ready ||
              !source?.sourceDigest ||
              !supports(source?.format ?? '')
            }
            onClick={() => source && reviewAction({ kind: 'start', source })}
          >
            Review analysis request
          </Button>
        </details>
      )}
      {confirm && (
        <section
          className="finance-standardization-confirm"
          aria-label="Confirm saved analysis action"
        >
          <h5>
            {confirm.kind === 'start'
              ? 'Authorize analysis of this saved original'
              : confirm.kind === 'retry'
                ? 'Retry this saved analysis'
                : 'Cancel this saved analysis'}
          </h5>
          <p>
            <strong>
              {confirm.kind === 'start'
                ? confirm.source.filename
                : confirm.run.filename}
            </strong>
          </p>
          <p>
            {confirm.kind === 'cancel'
              ? 'Cancel the run’s remaining analysis authority. Its original will not be deleted. Check the resulting saved state before taking another action.'
              : 'Authorize a bounded inspection and mapping proposal for this exact saved original. It may continue after this page closes. Source review, mapping approval and financial review remain separate.'}
          </p>
          {confirm.kind !== 'start' && (
            <p>
              Saved revision {confirm.run.revision} · attempt{' '}
              {confirm.run.attempt}
            </p>
          )}
          <details>
            <summary>Exact source fingerprint</summary>
            <code>
              {confirm.kind === 'start'
                ? confirm.source.sourceDigest
                : confirm.run.sourceDigest}
            </code>
          </details>
          <label className="finance-standardization-check">
            <input
              type="checkbox"
              checked={checked}
              disabled={locked}
              onChange={(event) => setChecked(event.target.checked)}
            />
            <span>
              {confirm.kind === 'cancel'
                ? 'Cancel this saved analysis without deleting its original.'
                : 'I authorize this analysis of the exact saved source. It cannot approve or post financial records.'}
            </span>
          </label>
          <div className="finance-standardization-actions">
            <Button type="button" disabled={locked || !checked} onClick={apply}>
              {confirm.kind === 'start'
                ? 'Start saved analysis'
                : confirm.kind === 'retry'
                  ? 'Retry saved analysis'
                  : 'Cancel saved analysis'}
            </Button>
            <Button
              type="button"
              variant="quiet"
              disabled={saving}
              onClick={() => setConfirm(undefined)}
            >
              Keep reviewing
            </Button>
          </div>
        </section>
      )}
      <div className="finance-standardization-library">
        <div className="finance-standardization-heading">
          <div>
            <h5>Saved analyses</h5>
            <p>
              Every status below comes from the saved record. Active records
              refresh while this page is visible.
            </p>
          </div>
          {busy && <span role="status">Checking saved state…</span>}
        </div>
        {page && !page.runs.length && (
          <div className="finance-standardization-empty">
            <Icon name="finance" size={24} />
            <strong>No saved analyses on this page</strong>
            <p>
              Save an original and explicitly start its analysis, or choose an
              existing original above.
            </p>
          </div>
        )}
        {!!page?.runs.length && (
          <ul className="finance-standardization-run-list">
            {page.runs.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={saving}
                  aria-current={run?.id === item.id ? 'true' : undefined}
                  onClick={() => open(item.id)}
                  aria-label={`Open saved analysis: ${item.filename}`}
                >
                  <span
                    className={`finance-standardization-dot${active(item.status) ? ' is-active' : ''}`}
                  />
                  <span>
                    <strong>{item.filename}</strong>
                    <small>
                      {item.format.toUpperCase()} · updated {item.updatedAt}
                    </small>
                  </span>
                  <span className="finance-standardization-badge">
                    {statuses[item.status].label}
                  </span>
                  <Icon name="chevron-right" size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {page && (
          <div className="finance-standardization-pagination">
            <Button
              type="button"
              variant="quiet"
              disabled={saving || busy || !offset}
              onClick={() => void refresh(Math.max(0, offset - 50))}
            >
              Previous analyses
            </Button>
            <span>Page {Math.floor(offset / 50) + 1}</span>
            <Button
              type="button"
              variant="quiet"
              disabled={saving || busy || page.nextOffset === null}
              onClick={() => void refresh(page.nextOffset!)}
            >
              Next analyses
            </Button>
          </div>
        )}
      </div>
      {run && (
        <section
          className="finance-standardization-detail"
          aria-label="Saved analysis detail"
        >
          <div className="finance-standardization-heading">
            <div>
              <span className="finance-standardization-eyebrow" role="status">
                {statuses[run.status].label}
              </span>
              <h5 ref={detailHeading} tabIndex={-1}>
                {run.filename}
              </h5>
              <p>{statuses[run.status].description}</p>
            </div>
            <Button
              type="button"
              variant="quiet"
              disabled={saving || busy}
              onClick={() =>
                void action(
                  (signal) => downloadStandardizationOriginal(run, signal),
                  false,
                )
              }
            >
              Download analysis original
            </Button>
          </div>
          <ol
            className="finance-standardization-stages"
            aria-label="Saved analysis stages"
          >
            <li data-state="saved">
              <span>01</span>
              <strong>Original saved</strong>
              <small>Exact source fingerprint</small>
            </li>
            <li
              data-state={
                extraction
                  ? 'saved'
                  : active(run.status)
                    ? 'waiting'
                    : 'stopped'
              }
            >
              <span>02</span>
              <strong>
                {extraction ? 'Inspection saved' : 'Source inspection'}
              </strong>
              <small>
                {extraction
                  ? `Revision ${extraction.revision}`
                  : 'No saved extraction yet'}
              </small>
            </li>
            <li data-state={run.proposal ? 'saved' : 'waiting'}>
              <span>03</span>
              <strong>
                {run.proposal ? 'Proposal saved' : 'Mapping proposal'}
              </strong>
              <small>
                {run.proposal
                  ? `Candidate version ${run.proposal.mappingVersion}`
                  : 'No candidate saved'}
              </small>
            </li>
            <li data-state={run.reviewedMapping ? 'saved' : 'waiting'}>
              <span>04</span>
              <strong>Separate review</strong>
              <small>
                {run.reviewedMapping
                  ? `Linked version ${run.reviewedMapping.mappingVersion} · ${run.reviewedMapping.status}`
                  : 'Approval is not granted by analysis'}
              </small>
            </li>
          </ol>
          {extraction && (
            <div className="finance-standardization-extraction">
              <h6>Source inspection</h6>
              <dl>
                <div>
                  <dt>Tables found</dt>
                  <dd>{extraction.tableCount}</dd>
                </div>
                <div>
                  <dt>Sheets inspected</dt>
                  <dd>{extraction.sheetCount}</dd>
                </div>
                <div>
                  <dt>Pages inspected</dt>
                  <dd>{extraction.pageCount}</dd>
                </div>
                <div>
                  <dt>Coverage</dt>
                  <dd>
                    {extraction.truncated
                      ? 'Limited extraction'
                      : 'Bounded extraction saved'}
                  </dd>
                </div>
              </dl>
              {extraction.status === 'needs-ocr' && (
                <p className="finance-standardization-note">
                  <strong>Image-only content needs OCR.</strong> OCR is not
                  available. Use a text-based original or another supported
                  format.
                </p>
              )}
              {extraction.status === 'unsupported' && (
                <p className="finance-standardization-note">
                  This source structure is not supported by the available
                  extractor. Choose another original format or a supported
                  manual review path.
                </p>
              )}
              {extraction.truncated && (
                <p className="finance-standardization-note">
                  The extraction reached a limit. Content outside the saved
                  inspection has not been confirmed or silently imported.
                </p>
              )}
              <StandardizationFindings
                title="Extraction findings"
                findings={extraction.issues}
              />
            </div>
          )}
          <StandardizationFindings
            title="What needs attention"
            findings={run.blockers}
          />
          {run.proposal && (
            <section className="finance-standardization-proposal">
              <div>
                <h6>Mapping candidate v{run.proposal.mappingVersion}</h6>
                <p>
                  This is the original proposal saved by this analysis. Its open
                  questions remain in the analysis history even after a separate
                  source review.
                </p>
              </div>
              <StandardizationFindings
                title="Questions to resolve in source review"
                findings={run.proposal.unresolvedQuestions}
              />
            </section>
          )}
          {run.reviewedMapping && (
            <div className="finance-standardization-note">
              <strong>
                Reviewed candidate linked · v
                {run.reviewedMapping.mappingVersion}
              </strong>
              <p>
                Current mapping status: {run.reviewedMapping.status}. Open its
                source-derived example and review history to continue. The
                original analysis proposal is retained above.
              </p>
            </div>
          )}
          <div className="finance-standardization-actions">
            {run.allowedActions.includes('open-mapping') &&
              (run.reviewedMapping?.mappingId || run.proposal?.mappingId) && (
                <Button
                  type="button"
                  variant={
                    run.reviewedMapping || !canPrepare ? 'primary' : 'secondary'
                  }
                  disabled={readLocked}
                  onClick={() => void action(() => onOpenMapping(run), false)}
                >
                  Open mapping review
                </Button>
              )}
            {run.allowedActions.includes('review-source') && (
              <Button
                type="button"
                variant={
                  !run.reviewedMapping && canPrepare && run.proposal
                    ? 'primary'
                    : 'secondary'
                }
                disabled={readLocked}
                onClick={() => void action(() => onReviewSource(run), false)}
              >
                {!canPrepare
                  ? 'Download original for review'
                  : run.proposal ||
                      run.format === 'pdf' ||
                      (['png', 'jpeg', 'webp'].includes(run.format) &&
                        run.extraction)
                    ? 'Review original source'
                    : 'Open original for manual review'}
              </Button>
            )}
            {run.allowedActions.includes('retry') && (
              <Button
                type="button"
                variant="secondary"
                disabled={locked}
                onClick={() => reviewAction({ kind: 'retry', run })}
              >
                Review retry
              </Button>
            )}
            {run.allowedActions.includes('cancel') && (
              <Button
                type="button"
                variant="quiet"
                disabled={locked}
                onClick={() => reviewAction({ kind: 'cancel', run })}
              >
                Review cancellation
              </Button>
            )}
          </div>
          <p className="finance-standardization-boundary">
            This analysis has not granted mapping approval or posted financial
            records. A proposal must pass source review and the existing
            approval and import-review steps.
          </p>
          <details className="finance-standardization-provenance">
            <summary>Saved source and analysis provenance</summary>
            <dl>
              <div>
                <dt>Source fingerprint</dt>
                <dd>
                  <code>{run.sourceDigest}</code>
                </dd>
              </div>
              <div>
                <dt>Analysis reference</dt>
                <dd>
                  <code>{run.id}</code>
                </dd>
              </div>
              <div>
                <dt>Saved revision / attempt</dt>
                <dd>
                  {run.revision} / {run.attempt}
                </dd>
              </div>
              <div>
                <dt>Authorized by</dt>
                <dd>
                  <code>{run.authorizedByUserId}</code>
                </dd>
              </div>
              <div>
                <dt>Authorization expiry</dt>
                <dd>{run.authorizationExpiresAt}</dd>
              </div>
              {extraction && (
                <>
                  <div>
                    <dt>Extractor</dt>
                    <dd>
                      {extraction.adapterId} · {extraction.adapterVersion}
                    </dd>
                  </div>
                  <div>
                    <dt>Extraction fingerprint</dt>
                    <dd>
                      <code>{extraction.extractionDigest}</code>
                    </dd>
                  </div>
                </>
              )}
              {run.modelProvenance && (
                <>
                  <div>
                    <dt>Proposal source</dt>
                    <dd>EMDO · {run.modelProvenance.model}</dd>
                  </div>
                  <div>
                    <dt>Proposal completed</dt>
                    <dd>{run.modelProvenance.completedAt}</dd>
                  </div>
                </>
              )}
            </dl>
          </details>
          <FinanceStandardizationReconciliation
            run={run}
            role={role}
            onUpdated={() => refresh(offset)}
          />
        </section>
      )}
      {availability && (
        <details className="finance-standardization-formats">
          <summary>Format availability and limits</summary>
          <ul>
            {availability.registry.adapters.map((adapter) => (
              <li key={adapter.id}>
                <div>
                  <strong>
                    {adapter.formats
                      .map((format) => format.toUpperCase())
                      .join(' / ')}
                  </strong>
                  <span>
                    {adapter.availability === 'unavailable'
                      ? 'Unavailable'
                      : adapter.workflow === 'native-review'
                        ? 'Manual review in Documents'
                        : adapter.workflow === 'dynamic-mapping'
                          ? 'Source inspection and mapping proposal'
                          : 'Unsupported'}
                  </span>
                </div>
                <p>
                  Maximum original: {Math.floor(adapter.maxBytes / 1048576)} MiB
                </p>
                {adapter.limitations.length > 0 && (
                  <ul>
                    {adapter.limitations.map((limitation, index) => (
                      <li key={index}>{limitation}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
const analysisFindingLabels: Record<string, string> = {
  'provider-incomplete-output-max-output-tokens':
    'The analysis reached its response limit before finishing a mapping. No candidate was saved.',
  'provider-incomplete-output-content-filter':
    'The provider did not complete this analysis. No candidate was saved.',
  'provider-incomplete-output':
    'The provider returned an incomplete analysis. No candidate was saved.',
  'provider-structured-validation':
    'The analysis response did not match the required mapping format. No candidate was saved.',
  'provider-canonical-validation':
    'The proposed mapping failed financial validation. No candidate was saved.',
  'provider-canonical-validation-bank-amount-bindings':
    'The analysis could not establish a valid signed amount or debit/credit pair. Review the original statement.',
  'provider-canonical-validation-required-fields-missing':
    'The proposed mapping was missing required financial fields. No candidate was saved.',
  'provider-canonical-validation-duplicate-field':
    'The proposed mapping assigned a financial field more than once. No candidate was saved.',
  'provider-canonical-validation-heading-absent':
    'The proposed mapping referenced a heading absent from its source layout. No candidate was saved.',
  'provider-transport':
    'The analysis request did not return a verified response. Review the saved outcome before retrying.',
  'provider-receipt-missing':
    'The response receipt could not be verified. Review the saved outcome before retrying.',
};
function StandardizationFindings({
  title,
  findings,
}: {
  title: string;
  findings: string[];
}) {
  if (!findings.length) return null;
  return (
    <section className="finance-standardization-findings">
      <h6>{title}</h6>
      <ul>
        {findings.map((finding, index) => (
          <li key={index}>
            <Icon name="info" size={15} />
            <span>
              {analysisFindingLabels[finding] ??
                (/^[a-z][a-z0-9-]+$/u.test(finding)
                  ? finding.replaceAll('-', ' ')
                  : finding)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
