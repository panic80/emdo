import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { UuidSchema } from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import { useAuth } from '../auth/auth-context.js';
import {
  binaryBookOriginal,
  downloadBinaryBookOriginal,
} from './finance-book-evidence-files.js';
import type { AnalyzeBookReport } from './finance-report-mappings.js';
import './finance-pdf-originals.css';

const EvidencePage = z.object({
  documents: z.array(
    z.object({ id: UuidSchema, filename: z.string(), format: z.string() }),
  ),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export function FinancePdfOriginals(props: {
  bookId: string;
  role: string;
  onAnalyze?: AnalyzeBookReport;
}) {
  const auth = useAuth();
  return (
    <PdfOriginalLibrary
      key={`${auth.sessionBinding}:${props.bookId}:${props.role}`}
      {...props}
      {...(auth.csrfToken ? { csrfToken: auth.csrfToken } : {})}
    />
  );
}
function PdfOriginalLibrary({
  bookId,
  role,
  onAnalyze,
  csrfToken,
}: {
  bookId: string;
  role: string;
  onAnalyze?: AnalyzeBookReport;
  csrfToken?: string;
}) {
  const [page, setPage] = useState<z.infer<typeof EvidencePage>>();
  const [offset, setOffset] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const alive = useRef(false),
    working = useRef(false),
    controller = useRef<AbortController | undefined>(undefined);
  const pending = useRef<{ body: string; key: string } | undefined>(undefined);
  const form = useRef<HTMLFormElement>(null);
  const canPrepare = ['administrator', 'preparer', 'approver'].includes(role);
  const base = `/api/v2/finance/books/${bookId}/evidence`;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  async function request(
    suffix: string,
    signal: AbortSignal,
    init: RequestInit = {},
  ) {
    if (!alive.current || signal.aborted)
      throw new Error('The active book changed.');
    const response = await fetch(base + suffix, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      signal,
    });
    if (!response.ok) {
      if (
        [401, 403, 503].includes(response.status) &&
        alive.current &&
        !signal.aborted
      )
        setPage(undefined);
      throw new Error(
        response.status === 403 || response.status === 401
          ? 'Current book access does not permit reading or saving these PDF originals.'
          : response.status === 503
            ? 'PDF original storage is not available yet.'
            : 'Unable to process this PDF original. Check the file and try again.',
      );
    }
    return response.json() as Promise<unknown>;
  }
  async function action(work: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    try {
      await work(next.signal);
    } catch (cause) {
      if (alive.current && !next.signal.aborted)
        setError(
          cause instanceof z.ZodError
            ? 'The PDF original response could not be verified.'
            : cause instanceof Error
              ? cause.message
              : 'Unable to finish this request.',
        );
    } finally {
      working.current = false;
      if (alive.current && !next.signal.aborted) setBusy(false);
    }
  }
  async function load(signal: AbortSignal, nextOffset = offset) {
    setPage(undefined);
    const result = EvidencePage.parse(
      await request(`?offset=${nextOffset}`, signal),
    );
    if (alive.current && !signal.aborted) {
      setPage(result);
      setOffset(nextOffset);
    }
  }
  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get('pdf');
    void action(async (signal) => {
      if (!(file instanceof File))
        throw new Error('Choose a PDF original no larger than 2 MiB.');
      if (!canPrepare || !csrfToken)
        throw new Error(
          'Sign in with preparation access before saving an original.',
        );
      const body = JSON.stringify(await binaryBookOriginal(file, 'pdf'));
      if (!alive.current || signal.aborted) return;
      if (pending.current?.body !== body)
        pending.current = { body, key: crypto.randomUUID() };
      z.object({ id: UuidSchema }).parse(
        await request('', signal, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
            'idempotency-key': pending.current.key,
          },
          body,
        }),
      );
      if (!alive.current || signal.aborted) return;
      pending.current = undefined;
      form.current?.reset();
      await load(signal, 0);
      if (alive.current && !signal.aborted)
        setNotice(
          'PDF original saved securely. Text inspection is available through EMDO. No import rows or financial records were created.',
        );
    });
  }
  const pdfs = page?.documents.filter((document) => document.format === 'pdf');
  return (
    <section className="finance-pdf-originals" aria-label="PDF originals">
      <details
        onToggle={(event) => {
          if (event.currentTarget.open && !page && !busy && !error)
            void action((signal) => load(signal));
        }}
      >
        <summary>
          <span>PDF originals</span>
          <span className="finance-status finance-status--pending">
            Text inspection
          </span>
        </summary>
        <div className="finance-pdf-originals__body">
          <div className="finance-pdf-originals__scope">
            <Icon name="info" size={18} />
            <p>
              EMDO can inspect embedded PDF text and page references. Image-only
              pages need OCR, which is not available yet. To map a text-based
              PDF, review its exact source spans in Report standardization.
            </p>
          </div>
          {canPrepare && (
            <form ref={form} onSubmit={upload}>
              <label>
                PDF original · up to 2 MiB
                <input
                  name="pdf"
                  type="file"
                  accept=".pdf,application/pdf"
                  required
                />
              </label>
              <Button disabled={busy || !csrfToken}>Save PDF original</Button>
            </form>
          )}
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => void action((signal) => load(signal))}
          >
            Refresh PDF originals
          </Button>
          {error && <p role="alert">{error}</p>}
          <p role="status">
            {notice || (busy ? 'Working with this PDF original…' : '')}
          </p>
          {pdfs?.length === 0 && <p>No PDF originals on this page.</p>}
          {pdfs && (
            <ul className="finance-pdf-originals__list">
              {pdfs.map((document) => (
                <li key={document.id}>
                  <div>
                    <span className="finance-pdf-originals__format">PDF</span>
                    <strong>{document.filename}</strong>
                    <p>Saved original · embedded-text inspection available</p>
                  </div>
                  <div className="finance-pdf-originals__actions">
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(async (signal) => {
                          const original = await request(
                            `/${document.id}`,
                            signal,
                          );
                          if (alive.current && !signal.aborted)
                            downloadBinaryBookOriginal(original, 'pdf');
                        })
                      }
                    >
                      Download {document.filename}
                    </Button>
                    {onAnalyze && (
                      <Button
                        variant="quiet"
                        disabled={busy}
                        onClick={() =>
                          void action(async (signal) => {
                            const accepted = await onAnalyze(
                              bookId,
                              document.id,
                              'inspect-pdf',
                            );
                            if (!alive.current || signal.aborted) return;
                            if (!accepted)
                              throw new Error(
                                'EMDO could not start this inspection. The original remains saved.',
                              );
                            setNotice(
                              'PDF inspection sent to EMDO. Open the Finance conversation for extracted text, page references, or extraction limits.',
                            );
                          })
                        }
                      >
                        Ask EMDO to inspect {document.filename}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {page && (
            <div className="finance-pdf-originals__pagination">
              <Button
                variant="quiet"
                disabled={busy || offset === 0}
                onClick={() =>
                  void action((signal) =>
                    load(signal, Math.max(0, offset - 50)),
                  )
                }
              >
                Previous PDF originals page
              </Button>
              <Button
                variant="quiet"
                disabled={busy || page.nextOffset === null}
                onClick={() =>
                  void action((signal) => load(signal, page.nextOffset!))
                }
              >
                Next PDF originals page
              </Button>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
