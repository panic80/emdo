import { saveMemoryFile } from '../../downloads/save-memory-file.js';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import {
  FinanceTaxWageEvidencePreparationSchema,
  FinanceTaxWageExtractionSchema,
  FinanceTaxWageEvidenceReviewSchema,
  ReviewPrivateTaxWageEvidenceSchema,
  RecordPrivateTaxDeclarationSchema,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import {
  readTaxJson,
  TaxMutationSchema,
  type TaxDeclaration,
} from './finance-tax-model.js';
import {
  taxWorkingBinding,
  type TaxWorkingPreparation,
} from './finance-tax-working-model.js';
import type { TaxCaseOperation } from './finance-tax-workspace.js';
type Extraction = z.infer<typeof FinanceTaxWageExtractionSchema>;
const boxes = ['box1', 'box2', 'box3', 'box5', 'box6', 'box7'] as const;
export function TaxWageEvidence({
  caseId,
  preparation,
  source,
  canEdit,
  canReview,
  disabled,
  operate,
}: {
  caseId: string;
  preparation: TaxWorkingPreparation;
  source: TaxDeclaration | undefined;
  canEdit: boolean;
  canReview: boolean;
  disabled: boolean;
  operate: TaxCaseOperation;
}) {
  const [available, setAvailable] =
      useState<z.infer<typeof FinanceTaxWageEvidencePreparationSchema>>(),
    [documents, setDocuments] = useState<Extraction['documents']>([]),
    [error, setError] = useState(''),
    [checked, setChecked] = useState(false),
    [dirty, setDirty] = useState(false);
  const base = `/api/v2/finance/tax/cases/${caseId}/working-papers`;
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setChecked(false);
    setDirty(false);
    try {
      setDocuments(
        source?.value.type === 'text'
          ? FinanceTaxWageExtractionSchema.parse(JSON.parse(source.value.value))
              .documents
          : [],
      );
    } catch {
      setError('Saved wage extraction needs correction before review.');
    }
    void readTaxJson(`${base}/wage-evidence`, controller.signal)
      .then((raw) => {
        const data = FinanceTaxWageEvidencePreparationSchema.parse(raw);
        if (
          data.caseId !== caseId ||
          data.snapshotRevision !== preparation.snapshotRevision ||
          data.snapshotHash !== preparation.snapshotHash
        )
          throw Error('Wage evidence snapshot changed');
        setAvailable(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Wage documents unavailable',
          );
      });
    return () => controller.abort();
  }, [
    base,
    caseId,
    preparation.snapshotRevision,
    preparation.snapshotHash,
    source,
  ]);
  const reviewed =
    source &&
    preparation.inputReviews.some(
      (r) =>
        r.sourceId === source.sourceId &&
        r.sourceRevision === source.sourceRevision &&
        r.contentHash === source.contentHash,
    );
  async function save() {
    try {
      const value = FinanceTaxWageExtractionSchema.parse({
        schemaVersion: documents.some((d) => d.form === 'W-2c') ? 2 : 1,
        documents,
      });
      await operate(
        'declarations',
        RecordPrivateTaxDeclarationSchema.parse({
          expectedCaseRevision: preparation.snapshotRevision,
          ...(source ? { sourceId: source.sourceId } : {}),
          expectedSourceRevision: source?.sourceRevision ?? null,
          factKey: 'wageEvidence.documents',
          category: 'general',
          value: { type: 'text', value: JSON.stringify(value) },
        }),
        TaxMutationSchema,
        'Wage documents and boxes saved as unreviewed inputs.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save wage inputs');
    }
  }
  async function openOriginal(d: Extraction['documents'][number]) {
    try {
      const raw = await readTaxJson(
        `${base}/wage-original?bookId=${encodeURIComponent(d.bookId)}&evidenceId=${encodeURIComponent(d.evidenceId)}`,
        new AbortController().signal,
      );
      const original = z
        .strictObject({
          filename: z.string(),
          format: z.enum(['pdf', 'png', 'jpeg']),
          contentHash: z.string(),
          sourceBase64: z.string(),
        })
        .parse(raw);
      const bytes = Uint8Array.from(atob(original.sourceBase64), (c) =>
        c.charCodeAt(0),
      );
      saveMemoryFile(
        original.filename,
        bytes,
        original.format === 'pdf'
          ? 'application/pdf'
          : `image/${original.format}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Original unavailable');
    }
  }
  return (
    <section className="finance-tax-note" aria-label="W-2 original evidence">
      <h4>W-2 originals and saved boxes</h4>
      <p>
        Select original documents from books explicitly authorized for this
        case. Enter the six boxes exactly, including explicit zeroes. For a
        W-2c, retain the original and every earlier correction, select the
        document it corrects, and enter previously reported and correct amounts.
        Effective boxes must carry unchanged amounts forward. Saving boxes does
        not approve them.
      </p>
      {!available?.documents.length && (
        <p>
          Authorize a source book in Case access and upload originals through
          that book’s evidence flow. No documents are needed only when the
          federal package confirms no applicable W-2 attachment.
        </p>
      )}
      {documents.map((d, index) => (
        <fieldset key={index} disabled={!canEdit || disabled}>
          <legend>W-2 {index + 1}</legend>
          <label>
            Original document
            <select
              value={d.evidenceId}
              onChange={(e) => {
                const selected = available?.documents.find(
                  (x) => x.evidenceId === e.target.value,
                );
                if (selected) {
                  setDocuments((current) =>
                    current.map((v, i) =>
                      i === index
                        ? {
                            ...v,
                            bookId: selected.bookId,
                            evidenceId: selected.evidenceId,
                          }
                        : v,
                    ),
                  );
                  setDirty(true);
                }
              }}
            >
              <option value="">Select an authorized original</option>
              {available?.documents.map((o) => (
                <option key={o.evidenceId} value={o.evidenceId}>
                  {o.filename}
                </option>
              ))}
            </select>
          </label>
          <label>
            Document form
            <select
              value={d.form}
              onChange={(e) => {
                setDocuments((current) =>
                  current.map((v, i) =>
                    i !== index
                      ? v
                      : e.target.value === 'W-2'
                        ? {
                            bookId: v.bookId,
                            evidenceId: v.evidenceId,
                            form: 'W-2',
                            originalEvidenceId: null,
                            boxes: v.boxes,
                          }
                        : {
                            ...v,
                            form: 'W-2c',
                            originalEvidenceId: '',
                            supersedesEvidenceId: '',
                            corrections: [],
                          },
                  ),
                );
                setDirty(true);
              }}
            >
              <option value="W-2">W-2 original</option>
              <option value="W-2c">W-2c correction</option>
            </select>
          </label>
          {d.form === 'W-2c' && (
            <>
              <label>
                Root original W-2
                <select
                  value={d.originalEvidenceId ?? ''}
                  onChange={(e) => {
                    setDocuments((current) =>
                      current.map((v, i) =>
                        i === index
                          ? { ...v, originalEvidenceId: e.target.value }
                          : v,
                      ),
                    );
                    setDirty(true);
                  }}
                >
                  <option value="">Select retained original</option>
                  {documents
                    .filter((v) => v.form === 'W-2' && v.evidenceId)
                    .map((v) => (
                      <option key={v.evidenceId} value={v.evidenceId}>
                        {available?.documents.find(
                          (a) => a.evidenceId === v.evidenceId,
                        )?.filename ?? 'Unavailable original'}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Immediately previous document
                <select
                  value={
                    'supersedesEvidenceId' in d ? d.supersedesEvidenceId : ''
                  }
                  onChange={(e) => {
                    setDocuments((current) =>
                      current.map((v, i) =>
                        i === index
                          ? {
                              ...v,
                              supersedesEvidenceId: e.target.value,
                              corrections:
                                'corrections' in v ? v.corrections : [],
                            }
                          : v,
                      ),
                    );
                    setDirty(true);
                  }}
                >
                  <option value="">Select previous document</option>
                  {documents
                    .filter(
                      (v) => v.evidenceId && v.evidenceId !== d.evidenceId,
                    )
                    .map((v) => (
                      <option key={v.evidenceId} value={v.evidenceId}>
                        {available?.documents.find(
                          (a) => a.evidenceId === v.evidenceId,
                        )?.filename ?? 'Unavailable document'}
                      </option>
                    ))}
                </select>
              </label>
              <p>
                Select each changed box. Leave all unchecked only for an
                identity-only correction; effective boxes must still match the
                predecessor.
              </p>
              {boxes.map((box) => {
                const correction =
                  'corrections' in d
                    ? d.corrections.find((c) => c.box === box)
                    : undefined;
                return (
                  <div key={box}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!correction}
                        onChange={(e) => {
                          const selected = e.target.checked;
                          setDocuments((current) =>
                            current.map((v, i) =>
                              i === index
                                ? {
                                    ...v,
                                    corrections: selected
                                      ? [
                                          ...('corrections' in v
                                            ? v.corrections
                                            : []),
                                          { box, previous: '', correct: '' },
                                        ]
                                      : ('corrections' in v
                                          ? v.corrections
                                          : []
                                        ).filter((c) => c.box !== box),
                                  }
                                : v,
                            ),
                          );
                          setDirty(true);
                        }}
                      />
                      Correct {box.replace('box', 'Box ')}
                    </label>
                    {correction &&
                      (['previous', 'correct'] as const).map((kind) => (
                        <label key={kind}>
                          {kind === 'previous'
                            ? 'Previously reported'
                            : 'Correct amount'}{' '}
                          {box.replace('box', 'Box ')}
                          <input
                            inputMode="decimal"
                            value={correction[kind]}
                            onChange={(e) => {
                              setDocuments((current) =>
                                current.map((v, i) =>
                                  i === index && 'corrections' in v
                                    ? {
                                        ...v,
                                        corrections: v.corrections.map((c) =>
                                          c.box === box
                                            ? { ...c, [kind]: e.target.value }
                                            : c,
                                        ),
                                      }
                                    : v,
                                ),
                              );
                              setDirty(true);
                            }}
                          />
                        </label>
                      ))}
                  </div>
                );
              })}
            </>
          )}
          <div className="finance-tax-form-grid">
            {boxes.map((box) => (
              <label key={box}>
                {box.replace('box', 'Box ')}
                <input
                  inputMode="decimal"
                  value={d.boxes[box]}
                  onChange={(e) => {
                    setDocuments((current) =>
                      current.map((v, i) =>
                        i === index
                          ? {
                              ...v,
                              boxes: { ...v.boxes, [box]: e.target.value },
                            }
                          : v,
                      ),
                    );
                    setDirty(true);
                  }}
                />
              </label>
            ))}
          </div>
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              setDocuments((current) => current.filter((_, i) => i !== index));
              setDirty(true);
            }}
          >
            Remove W-2 {index + 1}
          </Button>
        </fieldset>
      ))}
      {documents.map((d, index) => (
        <Button
          key={d.evidenceId || index}
          type="button"
          variant="quiet"
          disabled={!d.evidenceId || disabled}
          onClick={() => void openOriginal(d)}
        >
          Download original W-2 {index + 1}
        </Button>
      ))}
      {canEdit && (
        <>
          <Button
            type="button"
            disabled={disabled || documents.length >= 5}
            onClick={() => {
              setDocuments((current) => [
                ...current,
                {
                  bookId: '',
                  evidenceId: '',
                  form: 'W-2',
                  originalEvidenceId: null,
                  boxes: {
                    box1: '',
                    box2: '',
                    box3: '',
                    box5: '',
                    box6: '',
                    box7: '',
                  },
                },
              ]);
              setDirty(true);
            }}
          >
            Add W-2 document
          </Button>
          <Button type="button" disabled={disabled} onClick={() => void save()}>
            {documents.length
              ? 'Save document boxes'
              : 'Save explicit no-document list'}
          </Button>
        </>
      )}
      {available?.review && (
        <p>
          Originals and exact saved extraction reviewed for this snapshot (
          {available.review.documentCount} documents).
        </p>
      )}
      {canReview && source && (
        <>
          <label>
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled || dirty || !reviewed}
              onChange={(e) => setChecked(e.target.checked)}
            />
            I checked these exact saved boxes against every original document.
          </label>
          <Button
            type="button"
            disabled={disabled || dirty || !reviewed || !checked}
            onClick={() =>
              void operate(
                'working-papers/wage-evidence-reviews',
                ReviewPrivateTaxWageEvidenceSchema.parse({
                  ...taxWorkingBinding(preparation),
                  input: {
                    sourceId: source.sourceId,
                    sourceRevision: source.sourceRevision,
                    contentHash: source.contentHash,
                  },
                  acknowledgement:
                    'verified-saved-boxes-against-original-documents',
                }),
                FinanceTaxWageEvidenceReviewSchema,
                'Exact saved wage extraction and originals reviewed.',
              ).catch((e) =>
                setError(e instanceof Error ? e.message : 'Review failed'),
              )
            }
          >
            Approve original evidence binding
          </Button>
          {!reviewed && (
            <p>
              Review the saved wage-document input version below before
              approving its original evidence binding.
            </p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
