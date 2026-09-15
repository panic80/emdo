import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  type FinanceStandardizationRun,
  type SaveReviewedFinanceImageMappingSchema,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
import {
  ImageReviewApiError,
  downloadImageReviewOriginal,
  isFinanceImage,
  readImageReview,
  type ImageReviewSource,
} from './finance-image-review-api.js';
import { ImageReviewSource as SourceEditor } from './finance-image-review-source.js';
import { ImageReviewFields } from './finance-image-review-fields.js';
import {
  blankImageDraft,
  emptyImageCell,
  imageCellFromWords,
  imageCells,
  imageDraftFromSelection,
  imageMappingPayload,
  imageMappingSettings,
  imageRegionCell,
  imageTargetLabel,
  updateImageCell,
  verifyImageSelection,
  type ImageBox,
  type ImageCell,
  type ImageDraft,
} from './finance-image-review-model.js';
import './finance-image-review.css';

type ImagePayload = z.infer<typeof SaveReviewedFinanceImageMappingSchema>;
type Props = {
  run: FinanceStandardizationRun;
  sourceAdapter?: {
    load: typeof readImageReview;
    download: typeof downloadImageReviewOriginal;
  };
  role: string;
  disabled: boolean;
  onSave: (payload: ImagePayload) => Promise<void>;
  onClose: () => void;
  onAccessUnavailable: (message: string) => void;
};
const unchecked = () => ({
  uncertainty: false,
  context: false,
  omissions: false,
});
const message = (cause: unknown) =>
  cause instanceof z.ZodError
    ? (cause.issues[0]?.message ??
      'Check the selected source and required fields.')
    : cause instanceof Error
      ? cause.message
      : 'The image review could not be completed.';
export function FinanceImageReview(props: Props) {
  const auth = useAuth();
  if (
    !props.run.extraction ||
    (!isFinanceImage(props.run.format) && !props.sourceAdapter)
  )
    return (
      <p role="status">
        This analysis has no saved image extraction to review. Check its status
        and available actions first.
      </p>
    );
  return (
    <ImageReviewEditor
      key={`${auth.sessionBinding}:${auth.state}:${props.run.bookId}:${props.run.id}:${props.run.revision}:${props.run.sourceDigest}:${props.run.extraction.revision}:${props.run.extraction.extractionDigest}:${props.role}`}
      {...props}
      source={{ ...props.run, extraction: props.run.extraction }}
    />
  );
}
function ImageReviewEditor({
  run,
  source,
  role,
  disabled,
  onSave,
  onClose,
  onAccessUnavailable,
  sourceAdapter,
}: Props & { source: ImageReviewSource }) {
  const auth = useAuth(),
    proposed = run.proposal?.definition;
  const [loaded, setLoaded] =
      useState<Awaited<ReturnType<typeof readImageReview>>>(),
    [loading, setLoading] = useState(true),
    [reload, setReload] = useState(0),
    [imageReady, setImageReady] = useState(false);
  const [draft, setDraft] = useState<ImageDraft>(() =>
      blankImageDraft(proposed?.headers.length),
    ),
    [target, setTarget] = useState<string>(),
    [rowOffset, setRowOffset] = useState(0);
  const [step, setStep] = useState<'source' | 'fields' | 'preview'>('source'),
    [settings, setSettings] = useState(() => imageMappingSettings(proposed));
  const [bindings, setBindings] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (proposed?.bindings ?? []).map((binding) => [
        binding.field,
        binding.context
          ? 'context'
          : String(proposed!.headers.indexOf(binding.column!)),
      ]),
    ),
  );
  const [preview, setPreview] = useState<ImagePayload>(),
    [notes, setNotes] = useState(''),
    [checks, setChecks] = useState(unchecked),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(''),
    [warning, setWarning] = useState(''),
    [omittedOffset, setOmittedOffset] = useState(0);
  const [questions, setQuestions] = useState(() =>
    (run.proposal?.unresolvedQuestions ?? []).map((question) => ({
      question,
      answer: '',
      resolved: false,
    })),
  );
  const alive = useRef(true),
    working = useRef(false),
    controller = useRef<AbortController | undefined>(undefined),
    panel = useRef<HTMLElement>(null);
  const canPrepare = ['administrator', 'preparer', 'approver'].includes(role),
    authenticated = !auth.state || auth.state === 'authenticated';
  const locked = disabled || loading || saving || !canPrepare || !authenticated;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!authenticated) {
      setLoading(false);
      return;
    }
    const control = new AbortController();
    controller.current?.abort();
    controller.current = control;
    setLoading(true);
    setLoaded(undefined);
    setImageReady(false);
    setError('');
    void (sourceAdapter?.load ?? readImageReview)(source, control.signal)
      .then((result) => {
        if (!alive.current || control.signal.aborted) return;
        setLoaded(result);
        let next = blankImageDraft(proposed?.headers.length);
        if (proposed?.imageSelection) {
          try {
            next = imageDraftFromSelection(
              verifyImageSelection(proposed.imageSelection, result.inspection),
            );
            setWarning(
              'The proposed cells are copied for inspection. Each one needs your fresh visual confirmation.',
            );
          } catch {
            setWarning(
              'The proposed regions do not match this saved original and OCR revision. Select source cells manually; the unverified regions were not copied.',
            );
          }
        } else
          setWarning(
            'No image cells have been confirmed. Select the headings, rows and any date or currency context from the original.',
          );
        setDraft(next);
        setTarget(undefined);
        setPreview(undefined);
        setStep('source');
        setChecks(unchecked());
      })
      .catch((cause: unknown) => {
        if (!alive.current || control.signal.aborted) return;
        setDraft(blankImageDraft());
        setPreview(undefined);
        setTarget(undefined);
        setError(message(cause));
        if (
          cause instanceof ImageReviewApiError &&
          [401, 403].includes(cause.status)
        )
          onAccessUnavailable(cause.message);
      })
      .finally(() => {
        if (alive.current && !control.signal.aborted) setLoading(false);
      });
    return () => control.abort();
    // Reopening a saved revision deliberately discards unsaved review state.
  }, [reload]);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
  }, [step, target]);
  const cells = imageCells(draft),
    active = cells.find((entry) => entry.key === target);
  const used = new Map(
    cells.flatMap(({ key, cell }) =>
      cell.wordIds.map((id) => [id, key] as const),
    ),
  );
  const omitted =
    loaded?.inspection.facts.words.filter((word) => !used.has(word.id)) ?? [];
  const confirmedCount = cells.filter(({ cell }) => cell.confirmed).length;
  function changeDraft(next: ImageDraft) {
    setDraft(next);
    setChecks(unchecked());
    setPreview(undefined);
    setError('');
  }
  function changeCell(cell: ImageCell) {
    if (target) changeDraft(updateImageCell(draft, target, cell));
  }
  function useRegion(box: ImageBox) {
    if (!loaded || !target) return;
    try {
      changeCell(imageRegionCell(box, loaded.inspection));
    } catch (cause) {
      setError(message(cause));
    }
  }
  function toggleWord(id: string) {
    if (!loaded || !active) return;
    try {
      changeCell(
        imageCellFromWords(
          active.cell.wordIds.includes(id)
            ? active.cell.wordIds.filter((value) => value !== id)
            : [...active.cell.wordIds, id],
          loaded.inspection,
        ),
      );
    } catch (cause) {
      setError(message(cause));
    }
  }
  function showPreview() {
    if (!loaded || locked) return;
    try {
      if (!imageReady)
        throw new Error(
          'Display and check the original image before preparing a source review.',
        );
      const answered = questions.filter(
        (item) => item.resolved && item.answer.trim(),
      );
      const value = imageMappingPayload({
        evidenceId: run.evidenceId,
        draft,
        inspection: loaded.inspection,
        settings,
        bindings,
        notes: [
          notes.trim(),
          ...answered.map(
            (item) =>
              `${item.question}\nReviewed answer: ${item.answer.trim()}`,
          ),
        ]
          .filter(Boolean)
          .join('\n\n'),
        questions: questions
          .filter((item) => !item.resolved || !item.answer.trim())
          .map((item) => item.question),
      });
      setPreview(value);
      setTarget(undefined);
      setChecks(unchecked());
      setStep('preview');
      setError('');
    } catch (cause) {
      setError(message(cause));
    }
  }
  async function save() {
    if (
      !preview ||
      locked ||
      !auth.csrfToken ||
      working.current ||
      !Object.values(checks).every(Boolean)
    )
      return;
    working.current = true;
    setSaving(true);
    setError('');
    try {
      await onSave(preview);
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      working.current = false;
      if (alive.current) setSaving(false);
    }
  }
  function download() {
    if (!controller.current || working.current) return;
    working.current = true;
    setSaving(true);
    setError('');
    const signal = controller.current.signal;
    void (sourceAdapter?.download ?? downloadImageReviewOriginal)(
      source,
      signal,
    )
      .catch((cause: unknown) => {
        if (!alive.current || signal.aborted) return;
        if (
          cause instanceof ImageReviewApiError &&
          [401, 403].includes(cause.status)
        ) {
          setLoaded(undefined);
          setDraft(blankImageDraft());
          setPreview(undefined);
          onAccessUnavailable(cause.message);
        } else setError(message(cause));
      })
      .finally(() => {
        working.current = false;
        if (alive.current && !signal.aborted) setSaving(false);
      });
  }
  const cellButton = (key: string, cell: ImageCell) => (
    <button
      type="button"
      className={`finance-image-cell-button${cell.confirmed ? ' is-confirmed' : ''}`}
      disabled={locked}
      aria-label={`Review ${imageTargetLabel(key)}: ${cell.reviewedText || 'source missing'}`}
      onClick={() => {
        setStep('source');
        setTarget(key);
      }}
    >
      <strong>{cell.reviewedText || 'Select source'}</strong>
      <span>
        {cell.confirmed
          ? 'Visually confirmed'
          : cell.region
            ? 'Needs visual confirmation'
            : 'No region selected'}
      </span>
    </button>
  );
  return (
    <section className="finance-image-review" aria-label="Image source review">
      <div className="finance-image-section-heading">
        <div>
          <span className="finance-image-eyebrow">
            Original image · source review
          </span>
          <h4>{run.filename}</h4>
          <p>
            Establish a table from the original image. Saving creates a
            candidate for a separate mapping decision.
          </p>
        </div>
        <Button
          type="button"
          variant="quiet"
          disabled={saving || disabled}
          onClick={onClose}
        >
          Close image review
        </Button>
      </div>
      {error && (
        <p role="alert" className="finance-image-notice">
          {error}
        </p>
      )}
      {loading && (
        <p role="status">Loading the original and its saved OCR words…</p>
      )}
      {!loading && !loaded && (
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() => setReload(reload + 1)}
        >
          Retry image inspection
        </Button>
      )}
      {loaded && (
        <>
          <div className="finance-image-source-summary">
            <span>
              <strong>{loaded.inspection.facts.words.length}</strong> saved OCR
              words
            </span>
            <span>
              <strong>
                {confirmedCount} / {cells.length}
              </strong>{' '}
              cells visually confirmed
            </span>
            <span>
              <strong>{omitted.length}</strong> words outside selected cells
            </span>
            <Button
              type="button"
              variant="quiet"
              disabled={locked}
              onClick={download}
            >
              Download image original
            </Button>
          </div>
          {warning && <p className="finance-image-notice">{warning}</p>}
          {loaded.inspection.facts.status === 'no-text' && (
            <p className="finance-image-notice">
              OCR found no readable words. If the original is legible, select
              explicit pixel regions and explain each manual transcription. An
              unreadable image cannot support a reviewed value.
            </p>
          )}
          {loaded.inspection.facts.qualityStatus !== 'high-confidence' && (
            <p className="finance-image-quality">
              Some machine readings are uncertain. Check punctuation, minus
              signs, dates and decimal places directly against the original.
            </p>
          )}
          <nav className="finance-image-steps" aria-label="Image review steps">
            <button
              type="button"
              disabled={locked}
              aria-current={step === 'source' ? 'step' : undefined}
              onClick={() => {
                setStep('source');
                setTarget(undefined);
              }}
            >
              1 · Source cells
            </button>
            <button
              type="button"
              disabled={locked || !draft.headers.length}
              aria-current={step === 'fields' ? 'step' : undefined}
              onClick={() => {
                setStep('fields');
                setTarget(undefined);
              }}
            >
              2 · Field meanings
            </button>
            <button
              type="button"
              disabled={locked || !preview}
              aria-current={step === 'preview' ? 'step' : undefined}
              onClick={() => setStep('preview')}
            >
              3 · Review candidate
            </button>
          </nav>
          <section
            ref={panel}
            tabIndex={-1}
            className="finance-image-active-panel"
            aria-label="Current image review step"
          >
            {step === 'source' && active ? (
              <SourceEditor
                key={target}
                inspection={loaded.inspection}
                imageUrl={loaded.original.imageUrl}
                filename={loaded.original.filename}
                target={target!}
                cell={active.cell}
                used={used}
                locked={locked}
                imageReady={imageReady}
                onReady={setImageReady}
                onChange={changeCell}
                onWord={toggleWord}
                onRegion={useRegion}
                onDone={() => setTarget(undefined)}
              />
            ) : step === 'source' ? (
              <>
                <h5>Select the table’s headings and rows</h5>
                <p>
                  Add only the columns and rows you can locate in the original.
                  Row numbers below describe your selected order.
                </p>
                <div className="finance-image-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={locked || draft.headers.length >= 100}
                    onClick={() => {
                      const column = draft.headers.length;
                      changeDraft({
                        ...draft,
                        headers: [...draft.headers, emptyImageCell()],
                        rows: draft.rows.length
                          ? draft.rows.map((row) => [...row, emptyImageCell()])
                          : [[emptyImageCell()]],
                      });
                      setTarget(`h:${column}`);
                    }}
                  >
                    Add source column
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
                          draft.headers.map(emptyImageCell),
                        ],
                      });
                      setRowOffset(Math.floor(draft.rows.length / 10) * 10);
                    }}
                  >
                    Add selected row
                  </Button>
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={locked || !draft.headers.length}
                    onClick={() => {
                      const last = draft.headers.length - 1;
                      changeDraft({
                        ...draft,
                        headers: draft.headers.slice(0, -1),
                        rows: last
                          ? draft.rows.map((row) => row.slice(0, -1))
                          : [],
                      });
                      setBindings(
                        Object.fromEntries(
                          Object.entries(bindings).filter(
                            ([, value]) => value !== String(last),
                          ),
                        ),
                      );
                    }}
                  >
                    Remove last column
                  </Button>
                </div>
                {!draft.headers.length ? (
                  <p className="finance-image-empty">
                    Start with a heading in the original image. Every selected
                    heading and value will retain its own pixel region.
                  </p>
                ) : (
                  <div
                    className="finance-image-table-scroll"
                    role="region"
                    aria-label="Selected image cells table"
                    tabIndex={0}
                  >
                    <table>
                      <caption>
                        Selected source cells · confirmations are individual
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Selected row</th>
                          {draft.headers.map((cell, column) => (
                            <th scope="col" key={column}>
                              {cellButton(`h:${column}`, cell)}
                            </th>
                          ))}
                          <th scope="col">Row action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {draft.rows
                          .slice(rowOffset, rowOffset + 10)
                          .map((row, index) => (
                            <tr key={rowOffset + index}>
                              <th scope="row">Row {rowOffset + index + 1}</th>
                              {row.map((cell, column) => (
                                <td key={column}>
                                  {cellButton(
                                    `r:${rowOffset + index}:${column}`,
                                    cell,
                                  )}
                                </td>
                              ))}
                              <td>
                                <Button
                                  type="button"
                                  variant="quiet"
                                  disabled={locked}
                                  aria-label={`Remove selected row ${rowOffset + index + 1}`}
                                  onClick={() => {
                                    changeDraft({
                                      ...draft,
                                      rows: draft.rows.filter(
                                        (_, i) => i !== rowOffset + index,
                                      ),
                                    });
                                    setRowOffset(
                                      Math.max(
                                        0,
                                        Math.min(
                                          rowOffset,
                                          Math.floor(
                                            (draft.rows.length - 2) / 10,
                                          ) * 10,
                                        ),
                                      ),
                                    );
                                  }}
                                >
                                  Remove
                                </Button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {draft.rows.length > 10 && (
                  <div className="finance-image-actions">
                    <Button
                      type="button"
                      variant="quiet"
                      disabled={!rowOffset}
                      onClick={() => setRowOffset(rowOffset - 10)}
                    >
                      Previous rows
                    </Button>
                    <span>
                      Rows {rowOffset + 1}–
                      {Math.min(rowOffset + 10, draft.rows.length)} of{' '}
                      {draft.rows.length}
                    </span>
                    <Button
                      type="button"
                      variant="quiet"
                      disabled={rowOffset + 10 >= draft.rows.length}
                      onClick={() => setRowOffset(rowOffset + 10)}
                    >
                      Next rows
                    </Button>
                  </div>
                )}
                <div className="finance-image-context">
                  <h6>Context printed outside the table</h6>
                  <p>
                    Date and currency context are optional source regions. They
                    remain absent unless you select them explicitly.
                  </p>
                  {(['asOf', 'currency'] as const).map((field) => (
                    <div key={field}>
                      {draft.context[field] ? (
                        <>
                          {cellButton(`c:${field}`, draft.context[field])}
                          <Button
                            type="button"
                            variant="quiet"
                            disabled={locked}
                            onClick={() =>
                              changeDraft({
                                ...draft,
                                context: { ...draft.context, [field]: null },
                              })
                            }
                          >
                            Remove {field === 'asOf' ? 'date' : 'currency'}{' '}
                            context
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={locked}
                          onClick={() => {
                            changeDraft({
                              ...draft,
                              context: {
                                ...draft.context,
                                [field]: emptyImageCell(),
                              },
                            });
                            setTarget(`c:${field}`);
                          }}
                        >
                          Select {field === 'asOf' ? 'as-of date' : 'currency'}{' '}
                          context
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  disabled={locked || !draft.headers.length}
                  onClick={() => setStep('fields')}
                >
                  Continue to field meanings
                </Button>
              </>
            ) : step === 'fields' ? (
              <>
                <ImageReviewFields
                  settings={settings}
                  bindings={bindings}
                  draft={draft}
                  locked={locked}
                  onSettings={(value) => {
                    setSettings(value);
                    setPreview(undefined);
                    setChecks(unchecked());
                  }}
                  onBindings={(value) => {
                    setBindings(value);
                    setPreview(undefined);
                    setChecks(unchecked());
                  }}
                />
                <label className="finance-image-notes">
                  Image source review notes
                  <textarea
                    value={notes}
                    disabled={locked}
                    maxLength={2400}
                    rows={3}
                    onChange={(event) => {
                      setNotes(event.target.value);
                      setPreview(undefined);
                    }}
                  />
                  <small>
                    Record what you verified in the original, including sign
                    conventions, corrections and omitted content.
                  </small>
                </label>
                {!!questions.length && (
                  <div className="finance-image-questions">
                    <h6>Questions from the saved proposal</h6>
                    <p>
                      Unresolved questions remain attached to the candidate and
                      prevent approval.
                    </p>
                    {questions.map((item, index) => (
                      <div key={index}>
                        <p>{item.question}</p>
                        <label>
                          Source-backed answer {index + 1}
                          <input
                            maxLength={500}
                            value={item.answer}
                            disabled={locked}
                            onChange={(event) => {
                              setQuestions(
                                questions.map((old, i) =>
                                  i === index
                                    ? {
                                        ...old,
                                        answer: event.target.value,
                                        resolved: false,
                                      }
                                    : old,
                                ),
                              );
                              setPreview(undefined);
                            }}
                          />
                        </label>
                        <label className="finance-image-check">
                          <input
                            type="checkbox"
                            checked={item.resolved}
                            disabled={locked || !item.answer.trim()}
                            onChange={(event) => {
                              setQuestions(
                                questions.map((old, i) =>
                                  i === index
                                    ? { ...old, resolved: event.target.checked }
                                    : old,
                                ),
                              );
                              setPreview(undefined);
                            }}
                          />
                          I resolved this question by checking the original.
                        </label>
                      </div>
                    ))}
                  </div>
                )}
                <div className="finance-image-actions">
                  <Button type="button" disabled={locked} onClick={showPreview}>
                    Preview selected transcription
                  </Button>
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={locked}
                    onClick={() => setStep('source')}
                  >
                    Return to source cells
                  </Button>
                </div>
              </>
            ) : preview ? (
              <>
                <span className="finance-image-eyebrow">
                  Selected transcription · before saving
                </span>
                <h5>Review the selected image candidate</h5>
                <p>
                  This preview shows your selected text and field choices. Save
                  the candidate to obtain the server’s normalization and
                  validation results. Mapping approval and import remain
                  separate.
                </p>
                <div
                  className="finance-image-table-scroll"
                  role="region"
                  aria-label="Selected transcription preview"
                  tabIndex={0}
                >
                  <table>
                    <caption>
                      {settings.reportName} · {draft.rows.length} selected{' '}
                      {draft.rows.length === 1 ? 'row' : 'rows'}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Selected row</th>
                        {preview.proposal.definition.headers.map((header) => (
                          <th scope="col" key={header}>
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.proposal.definition
                        .imageSelection!.rows.slice(0, 20)
                        .map((row, index) => (
                          <tr key={index}>
                            <th scope="row">{index + 1}</th>
                            {row.cells.map((cell, column) => (
                              <td key={column}>
                                {cell.reviewedText}
                                {cell.correctionReason && (
                                  <small>Visual correction recorded</small>
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {draft.rows.length > 20 && (
                  <p>
                    Showing the first 20 selected rows. All {draft.rows.length}{' '}
                    reviewed rows will be included in the candidate.
                  </p>
                )}
                <dl className="finance-image-review-summary">
                  <div>
                    <dt>Coverage</dt>
                    <dd>
                      Selected pixel regions only · {omitted.length} OCR words
                      omitted
                    </dd>
                  </div>
                  <div>
                    <dt>Original</dt>
                    <dd>
                      {run.filename} · saved extraction revision{' '}
                      {loaded.inspection.extractionRevision}
                    </dd>
                  </div>
                  <div>
                    <dt>Context</dt>
                    <dd>
                      Date: {draft.context.asOf?.reviewedText ?? 'Not selected'}{' '}
                      · Currency:{' '}
                      {draft.context.currency?.reviewedText ?? 'Not selected'}
                    </dd>
                  </div>
                  <div>
                    <dt>Review notes</dt>
                    <dd>{preview.proposal.rationale}</dd>
                  </div>
                </dl>
                {!!preview.proposal.unresolvedQuestions.length && (
                  <p className="finance-image-notice">
                    {preview.proposal.unresolvedQuestions.length} unresolved{' '}
                    {preview.proposal.unresolvedQuestions.length === 1
                      ? 'question remains'
                      : 'questions remain'}
                    . This candidate will need further review before approval.
                  </p>
                )}
                <div className="finance-image-save-review">
                  <label className="finance-image-check">
                    <input
                      type="checkbox"
                      disabled={locked}
                      checked={checks.uncertainty}
                      onChange={(event) =>
                        setChecks({
                          ...checks,
                          uncertainty: event.target.checked,
                        })
                      }
                    />
                    I checked the selected text against the original and
                    reviewed OCR uncertainty and corrections.
                  </label>
                  <label className="finance-image-check">
                    <input
                      type="checkbox"
                      disabled={locked}
                      checked={checks.context}
                      onChange={(event) =>
                        setChecks({ ...checks, context: event.target.checked })
                      }
                    />
                    I checked the headings, field meanings, number conventions,
                    and selected or absent context.
                  </label>
                  <label className="finance-image-check">
                    <input
                      type="checkbox"
                      disabled={locked}
                      checked={checks.omissions}
                      onChange={(event) =>
                        setChecks({
                          ...checks,
                          omissions: event.target.checked,
                        })
                      }
                    />
                    I reviewed unselected content. This candidate covers only
                    the selected regions.
                  </label>
                  <Button
                    type="button"
                    disabled={
                      locked ||
                      !auth.csrfToken ||
                      !Object.values(checks).every(Boolean)
                    }
                    onClick={() => void save()}
                  >
                    {saving
                      ? 'Saving reviewed candidate…'
                      : 'Save reviewed image candidate'}
                  </Button>
                  <p>
                    No mapping approval, import or financial posting is
                    performed by this action.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={locked}
                  onClick={() => {
                    setStep('fields');
                    setChecks(unchecked());
                  }}
                >
                  Return to field review
                </Button>
              </>
            ) : null}
          </section>
          <details className="finance-image-omissions">
            <summary>Unselected OCR words · {omitted.length}</summary>
            <p>
              Unselected regions may contain totals, notes or additional rows.
              They are outside this candidate’s coverage. OCR can also miss
              visible content entirely; inspect the original beyond the boxes.
            </p>
            {!omitted.length && (
              <p>
                All saved OCR words are selected. This does not prove that OCR
                found all visible content.
              </p>
            )}
            <ul>
              {omitted.slice(omittedOffset, omittedOffset + 40).map((word) => (
                <li key={word.id}>
                  <strong>{word.text}</strong>
                  <span>
                    {' '}
                    {word.box.x}, {word.box.y} · {word.box.width} ×{' '}
                    {word.box.height} px · {word.confidenceStatus}
                  </span>
                </li>
              ))}
            </ul>
            {omitted.length > 40 && (
              <div className="finance-image-actions">
                <Button
                  type="button"
                  variant="quiet"
                  disabled={!omittedOffset}
                  onClick={() =>
                    setOmittedOffset(Math.max(0, omittedOffset - 40))
                  }
                >
                  Previous unselected words
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={omittedOffset + 40 >= omitted.length}
                  onClick={() => setOmittedOffset(omittedOffset + 40)}
                >
                  Next unselected words
                </Button>
              </div>
            )}
          </details>
          <details className="finance-image-provenance">
            <summary>Saved extraction provenance and findings</summary>
            <p>
              These records describe the machine observation and exact source
              identity. Visual review is recorded separately.
            </p>
            <pre>
              {JSON.stringify(
                {
                  sourceDigest: loaded.inspection.sourceDigest,
                  extractionRevision: loaded.inspection.extractionRevision,
                  extractionDigest: loaded.inspection.extractionDigest,
                  wordInventoryDigest: loaded.inspection.wordInventoryDigest,
                  engine: loaded.inspection.facts.engine,
                  issues: loaded.inspection.facts.issues,
                  proposalCoverage:
                    run.modelProvenance?.promptProjection ?? null,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
