import { financeAutomationBlockedReason } from './finance-automation-blocked-reason.js';
import { useEffect, useRef, useState } from 'react';
import type {
  FinanceAutomationGrant,
  FinanceAutomationExtractionIntent,
  FinanceAutomationRunRecord,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
import {
  ExtractionAutomationError,
  readExtractionDocuments,
  prepareExtractionIntent,
  enqueueExtractionRun,
  readExtractionRun,
  readExtractionRuns,
  readExtractionResult,
  type ExtractionDocument,
} from './finance-extraction-automation-api.js';
export function FinanceExtractionAutomation(props: {
  bookId: string;
  bookName: string;
  grants: FinanceAutomationGrant[] | undefined;
  csrfToken?: string;
}) {
  const auth = useAuth();
  return (
    <ExtractionPanel
      key={`${auth.sessionBinding}:${auth.state}:${props.bookId}`}
      {...props}
      authenticated={!auth.state || auth.state === 'authenticated'}
    />
  );
}
function ExtractionPanel({
  bookId,
  bookName,
  grants,
  csrfToken,
  authenticated,
}: Parameters<typeof FinanceExtractionAutomation>[0] & {
  authenticated: boolean;
}) {
  const [open, setOpen] = useState(false),
    [documents, setDocuments] = useState<ExtractionDocument[]>([]),
    [nextOffset, setNextOffset] = useState<number | null>(null);
  const [documentId, setDocumentId] = useState(''),
    [grantId, setGrantId] = useState(''),
    [intent, setIntent] = useState<FinanceAutomationExtractionIntent>();
  const [runs, setRuns] = useState<FinanceAutomationRunRecord[]>([]),
    [selectedRun, setSelectedRun] = useState<FinanceAutomationRunRecord>(),
    [result, setResult] =
      useState<Awaited<ReturnType<typeof readExtractionResult>>>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const controller = useRef(new AbortController()),
    working = useRef(false),
    keys = useRef(new Map<string, string>());
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    return () => current.abort();
  }, []);
  const active = (grants ?? []).filter(
    (g) =>
      g.bookId === bookId &&
      g.status === 'active' &&
      g.allowedCapabilities.includes('finance.documents.extract') &&
      Date.parse(g.validFrom) <= Date.now() &&
      Date.parse(g.expiresAt) > Date.now(),
  );
  const grant = active.find((g) => g.id === grantId),
    document = documents.find((d) => d.id === documentId);
  const keyFor = (value: unknown) => {
    const scope = JSON.stringify(value);
    let key = keys.current.get(scope);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(scope, key);
    }
    return key;
  };
  async function action(work: (signal: AbortSignal) => Promise<void>) {
    if (working.current || !authenticated) return;
    working.current = true;
    setBusy(true);
    setError('');
    const signal = controller.current.signal;
    try {
      await work(signal);
    } catch (cause) {
      if (!signal.aborted) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Extraction could not be confirmed.',
        );
        if (
          cause instanceof ExtractionAutomationError &&
          [401, 403].includes(cause.status)
        ) {
          setDocuments([]);
          setIntent(undefined);
          setRuns([]);
          setSelectedRun(undefined);
          setResult(undefined);
          setDocumentId('');
          setGrantId('');
          keys.current.clear();
        }
      }
    } finally {
      working.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  async function load(signal: AbortSignal, offset = 0) {
    const [page, history] = await Promise.all([
      readExtractionDocuments(bookId, offset, signal),
      readExtractionRuns(bookId, signal),
    ]);
    if (signal.aborted) return;
    setDocuments(page.documents);
    setNextOffset(page.nextOffset);
    setRuns(history);
    setDocumentId('');
    setIntent(undefined);
  }
  async function inspect(
    record: FinanceAutomationRunRecord,
    signal: AbortSignal,
  ) {
    const saved = await readExtractionRun(
      bookId,
      record.run.request.operationId,
      signal,
    );
    if (signal.aborted) return;
    if (
      JSON.stringify(saved.run.request.extraction) !==
      JSON.stringify(record.run.request.extraction)
    )
      throw new Error('Saved extraction intent changed unexpectedly.');
    setSelectedRun(saved);
    setResult(undefined);
    if (saved.run.status === 'completed' && saved.run.request.extraction) {
      const outcome = await readExtractionResult(bookId, saved, signal);
      if (!signal.aborted) setResult(outcome);
    }
  }
  if (!authenticated) return null;
  return (
    <section
      className="finance-automations"
      aria-label="Document extraction automation"
    >
      <h3>Extract information from a saved document</h3>
      <p>
        Prepare a fixed extraction request for {bookName}, review its scope,
        then queue it under an active grant. Extracted information still needs
        review.
      </p>
      <Button
        disabled={busy}
        onClick={() => {
          setOpen(true);
          void action((signal) => load(signal));
        }}
      >
        Open document extraction
      </Button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {open && (
        <>
          <label>
            Saved document
            <select
              value={documentId}
              disabled={busy}
              onChange={(e) => {
                setDocumentId(e.target.value);
                setIntent(undefined);
                setNotice('');
              }}
            >
              <option value="">Choose a document</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id} disabled={!d.sourceDigest}>
                  {d.filename} · {d.format.toUpperCase()}
                  {!d.sourceDigest ? ' · source verification unavailable' : ''}
                </option>
              ))}
            </select>
          </label>
          {nextOffset !== null && (
            <Button
              disabled={busy}
              onClick={() => void action((signal) => load(signal, nextOffset))}
            >
              More saved documents
            </Button>
          )}
          <label>
            Extraction grant
            <select
              value={grantId}
              disabled={busy}
              onChange={(e) => {
                setGrantId(e.target.value);
                setIntent(undefined);
                setNotice('');
              }}
            >
              <option value="">Choose an active grant</option>
              {active.map((g, i) => (
                <option value={g.id} key={g.id}>
                  Extraction grant {i + 1} · {g.limits.currency} · expires{' '}
                  {new Date(g.expiresAt).toLocaleDateString()}
                </option>
              ))}
            </select>
          </label>
          {!active.length && (
            <p>
              No active document-extraction grant is available for this book.
            </p>
          )}
          <Button
            disabled={busy || !document?.sourceDigest || !grant || !csrfToken}
            onClick={() =>
              void action(async (signal) => {
                if (!document || !grant || !csrfToken) return;
                const prepared = await prepareExtractionIntent(
                  bookId,
                  document,
                  csrfToken,
                  keyFor(['prepare', document.id, document.sourceDigest]),
                  signal,
                );
                if (!signal.aborted) {
                  setIntent(prepared);
                  setNotice('Scope prepared. No extraction has been queued.');
                }
              })
            }
          >
            Prepare extraction scope
          </Button>
          {intent && document && grant && (
            <section aria-label="Prepared extraction scope">
              <h4>Review extraction scope</h4>
              <p>
                {document.filename} · one original in {bookName}.
              </p>
              <p>
                {intent.expectedExtractionRevision === 0
                  ? 'Create an extraction only if none is already saved.'
                  : `Reuse saved extraction revision ${intent.expectedExtractionRevision}.`}{' '}
                The request pins document analysis revision{' '}
                {intent.expectedRunRevision}.
              </p>
              <p>
                Grant currency: {grant.limits.currency}. Transaction amount: 0.
                This action does not approve a mapping or post accounting
                entries.
              </p>
              <Button
                disabled={busy || !csrfToken}
                onClick={() =>
                  void action(async (signal) => {
                    if (!csrfToken) return;
                    const saved = await enqueueExtractionRun(
                      bookId,
                      grant,
                      intent,
                      csrfToken,
                      keyFor(['enqueue', grant.id, grant.revision, intent]),
                      signal,
                    );
                    if (!signal.aborted) {
                      setSelectedRun(saved);
                      setRuns((old) => [
                        saved,
                        ...old.filter(
                          (r) =>
                            r.run.request.operationId !==
                            saved.run.request.operationId,
                        ),
                      ]);
                      setNotice(
                        'Extraction request saved. Check its status below.',
                      );
                    }
                  })
                }
              >
                Queue reviewed extraction
              </Button>
            </section>
          )}
          <h4>Saved extraction runs</h4>
          {!runs.length && (
            <p>No saved extraction runs in the latest history.</p>
          )}
          <ul>
            {runs.map((r) => (
              <li key={r.run.request.operationId}>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void action((signal) => inspect(r, signal))}
                >
                  {documents.find(
                    (d) => d.id === r.run.request.extraction?.evidenceId,
                  )?.filename ?? 'Saved document'}{' '}
                  · {r.run.status} · {new Date(r.createdAt).toLocaleString()}
                </Button>
              </li>
            ))}
          </ul>
          {selectedRun && (
            <section aria-label="Saved extraction result">
              <p>Status: {selectedRun.run.status}.</p>
              {selectedRun.blockedReason && (
                <p>
                  {financeAutomationBlockedReason(selectedRun.blockedReason)}
                </p>
              )}
              <Button
                disabled={busy}
                onClick={() =>
                  void action((signal) => inspect(selectedRun, signal))
                }
              >
                Refresh extraction result
              </Button>
              {result && (
                <>
                  <p>
                    {documents.find((d) => d.id === result.evidenceId)
                      ?.filename ?? 'Saved document'}
                    : {result.summary.status}. {result.summary.pageCount} pages;{' '}
                    {result.summary.tableCount} detected tables.
                  </p>
                  <p>
                    Review this saved analysis under Reports &amp; tax before
                    using the extracted information.
                  </p>
                  <ul>
                    {result.summary.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
