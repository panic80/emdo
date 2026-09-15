import { useAuth } from '../auth/auth-context.js';
import { useEffect, useMemo, useState } from 'react';
import {
  SaveReviewedFinancePdfOcrMappingSchema,
  type FinanceStandardizationRun,
  type FinancePdfOcrInspection,
} from '@emdo/contracts/browser';
import { FinanceImageReview } from './finance-image-review.js';
import { readFinancePdfOcrInspection } from './finance-pdf-ocr-api.js';
import {
  renderPdfOcrReview,
  loadPdfOcrOriginal,
} from './finance-pdf-ocr-render.js';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';
import type { z } from 'zod';
export function FinancePdfOcrReview(props: {
  run: FinanceStandardizationRun;
  role: string;
  disabled: boolean;
  onSave: (
    payload: z.infer<typeof SaveReviewedFinancePdfOcrMappingSchema>,
  ) => Promise<void>;
  onClose: () => void;
  onAccessUnavailable: (message: string) => void;
}) {
  const { run } = props;
  const auth = useAuth();
  const [inspection, setInspection] = useState<FinancePdfOcrInspection>();
  const [pageNumber, setPageNumber] = useState(
    run.proposal?.definition.pdfOcrSelection?.pageNumber,
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const control = new AbortController();
    setInspection(undefined);
    setAcknowledged(false);
    setError('');
    if (auth.state && auth.state !== 'authenticated')
      return () => control.abort();
    if (run.extraction)
      void readFinancePdfOcrInspection(
        {
          bookId: run.bookId,
          evidenceId: run.evidenceId,
          standardizationRunId: run.id,
          extractionRevision: run.extraction.revision,
          sourceDigest: run.sourceDigest,
          extractionDigest: run.extraction.extractionDigest,
        },
        control.signal,
      )
        .then((value) => {
          if (!control.signal.aborted) {
            setInspection(value);
            setPageNumber(
              run.proposal?.definition.pdfOcrSelection?.pageNumber ??
                value.inventory.pages.find((p) => p.kind === 'ocr')?.pageNumber,
            );
          }
        })
        .catch((cause) => {
          if (!control.signal.aborted)
            setError(
              cause instanceof Error
                ? cause.message
                : 'Saved PDF inspection unavailable.',
            );
        });
    return () => control.abort();
  }, [
    auth.state,
    auth.sessionBinding,
    run.bookId,
    run.evidenceId,
    run.id,
    run.revision,
    run.sourceDigest,
    run.extraction?.revision,
    run.extraction?.extractionDigest,
  ]);
  const page = inspection?.inventory.pages.find(
    (p) => p.pageNumber === pageNumber,
  );
  const adapter = useMemo(
    () =>
      page?.kind === 'ocr'
        ? {
            load: (
              source: Parameters<typeof renderPdfOcrReview>[0],
              signal: AbortSignal,
            ) => renderPdfOcrReview(source, page.result, signal),
            download: async (
              source: Parameters<typeof loadPdfOcrOriginal>[0],
              signal: AbortSignal,
            ) => {
              const original = await loadPdfOcrOriginal(source, signal);
              if (!signal.aborted)
                saveMemoryFile(
                  original.filename,
                  original.bytes,
                  original.mime,
                );
            },
          }
        : undefined,
    [page],
  );
  const previous = run.proposal?.definition.pdfOcrSelection;
  const editorRun = run.proposal
    ? {
        ...run,
        proposal: {
          ...run.proposal,
          definition: {
            ...run.proposal.definition,
            pdfOcrSelection: undefined,
            imageSelection:
              previous && previous.pageNumber === pageNumber
                ? previous.imageSelection
                : undefined,
          },
        },
      }
    : run;
  if (auth.state && auth.state !== 'authenticated')
    return <p role="status">Sign in to review the saved PDF.</p>;
  return (
    <section aria-label="Scanned PDF review">
      <h3>Review scanned PDF pages</h3>
      <p>
        {run.filename}. Review the original PDF page below. Browser rendering is
        for inspection; saving independently regenerates the authoritative page
        on the server.
      </p>
      {error && <p role="alert">{error}</p>}
      {!inspection && !error && (
        <p role="status">Loading saved PDF page inventory…</p>
      )}
      {inspection && (
        <>
          <label>
            Original PDF page
            <select
              value={pageNumber ?? ''}
              onChange={(event) => {
                setPageNumber(Number(event.target.value));
                setAcknowledged(false);
              }}
            >
              <option value="" disabled>
                Select a page
              </option>
              {inspection.inventory.pages.map((p) => (
                <option
                  key={p.pageNumber}
                  value={p.pageNumber}
                  disabled={p.kind !== 'ocr'}
                >
                  Page {p.pageNumber}:{' '}
                  {p.kind === 'unresolved' ? p.reason : p.kind}
                </option>
              ))}
            </select>
          </label>
          <ul>
            {inspection.inventory.pages
              .filter((p) => p.pageNumber !== pageNumber)
              .map((p) => (
                <li key={p.pageNumber}>
                  Page {p.pageNumber} omitted from this candidate:{' '}
                  {p.kind === 'unresolved' ? p.reason : p.kind}.
                </li>
              ))}
          </ul>
          <label>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I acknowledge that this candidate covers only the selected page
            regions; all other pages remain outside it.
          </label>
          {page?.kind === 'ocr' && adapter && (
            <FinanceImageReview
              key={`${run.id}:${run.revision}:${pageNumber}`}
              {...props}
              run={editorRun}
              sourceAdapter={adapter}
              disabled={props.disabled || !acknowledged}
              onSave={async (payload) => {
                if (!acknowledged || !run.extraction)
                  throw new Error(
                    'Acknowledge omitted PDF pages before saving.',
                  );
                const { imageSelection, ...definition } =
                  payload.proposal.definition;
                await props.onSave(
                  SaveReviewedFinancePdfOcrMappingSchema.parse({
                    evidenceId: run.evidenceId,
                    proposal: {
                      ...payload.proposal,
                      definition: {
                        ...definition,
                        pdfOcrSelection: {
                          expectedSourceDigest: run.sourceDigest,
                          standardizationRunId: run.id,
                          extractionRevision: run.extraction.revision,
                          expectedExtractionDigest:
                            run.extraction.extractionDigest,
                          pageNumber,
                          acknowledgeOtherPages: true,
                          imageSelection,
                        },
                      },
                    },
                  }),
                );
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
