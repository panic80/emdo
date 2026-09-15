import { FinanceManualMappingSetup } from './finance-manual-mapping-setup.js';
import { FinancePdfOcrReview } from './finance-pdf-ocr-review.js';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  UuidSchema,
  FinanceReportMappingDefinitionSchema,
  LinkFinanceStandardizationMappingSchema,
  type FinanceStandardizationRun,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
import { FinanceXlsxReview } from './finance-xlsx-review.js';
import { FinancePdfReview } from './finance-pdf-review.js';
import { FinanceStandardization } from './finance-standardization.js';
import { FinanceCsvReview } from './finance-csv-review.js';
import { FinanceImageReview } from './finance-image-review.js';
import { isFinanceImage } from './finance-image-review-api.js';
import {
  downloadStandardizationOriginal,
  readStandardizationRun,
  verifyStandardizationRun,
} from './finance-standardization-api.js';
import { downloadBinaryBookOriginal } from './finance-book-evidence-files.js';
import './finance-pdf-originals.css';
const Evidence = z.object({
  id: UuidSchema,
  filename: z.string(),
  format: z.string(),
  sourceDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
const Account = z.object({
  kind: z.string().optional(),
  id: UuidSchema,
  name: z.string(),
  currency: z.string(),
});
const Mapping = z.object({
  id: UuidSchema,
  providerKey: z.string(),
  reportName: z.string(),
  version: z.number().int(),
  revision: z.number().int(),
  status: z.enum(['candidate', 'approved', 'retired']),
  validationStatus: z.string(),
});
const Detail = z.object({
  mapping: z.object({
    id: UuidSchema,
    evidence_id: UuidSchema,
    evidence_format: z.string().optional(),
    evidence_filename: z.string().optional(),
    version: z.number().int(),
    revision: z.number().int(),
    status: z.enum(['candidate', 'approved', 'retired']),
    definition: FinanceReportMappingDefinitionSchema,
    rationale: z.string(),
    proposed_by_model: z.string().nullable(),
    unresolved_questions: z.array(z.string()),
    example: z.object({
      sheet: z.string().nullable().optional(),
      headers: z.array(z.string()),
      rows: z.array(
        z.object({ sourceRow: z.number(), cells: z.array(z.string()) }),
      ),
    }),
    validation: z.object({
      status: z.string(),
      issues: z.array(z.string()),
      rows: z.array(
        z.object({
          sourceRow: z.number(),
          fields: z.record(z.string(), z.string().nullable()),
          provenance: z.record(z.string(), z.unknown()).optional(),
          unmapped: z.array(z.unknown()).optional(),
          issues: z.array(z.string()),
        }),
      ),
    }),
  }),
  reviews: z.array(
    z.object({
      revision: z.number(),
      decision: z.string(),
      reason: z.string(),
    }),
  ),
});
export type AnalyzeBookReport = (
  bookId: string,
  evidenceId: string,
  intent?: 'inspect-pdf' | 'propose-pdf-mapping',
) => Promise<boolean>;
export function FinanceReportMappings({
  bookId,
  role,
  onAnalyze,
}: {
  bookId: string;
  role: string;
  onAnalyze?: AnalyzeBookReport;
}) {
  const auth = useAuth();
  return (
    <ReportMappingsWorkspace
      key={`${auth.sessionBinding}:${bookId}:${role}`}
      bookId={bookId}
      role={role}
      {...(onAnalyze ? { onAnalyze } : {})}
    />
  );
}
function ReportMappingsWorkspace({
  bookId,
  role,
  onAnalyze,
}: {
  bookId: string;
  role: string;
  onAnalyze?: AnalyzeBookReport;
}) {
  const auth = useAuth(),
    alive = useRef(true),
    working = useRef(false),
    controller = useRef<AbortController | undefined>(undefined),
    pending = useRef<{ path: string; body: string; key: string } | undefined>(
      undefined,
    );
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [documents, setDocuments] = useState<z.infer<typeof Evidence>[]>([]),
    [mappings, setMappings] = useState<z.infer<typeof Mapping>[]>([]),
    [detail, setDetail] = useState<z.infer<typeof Detail>>();
  const [evidenceOffset, setEvidenceOffset] = useState(0),
    [mappingOffset, setMappingOffset] = useState(0),
    [nextEvidence, setNextEvidence] = useState<number | null>(null),
    [nextMapping, setNextMapping] = useState<number | null>(null),
    [showRows, setShowRows] = useState(10);
  const [reuseAccounts, setReuseAccounts] = useState<
    z.infer<typeof Account>[] | undefined
  >();
  const [pdfReview, setPdfReview] = useState<{
    evidenceId: string;
    filename: string;
    definition?: z.infer<typeof FinanceReportMappingDefinitionSchema>;
    questions?: string[];
    key: string;
    run?: FinanceStandardizationRun;
  }>();
  const [createdImport, setCreatedImport] = useState<string>();
  const [xlsxReview, setXlsxReview] = useState<{
    evidenceId: string;
    definition?: z.infer<typeof FinanceReportMappingDefinitionSchema>;
    questions: string[];
    key: string;
    run?: FinanceStandardizationRun;
  }>();
  const [csvReview, setCsvReview] = useState<{
    evidenceId: string;
    filename: string;
    sourceDigest: string;
    definition?: z.infer<typeof FinanceReportMappingDefinitionSchema>;
    questions: string[];
    key: string;
    run?: FinanceStandardizationRun;
  }>();
  const [analysisRefresh, setAnalysisRefresh] = useState(0);
  const [imageReview, setImageReview] = useState<FinanceStandardizationRun>();
  const RegionReview =
    imageReview?.format === 'pdf' ? FinancePdfOcrReview : FinanceImageReview;
  const [pendingLink, setPendingLink] = useState<{
    run: FinanceStandardizationRun;
    mappingId: string;
  }>();
  const reviewPanel = useRef<HTMLElement | null>(null);
  const canPrepare = ['administrator', 'preparer', 'approver'].includes(role),
    canApprove = ['administrator', 'approver'].includes(role),
    base = `/api/v2/finance/books/${bookId}`;
  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    const panel = reviewPanel.current;
    if (!panel) return;
    panel.focus({ preventScroll: true });
    panel.scrollIntoView?.({
      block: 'start',
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }, [
    pdfReview?.key,
    xlsxReview?.key,
    csvReview?.key,
    imageReview?.id,
    imageReview?.revision,
    detail?.mapping.id,
    detail?.mapping.version,
  ]);
  async function request(path: string, init: RequestInit = {}) {
    if (!alive.current) throw new Error('The active book changed.');
    const signal = init.signal ?? controller.current?.signal;
    if (signal?.aborted) throw new Error('The active book changed.');
    const response = await fetch(base + path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (alive.current && [401, 403, 503].includes(response.status)) {
        setDocuments([]);
        setMappings([]);
        setDetail(undefined);
        setPdfReview(undefined);
        setXlsxReview(undefined);
        setCsvReview(undefined);
        setImageReview(undefined);
        setPendingLink(undefined);
        setOpen(false);
      }
      throw new Error(
        response.status === 403
          ? 'Current book access does not permit this action.'
          : response.status === 409
            ? 'Refresh this mapping. Its revision or validation does not permit that decision.'
            : response.status === 503
              ? 'Report standardization is not ready in this environment.'
              : 'Unable to load or save the report.',
      );
    }
    const result: unknown = await response.json();
    if (!alive.current || signal?.aborted)
      throw new Error('The active book changed.');
    return result;
  }
  async function load(eOffset = evidenceOffset, mOffset = mappingOffset) {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    const [e, m] = await Promise.all([
      request(`/evidence?offset=${eOffset}`, { signal: next.signal }),
      request(`/report-mappings?offset=${mOffset}`, { signal: next.signal }),
    ]);
    if (!alive.current || next.signal.aborted) return;
    const evidence = z
        .object({
          documents: z.array(Evidence),
          nextOffset: z.number().nullable(),
        })
        .parse(e),
      maps = z
        .object({
          mappings: z.array(Mapping),
          nextOffset: z.number().nullable(),
        })
        .parse(m);
    setDocuments(evidence.documents);
    setNextEvidence(evidence.nextOffset);
    setEvidenceOffset(eOffset);
    setMappings(maps.mappings);
    setNextMapping(maps.nextOffset);
    setMappingOffset(mOffset);
  }
  async function action(work: () => Promise<void>, rethrow = false) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Unable to finish.');
      if (rethrow) throw e;
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function post(path: string, payload: unknown) {
    if (!auth.csrfToken) throw new Error('Sign in again before saving.');
    const body = JSON.stringify(payload);
    if (pending.current?.path !== path || pending.current.body !== body)
      pending.current = { path, body, key: crypto.randomUUID() };
    const result = await request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': auth.csrfToken,
        'idempotency-key': pending.current.key,
      },
      body,
    });
    pending.current = undefined;
    return result;
  }
  async function select(
    id: string,
    expected?: { evidenceId: string; version: number },
  ) {
    const result = Detail.parse(await request(`/report-mappings/${id}`));
    if (
      result.mapping.id !== id ||
      (expected &&
        (result.mapping.evidence_id !== expected.evidenceId ||
          result.mapping.version !== expected.version))
    )
      throw new Error(
        'The mapping does not match the saved analysis source and version. Refresh before reviewing it.',
      );
    if (alive.current) {
      setDetail(result);
      setPdfReview(undefined);
      setXlsxReview(undefined);
      setCsvReview(undefined);
      setImageReview(undefined);
      setReuseAccounts(undefined);
      setCreatedImport(undefined);
      setShowRows(10);
    }
  }
  function openPdfReview(evidenceId: string, filename: string) {
    setPdfReview({ evidenceId, filename, key: evidenceId });
    setXlsxReview(undefined);
    setCsvReview(undefined);
    setImageReview(undefined);
    setDetail(undefined);
    setReuseAccounts(undefined);
    setCreatedImport(undefined);
  }
  async function downloadPdf(evidenceId: string) {
    const original = await request(`/evidence/${evidenceId}`);
    if (alive.current) downloadBinaryBookOriginal(original, 'pdf');
  }
  function reuse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget),
      selected = detail!.mapping;
    void action(async () => {
      const result = z
        .object({ id: UuidSchema, status: z.enum(['review', 'observed']) })
        .parse(
          await post(`/report-mappings/${selected.id}/import`, {
            evidenceId: String(values.get('evidenceId')),
            financialAccountId: String(values.get('financialAccountId')),
            expectedMappingVersion: selected.version,
            providerKey: String(values.get('providerKey')),
          }),
        );
      if (alive.current) {
        setCreatedImport(result.id);
        setNotice(
          result.status === 'observed'
            ? 'Statement observations saved. Refresh valuation sources in Investments to select them for comparison. No opening balances or transactions were created.'
            : 'Saved for review. Open Documents below and refresh its list to review this report.',
        );
      }
    });
  }
  async function reviewAnalysisSource(run: FinanceStandardizationRun) {
    if (!canPrepare && controller.current) {
      await downloadStandardizationOriginal(run, controller.current.signal);
      return;
    }
    setDetail(undefined);
    setReuseAccounts(undefined);
    setCreatedImport(undefined);
    setCsvReview(undefined);
    setImageReview(undefined);
    if (
      (isFinanceImage(run.format) ||
        (run.format === 'pdf' &&
          run.extraction?.adapterId === 'finance.pdf-ocr')) &&
      run.extraction
    ) {
      setPdfReview(undefined);
      setXlsxReview(undefined);
      setImageReview(run);
    } else if (run.format === 'pdf') {
      setXlsxReview(undefined);
      setPdfReview({
        evidenceId: run.evidenceId,
        filename: run.filename,
        ...(run.proposal
          ? {
              definition: run.proposal.definition,
              questions: run.proposal.unresolvedQuestions,
            }
          : {}),
        key: `${run.id}:${run.revision}`,
        run,
      });
    } else if (run.format === 'xlsx') {
      setPdfReview(undefined);
      setXlsxReview({
        evidenceId: run.evidenceId,
        definition: run.proposal?.definition,
        questions: run.proposal?.unresolvedQuestions ?? [],
        key: `${run.id}:${run.revision}`,
        run,
      });
    } else if (run.format === 'csv') {
      setPdfReview(undefined);
      setXlsxReview(undefined);
      setCsvReview({
        evidenceId: run.evidenceId,
        filename: run.filename,
        sourceDigest: run.sourceDigest,
        definition: run.proposal?.definition,
        questions: run.proposal?.unresolvedQuestions ?? [],
        key: `${run.id}:${run.revision}`,
        run,
      });
    } else if (run.proposal?.mappingId) {
      await select(run.proposal.mappingId, {
        evidenceId: run.evidenceId,
        version: run.proposal.mappingVersion,
      });
    } else if (controller.current) {
      await downloadStandardizationOriginal(run, controller.current.signal);
    }
  }
  async function linkReviewedCandidate(
    run: FinanceStandardizationRun,
    mappingId: string,
  ) {
    if (!controller.current)
      throw new Error(
        'Refresh this book before linking the reviewed candidate.',
      );
    const current = await readStandardizationRun(
      bookId,
      run.id,
      controller.current.signal,
    );
    if (
      current.evidenceId !== run.evidenceId ||
      current.sourceDigest !== run.sourceDigest
    )
      throw new Error(
        'The saved analysis source changed. Review it again before linking a candidate.',
      );
    if (current.reviewedMapping?.mappingId === mappingId) return;
    if (current.revision !== run.revision)
      throw new Error(
        'The saved analysis changed. Reopen it and review the current candidate before linking this version.',
      );
    const result = verifyStandardizationRun(
      await post(
        `/standardizations/${run.id}/reviewed-mapping`,
        LinkFinanceStandardizationMappingSchema.parse({
          expectedRevision: run.revision,
          mappingId,
        }),
      ),
      bookId,
      {
        id: run.id,
        evidenceId: run.evidenceId,
        sourceDigest: run.sourceDigest,
      },
    );
    if (result.reviewedMapping?.mappingId !== mappingId)
      throw new Error(
        'The candidate link could not be verified. Refresh the saved analysis before trying again.',
      );
  }
  async function saveSourceCandidate(
    payload: unknown,
    format: 'csv' | 'xlsx' | 'pdf' | 'image',
    run?: FinanceStandardizationRun,
  ) {
    const saved = z
      .object({ id: UuidSchema })
      .parse(
        await post(
          format === 'csv'
            ? '/report-mappings/from-source'
            : '/report-mappings',
          payload,
        ),
      );
    await select(saved.id);
    await load(evidenceOffset, 0);
    if (!alive.current) return;
    if (run) {
      setPendingLink({ run, mappingId: saved.id });
      try {
        await linkReviewedCandidate(run, saved.id);
        if (!alive.current) return;
        setPendingLink(undefined);
        setAnalysisRefresh((revision) => revision + 1);
      } catch (cause) {
        if (alive.current)
          setError(
            `The reviewed candidate is saved. Its link to the analysis needs checking. ${cause instanceof Error ? cause.message : ''}`,
          );
      }
    }
    if (alive.current)
      setNotice(
        `Reviewed ${format.toUpperCase()} candidate saved. Check the source-derived example and validation before a separate mapping decision.`,
      );
  }
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      selected = detail!.mapping;
    void action(async () => {
      await post(`/report-mappings/${selected.id}/review`, {
        expectedRevision: selected.revision,
        decision: String(form.get('decision')),
        reason: String(form.get('reason')),
      });
      await select(selected.id);
      await load();
      if (alive.current)
        setNotice('Mapping decision saved. No financial records were posted.');
    });
  }
  return (
    <section
      aria-label="Dynamic report standardization"
      className="finance-report-mappings"
    >
      <h3>Report standardization</h3>
      <p>
        Review unfamiliar CSV, XLSX, PDF and image reports. Ask EMDO to analyze
        their meaning, then verify source examples before approving a mapping.
        PDF tables require explicit review of whole text spans. PNG, JPEG and
        WebP originals use saved OCR with visual source review when available.
        Scanned PDF pages use the saved OCR page review when available.
      </p>
      <Button
        variant="quiet"
        disabled={busy}
        onClick={() => {
          setOpen(true);
          void action(() => load());
        }}
      >
        {open ? 'Refresh report mappings' : 'Open report standardization'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pendingLink && canPrepare && (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await linkReviewedCandidate(
                pendingLink.run,
                pendingLink.mappingId,
              );
              if (alive.current) {
                setPendingLink(undefined);
                setAnalysisRefresh((revision) => revision + 1);
                setNotice(
                  'Reviewed candidate linked to the saved analysis. No approval or import was performed.',
                );
              }
            })
          }
        >
          Check saved candidate link
        </Button>
      )}
      {open && (
        <>
          <FinanceStandardization
            bookId={bookId}
            role={role}
            sources={documents}
            refreshToken={analysisRefresh}
            onOriginalSaved={async () => {
              setDetail(undefined);
              setPdfReview(undefined);
              setXlsxReview(undefined);
              setCsvReview(undefined);
              setImageReview(undefined);
              await load(0, mappingOffset);
            }}
            onOpenMapping={async (run) => {
              const linked = run.reviewedMapping ?? run.proposal;
              if (!linked?.mappingId)
                throw new Error(
                  'This proposal needs source review before a mapping candidate can be saved.',
                );
              await select(linked.mappingId, {
                evidenceId: run.evidenceId,
                version: linked.mappingVersion,
              });
            }}
            onReviewSource={reviewAnalysisSource}
            onAccessUnavailable={(message) => {
              controller.current?.abort();
              setDocuments([]);
              setMappings([]);
              setDetail(undefined);
              setPdfReview(undefined);
              setXlsxReview(undefined);
              setCsvReview(undefined);
              setImageReview(undefined);
              setPendingLink(undefined);
              setOpen(false);
              setError(message);
            }}
          />
          <h4>Saved originals</h4>
          {!documents.length && <p>No originals on this page.</p>}
          <ul>
            {documents.map((document) => (
              <li key={document.id}>
                {document.filename}
                {document.format === 'pdf' && (
                  <div className="finance-report-pdf-note">
                    <p>
                      Inspect embedded text or select exact source spans for a
                      reviewed mapping. Scanned pages need saved OCR before they
                      can be reviewed. Mapping approval and import review are
                      separate actions.
                    </p>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          controller.current?.abort();
                          const next = new AbortController();
                          controller.current = next;
                          const original = await request(
                            `/evidence/${document.id}`,
                            { signal: next.signal },
                          );
                          if (alive.current && !next.signal.aborted)
                            downloadBinaryBookOriginal(original, 'pdf');
                        })
                      }
                    >
                      Download {document.filename}
                    </Button>
                    {canPrepare && (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          openPdfReview(document.id, document.filename)
                        }
                      >
                        Review PDF source: {document.filename}
                      </Button>
                    )}
                    {canPrepare && onAnalyze && (
                      <Button
                        variant="quiet"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            const accepted = await onAnalyze(
                              bookId,
                              document.id,
                              'propose-pdf-mapping',
                            );
                            if (!accepted)
                              throw new Error(
                                'EMDO could not start this proposal. The original remains saved.',
                              );
                            if (alive.current)
                              setNotice(
                                'PDF proposal requested. Review the Finance conversation, refresh mappings, then verify the exact source selection. Human review and mapping approval remain separate.',
                              );
                          })
                        }
                      >
                        Ask EMDO to propose PDF mapping for {document.filename}
                      </Button>
                    )}
                  </div>
                )}
                {(canPrepare || document.format === 'pdf') &&
                  ['csv', 'xlsx', 'pdf'].includes(document.format) &&
                  onAnalyze && (
                    <Button
                      variant="quiet"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const accepted =
                            document.format === 'pdf'
                              ? await onAnalyze(
                                  bookId,
                                  document.id,
                                  'inspect-pdf',
                                )
                              : await onAnalyze(bookId, document.id);
                          if (!accepted)
                            throw new Error(
                              'EMDO could not start this analysis. The original remains saved.',
                            );
                          await load();
                          if (alive.current)
                            setNotice(
                              document.format === 'pdf'
                                ? 'PDF inspection sent to EMDO. Check the Finance conversation for text, page references, or extraction limits. No mapping or import was requested.'
                                : 'Analysis sent to EMDO. Check the Finance conversation for questions or results, then refresh mappings.',
                            );
                        })
                      }
                    >
                      Ask EMDO to{' '}
                      {document.format === 'pdf' ? 'inspect' : 'analyze'}{' '}
                      {document.filename}
                    </Button>
                  )}
              </li>
            ))}
          </ul>
          <Button
            variant="quiet"
            disabled={busy || evidenceOffset === 0}
            onClick={() =>
              void action(() =>
                load(Math.max(0, evidenceOffset - 50), mappingOffset),
              )
            }
          >
            Previous originals
          </Button>
          <Button
            variant="quiet"
            disabled={busy || nextEvidence === null}
            onClick={() =>
              void action(() => load(nextEvidence!, mappingOffset))
            }
          >
            Next originals
          </Button>
          <h4>Mapping versions</h4>
          {!mappings.length && <p>No mapping versions on this page.</p>}
          <ul>
            {mappings.map((mapping) => (
              <li key={mapping.id}>
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() => void action(() => select(mapping.id))}
                >
                  {mapping.providerKey} · {mapping.reportName} · v
                  {mapping.version} · {mapping.status}
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="quiet"
            disabled={busy || mappingOffset === 0}
            onClick={() =>
              void action(() =>
                load(evidenceOffset, Math.max(0, mappingOffset - 50)),
              )
            }
          >
            Previous mappings
          </Button>
          <Button
            variant="quiet"
            disabled={busy || nextMapping === null}
            onClick={() =>
              void action(() => load(evidenceOffset, nextMapping!))
            }
          >
            Next mappings
          </Button>
          {pdfReview && canPrepare && (
            <section
              ref={reviewPanel}
              data-report-review
              tabIndex={-1}
              aria-label="Selected PDF review"
            >
              <FinancePdfReview
                key={pdfReview.key}
                bookId={bookId}
                evidenceId={pdfReview.evidenceId}
                filename={pdfReview.filename}
                role={role}
                disabled={busy}
                {...(pdfReview.definition
                  ? { definition: pdfReview.definition }
                  : {})}
                {...(pdfReview.questions
                  ? { questions: pdfReview.questions }
                  : {})}
                onClose={() => setPdfReview(undefined)}
                onDownload={() =>
                  void action(() => downloadPdf(pdfReview.evidenceId))
                }
                onSave={(payload) =>
                  action(
                    () => saveSourceCandidate(payload, 'pdf', pdfReview.run),
                    true,
                  )
                }
              />
            </section>
          )}
          {xlsxReview && canPrepare && (
            <section
              ref={reviewPanel}
              data-report-review
              tabIndex={-1}
              aria-label="Selected XLSX source review"
            >
              <h4>Review the original XLSX source</h4>
              <p>
                The source range and field meanings remain unreviewed until you
                check the original and save a source-derived candidate.
              </p>
              {!xlsxReview.definition ? (
                <FinanceManualMappingSetup
                  key={xlsxReview.key}
                  format="xlsx"
                  disabled={busy}
                  onDownload={() =>
                    void action(async () => {
                      if (xlsxReview.run && controller.current)
                        await downloadStandardizationOriginal(
                          xlsxReview.run,
                          controller.current.signal,
                        );
                    })
                  }
                  onContinue={(definition) =>
                    setXlsxReview({ ...xlsxReview, definition })
                  }
                />
              ) : (
                <FinanceXlsxReview
                  key={xlsxReview.key}
                  evidenceId={xlsxReview.evidenceId}
                  definition={xlsxReview.definition}
                  questions={xlsxReview.questions}
                  sheet={xlsxReview.definition.xlsxSelection?.sheet}
                  disabled={busy}
                  onDownload={() =>
                    void action(async () => {
                      const original = await request(
                        `/evidence/${xlsxReview.evidenceId}`,
                      );
                      if (alive.current)
                        downloadBinaryBookOriginal(original, 'xlsx');
                    })
                  }
                  onSave={(payload) =>
                    action(
                      () =>
                        saveSourceCandidate(payload, 'xlsx', xlsxReview.run),
                      true,
                    )
                  }
                />
              )}
            </section>
          )}
          {csvReview && canPrepare && (
            <section
              ref={reviewPanel}
              data-report-review
              tabIndex={-1}
              aria-label="Selected CSV source review"
            >
              {!csvReview.definition ? (
                <FinanceManualMappingSetup
                  key={csvReview.key}
                  format="csv"
                  csvSource={{
                    bookId,
                    evidenceId: csvReview.evidenceId,
                    sourceDigest: csvReview.sourceDigest,
                  }}
                  onAccessUnavailable={(message) => {
                    controller.current?.abort();
                    setDocuments([]);
                    setMappings([]);
                    setCsvReview(undefined);
                    setOpen(false);
                    setError(message);
                  }}
                  disabled={busy}
                  onDownload={() =>
                    void action(async () => {
                      if (csvReview.run && controller.current)
                        await downloadStandardizationOriginal(
                          csvReview.run,
                          controller.current.signal,
                        );
                    })
                  }
                  onContinue={(definition) =>
                    setCsvReview({ ...csvReview, definition })
                  }
                />
              ) : (
                <FinanceCsvReview
                  key={csvReview.key}
                  bookId={bookId}
                  evidenceId={csvReview.evidenceId}
                  filename={csvReview.filename}
                  sourceDigest={csvReview.sourceDigest}
                  definition={csvReview.definition}
                  questions={csvReview.questions}
                  disabled={busy}
                  onClose={() => setCsvReview(undefined)}
                  onSave={(payload) =>
                    action(
                      () => saveSourceCandidate(payload, 'csv', csvReview.run),
                      true,
                    )
                  }
                  onAccessUnavailable={(message) => {
                    controller.current?.abort();
                    setDocuments([]);
                    setMappings([]);
                    setDetail(undefined);
                    setCsvReview(undefined);
                    setImageReview(undefined);
                    setOpen(false);
                    setError(message);
                  }}
                />
              )}
            </section>
          )}
          {imageReview && canPrepare && (
            <section
              ref={reviewPanel}
              data-report-review
              tabIndex={-1}
              aria-label="Selected image source review"
            >
              <RegionReview
                run={imageReview}
                role={role}
                disabled={busy}
                onClose={() => setImageReview(undefined)}
                onSave={(payload) =>
                  action(
                    () =>
                      saveSourceCandidate(
                        payload,
                        imageReview.format === 'pdf' ? 'pdf' : 'image',
                        imageReview,
                      ),
                    true,
                  )
                }
                onAccessUnavailable={(message) => {
                  controller.current?.abort();
                  setDocuments([]);
                  setMappings([]);
                  setDetail(undefined);
                  setImageReview(undefined);
                  setPendingLink(undefined);
                  setOpen(false);
                  setError(message);
                }}
              />
            </section>
          )}
          {detail && (
            <section
              ref={reviewPanel}
              data-report-review
              tabIndex={-1}
              aria-label="Selected mapping review"
            >
              <h4>
                Mapping v{detail.mapping.version} · {detail.mapping.status}
              </h4>
              <p>
                Proposed by{' '}
                {detail.mapping.proposed_by_model ?? 'a workspace member'}.{' '}
                {detail.mapping.rationale}
              </p>
              <p>
                Validation: {detail.mapping.validation.status}. Approval permits
                reuse of this mapping; posting still requires its own authorized
                review.
              </p>
              <p>
                Date format: {detail.mapping.definition.dateFormat}. Decimal
                separator: {detail.mapping.definition.decimalSeparator}.
                Grouping separator:{' '}
                {JSON.stringify(detail.mapping.definition.groupingSeparator)}.
              </p>
              {detail.mapping.definition.quantityUnit && (
                <p>
                  Quantity unit: {detail.mapping.definition.quantityUnit}. Quote
                  multiplier:{' '}
                  {detail.mapping.definition.valuationMultiplier ??
                    'Not mapped'}
                  .
                </p>
              )}
              <ul>
                {detail.mapping.unresolved_questions.map((question, i) => (
                  <li key={i}>{question}</li>
                ))}
              </ul>
              {(detail.mapping.definition.imageSelection ||
                detail.mapping.definition.pdfOcrSelection) && (
                <p className="finance-report-pdf-note">
                  This candidate covers only its reviewed source regions. Visual
                  corrections and original OCR word locations are retained in
                  the normalized source provenance. Reuse is restricted to this
                  exact reviewed original.
                </p>
              )}
              {canPrepare &&
                (detail.mapping.definition.imageSelection ||
                  detail.mapping.definition.pdfOcrSelection) && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const mapping = detail.mapping,
                          selection = (mapping.definition.pdfOcrSelection ??
                            mapping.definition.imageSelection)!;
                        if (!controller.current)
                          throw new Error(
                            'Refresh this book before reopening its image review.',
                          );
                        const run = await readStandardizationRun(
                          bookId,
                          selection.standardizationRunId,
                          controller.current.signal,
                        );
                        if (
                          run.evidenceId !== mapping.evidence_id ||
                          run.sourceDigest !== selection.expectedSourceDigest ||
                          run.extraction?.revision !==
                            selection.extractionRevision ||
                          run.extraction.extractionDigest !==
                            selection.expectedExtractionDigest
                        )
                          throw new Error(
                            'The current analysis uses a different extraction. Open its saved source review before creating a new candidate.',
                          );
                        setImageReview({
                          ...run,
                          proposal: {
                            mappingId: mapping.id,
                            mappingVersion: mapping.version,
                            definition: mapping.definition,
                            rationale: mapping.rationale,
                            status: 'candidate',
                            unresolvedQuestions: mapping.unresolved_questions,
                          },
                        });
                        setDetail(undefined);
                        setPdfReview(undefined);
                        setXlsxReview(undefined);
                        setCsvReview(undefined);
                      })
                    }
                  >
                    {detail.mapping.definition.pdfOcrSelection
                      ? 'Review PDF page regions and create a revised candidate'
                      : 'Review image regions and create a revised candidate'}
                  </Button>
                )}
              {canPrepare &&
                (detail.mapping.definition.pdfSelection ||
                  (detail.mapping.evidence_format === 'pdf' &&
                    !detail.mapping.definition.pdfOcrSelection)) && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      setPdfReview({
                        evidenceId: detail.mapping.evidence_id,
                        filename:
                          detail.mapping.evidence_filename ??
                          'Reviewed PDF original',
                        definition: detail.mapping.definition,
                        questions: detail.mapping.unresolved_questions,
                        key: `${detail.mapping.id}:${detail.mapping.revision}`,
                      })
                    }
                  >
                    Review PDF selection and create a revised candidate
                  </Button>
                )}
              {canPrepare &&
                (detail.mapping.definition.xlsxSelection ||
                  detail.mapping.evidence_format === 'xlsx' ||
                  documents.some(
                    (item) =>
                      item.id === detail.mapping.evidence_id &&
                      item.format === 'xlsx',
                  )) && (
                  <FinanceXlsxReview
                    key={detail.mapping.id}
                    evidenceId={detail.mapping.evidence_id}
                    definition={detail.mapping.definition}
                    questions={detail.mapping.unresolved_questions}
                    sheet={detail.mapping.example.sheet}
                    disabled={busy}
                    onDownload={() =>
                      void action(async () => {
                        const original = z
                          .object({
                            format: z.literal('xlsx'),
                            filename: z.string(),
                            sourceBase64: z.string(),
                          })
                          .parse(
                            await request(
                              `/evidence/${detail.mapping.evidence_id}`,
                            ),
                          );
                        const binary = atob(original.sourceBase64),
                          bytes = Uint8Array.from(binary, (character) =>
                            character.charCodeAt(0),
                          );
                        if (alive.current)
                          saveMemoryFile(
                            original.filename,
                            bytes,
                            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                          );
                      })
                    }
                    onSave={(payload) =>
                      action(async () => {
                        const saved = z
                          .object({ id: UuidSchema })
                          .parse(await post('/report-mappings', payload));
                        await select(saved.id);
                        await load(evidenceOffset, 0);
                        if (alive.current)
                          setNotice(
                            'Revised XLSX candidate saved. Review the source-derived example and validation before approval.',
                          );
                      })
                    }
                  />
                )}
              <table>
                <caption>Proposed field meanings</caption>
                <thead>
                  <tr>
                    <th>Canonical field</th>
                    <th>Source column or context</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.mapping.definition.bindings.map((binding) => (
                    <tr key={binding.field}>
                      <td>{binding.field}</td>
                      <td>
                        {binding.column ?? `Report context: ${binding.context}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table>
                <caption>Original example rows</caption>
                <thead>
                  <tr>
                    <th>Source row</th>
                    {detail.mapping.example.headers.map((header) => (
                      <th key={header}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.mapping.example.rows.slice(0, showRows).map((row) => (
                    <tr key={row.sourceRow}>
                      <td>{row.sourceRow}</td>
                      {row.cells.map((cell, i) => (
                        <td key={i}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <details>
                <summary>Normalized values and validation issues</summary>
                <pre className="finance-provenance">
                  {JSON.stringify(
                    {
                      issues: detail.mapping.validation.issues,
                      rows: detail.mapping.validation.rows.slice(0, showRows),
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              {showRows < detail.mapping.example.rows.length && (
                <Button
                  variant="quiet"
                  onClick={() => setShowRows((value) => value + 20)}
                >
                  Show more example rows
                </Button>
              )}
              {canPrepare && detail.mapping.status === 'approved' && (
                <div>
                  <h4>Reuse this mapping</h4>
                  <p>
                    Select the reviewed PDF, XLSX or image original, or a saved
                    CSV, and its financial account. The report is validated
                    again before a report is saved. Portfolio rows become
                    statement observations, not opening balances.
                  </p>
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const result = z
                          .object({ accounts: z.array(Account) })
                          .parse(await request('/financial-accounts'));
                        if (alive.current)
                          setReuseAccounts(
                            detail.mapping.definition.reportType ===
                              'investment-positions'
                              ? result.accounts.filter(
                                  (a) => a.kind === 'brokerage',
                                )
                              : result.accounts,
                          );
                      })
                    }
                  >
                    Choose account for reuse
                  </Button>
                  {reuseAccounts && (
                    <form
                      onSubmit={reuse}
                      key={`${detail.mapping.id}:${detail.mapping.revision}`}
                    >
                      <label>
                        Saved report to standardize
                        <select name="evidenceId" required defaultValue="">
                          <option value="" disabled>
                            Select a saved report
                          </option>
                          {(detail.mapping.definition.pdfOcrSelection ||
                            detail.mapping.definition.imageSelection ||
                            detail.mapping.definition.xlsxSelection ||
                            detail.mapping.definition.pdfSelection) && (
                            <option value={detail.mapping.evidence_id}>
                              {detail.mapping.evidence_filename ??
                                (detail.mapping.definition.pdfOcrSelection
                                  ? 'Reviewed PDF OCR original'
                                  : detail.mapping.definition.imageSelection
                                    ? 'Reviewed image original'
                                    : detail.mapping.definition.pdfSelection
                                      ? 'Reviewed PDF original'
                                      : 'Reviewed XLSX original')}
                            </option>
                          )}
                          {documents
                            .filter(
                              (item) =>
                                !detail.mapping.definition.xlsxSelection &&
                                !detail.mapping.definition.pdfSelection &&
                                !detail.mapping.definition.imageSelection &&
                                !detail.mapping.definition.pdfOcrSelection &&
                                item.format === 'csv',
                            )
                            .map((item) => (
                              <option value={item.id} key={item.id}>
                                {item.filename}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        Report financial account
                        <select
                          name="financialAccountId"
                          required
                          defaultValue=""
                        >
                          <option value="" disabled>
                            Select an account
                          </option>
                          {reuseAccounts.map((item) => (
                            <option value={item.id} key={item.id}>
                              {item.name} · {item.currency}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Report provider
                        <input
                          name="providerKey"
                          required
                          maxLength={100}
                          placeholder={detail.mapping.definition.providerKey}
                        />
                      </label>
                      <p>
                        Enter the provider identity shown for this mapping after
                        checking the original report.
                      </p>
                      <Button
                        disabled={
                          busy || !reuseAccounts.length || !!createdImport
                        }
                      >
                        Standardize for import review
                      </Button>
                    </form>
                  )}
                  {createdImport && (
                    <p>
                      Saved import reference: <code>{createdImport}</code>. No
                      transactions have been posted.
                    </p>
                  )}
                </div>
              )}
              {canApprove && detail.mapping.status !== 'retired' && (
                <form
                  onSubmit={review}
                  key={`${detail.mapping.id}:${detail.mapping.revision}`}
                >
                  <label>
                    Mapping decision
                    <select
                      name="decision"
                      defaultValue={
                        detail.mapping.status === 'approved'
                          ? 'retire'
                          : detail.mapping.validation.status === 'normalized' &&
                              !detail.mapping.unresolved_questions.length
                            ? 'approve'
                            : 'retire'
                      }
                    >
                      {detail.mapping.status === 'candidate' &&
                        detail.mapping.validation.status === 'normalized' &&
                        !detail.mapping.unresolved_questions.length && (
                          <option value="approve">Approve this version</option>
                        )}
                      <option value="retire">Retire this version</option>
                    </select>
                  </label>
                  <label>
                    Review reason
                    <input
                      name="reason"
                      minLength={3}
                      maxLength={1000}
                      required
                    />
                  </label>
                  <Button disabled={busy}>Save mapping decision</Button>
                </form>
              )}
              <ul>
                {detail.reviews.map((item) => (
                  <li key={item.revision}>
                    Revision {item.revision}: {item.decision} — {item.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}
