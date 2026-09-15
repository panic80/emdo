import { useState, type ComponentProps } from 'react';
import { z } from 'zod';
import { RecordPrivateTaxDeclarationSchema } from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import type { TaxDeclarationEditor } from './finance-tax-inputs.js';

// Mirrors the supported Mexico 2025 investment input contract; no tax calculation here.
const Asset = z
  .strictObject({
    assetId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    assetClass: z.enum(['office-furniture-equipment', 'computer-equipment']),
    acquisitionDate: z.iso.date().regex(/^2025-/),
    firstUseDate: z.iso.date().regex(/^2025-(?:0[1-9]|1[01])-01$/),
    originalInvestment: z
      .string()
      .max(100)
      .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
      .refine((value) => /[1-9]/.test(value)),
  })
  .refine((row) => row.acquisitionDate <= row.firstUseDate);
export const MexicoInvestmentRows = z
  .array(Asset)
  .max(10)
  .refine(
    (rows) => new Set(rows.map((row) => row.assetId)).size === rows.length,
  );
type Row = {
  assetId: string;
  assetClass: string;
  acquisitionDate: string;
  firstUseDate: string;
  originalInvestment: string;
};
const blank = (): Row => ({
  assetId: '',
  assetClass: '',
  acquisitionDate: '',
  firstUseDate: '',
  originalInvestment: '',
});
export function TaxMexicoInvestmentsEditor({
  source,
  revision,
  disabled,
  onCancel,
  onSave,
}: ComponentProps<typeof TaxDeclarationEditor>) {
  const [initial] = useState(() => {
    if (!source)
      return { rows: [] as Row[], malformed: false, noAssets: false };
    try {
      if (source.value.type !== 'text') throw new Error();
      const rows = MexicoInvestmentRows.parse(JSON.parse(source.value.value));
      return { rows, malformed: false, noAssets: rows.length === 0 };
    } catch {
      return { rows: [] as Row[], malformed: true, noAssets: false };
    }
  });
  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [noAssets, setNoAssets] = useState(initial.noAssets);
  const [review, setReview] = useState<z.infer<typeof MexicoInvestmentRows>>();
  const [error, setError] = useState('');
  const update = (index: number, field: keyof Row, value: string) =>
    setRows((old) =>
      old.map((row, position) =>
        position === index ? { ...row, [field]: value } : row,
      ),
    );
  async function save() {
    if (!review || disabled || initial.malformed) return;
    try {
      await onSave(
        RecordPrivateTaxDeclarationSchema.parse({
          expectedCaseRevision: revision,
          ...(source ? { sourceId: source.sourceId } : {}),
          expectedSourceRevision: source?.sourceRevision ?? null,
          factKey: 'corporation.investments.rows',
          category: source?.category ?? 'general',
          value: { type: 'text', value: JSON.stringify(review) },
        }),
      );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to save assets.',
      );
    }
  }
  return (
    <section
      className="finance-tax-editor"
      aria-label="Mexico investment assets"
    >
      <h3>Mexico 2025 investment assets</h3>
      <p>
        Enter supported assets individually. Saving creates an unreviewed input
        version. The four applicability reviews remain separate.
      </p>
      <Button variant="quiet" disabled={disabled} onClick={onCancel}>
        Back to working-paper inputs
      </Button>
      {initial.malformed ? (
        <p role="alert">
          The saved asset rows are malformed or contain unsupported fields. No
          rows have been discarded. Return to the saved declaration to correct
          it before using this editor.
        </p>
      ) : review ? (
        <>
          <h4>Review asset input</h4>
          {review.length === 0 ? (
            <p>No investment assets declared.</p>
          ) : (
            review.map((row) => (
              <dl key={row.assetId}>
                <dt>Asset identifier</dt>
                <dd>{row.assetId}</dd>
                <dt>Asset class</dt>
                <dd>
                  {row.assetClass === 'computer-equipment'
                    ? 'Computer equipment'
                    : 'Office furniture and equipment'}
                </dd>
                <dt>Acquired / first used</dt>
                <dd>
                  {row.acquisitionDate} / {row.firstUseDate}
                </dd>
                <dt>Original investment (MXN)</dt>
                <dd>{row.originalInvestment}</dd>
              </dl>
            ))
          )}
          <p>
            This saves source facts only. It does not approve inputs or
            calculate a deduction.
          </p>
          <Button disabled={disabled} onClick={() => void save()}>
            Save assets as unreviewed input
          </Button>
          <Button
            variant="quiet"
            disabled={disabled}
            onClick={() => setReview(undefined)}
          >
            Edit asset rows
          </Button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            const parsed = MexicoInvestmentRows.safeParse(noAssets ? [] : rows);
            if (!parsed.success || (!noAssets && !rows.length)) {
              setError(
                'Check every asset: unique identifier, supported class, valid 2025 acquisition, first use on January–November first day after acquisition, and positive exact amount with at most two decimal places.',
              );
              return;
            }
            setReview(parsed.data);
          }}
        >
          <fieldset disabled={disabled}>
            <legend>Asset source facts</legend>
            <label>
              <input
                type="checkbox"
                checked={noAssets}
                disabled={rows.length > 0}
                onChange={(event) => setNoAssets(event.target.checked)}
              />
              No investment assets for this working paper
            </label>
            {rows.map((row, index) => (
              <fieldset key={index}>
                <legend>Asset {index + 1}</legend>
                <label>
                  Asset identifier
                  <input
                    required
                    maxLength={40}
                    value={row.assetId}
                    onChange={(event) =>
                      update(index, 'assetId', event.target.value)
                    }
                  />
                </label>
                <label>
                  Asset class
                  <select
                    required
                    value={row.assetClass}
                    onChange={(event) =>
                      update(index, 'assetClass', event.target.value)
                    }
                  >
                    <option value="">Choose a class</option>
                    <option value="office-furniture-equipment">
                      Office furniture and equipment
                    </option>
                    <option value="computer-equipment">
                      Computer equipment
                    </option>
                  </select>
                </label>
                <label>
                  Acquisition date
                  <input
                    type="date"
                    required
                    min="2025-01-01"
                    max="2025-12-31"
                    value={row.acquisitionDate}
                    onChange={(event) =>
                      update(index, 'acquisitionDate', event.target.value)
                    }
                  />
                </label>
                <label>
                  First-use date
                  <input
                    type="date"
                    required
                    min="2025-01-01"
                    max="2025-11-01"
                    value={row.firstUseDate}
                    onChange={(event) =>
                      update(index, 'firstUseDate', event.target.value)
                    }
                  />
                  <small>
                    First day of a month, January through November 2025.
                  </small>
                </label>
                <label>
                  Original investment (MXN)
                  <input
                    required
                    inputMode="decimal"
                    maxLength={100}
                    value={row.originalInvestment}
                    onChange={(event) =>
                      update(index, 'originalInvestment', event.target.value)
                    }
                  />
                </label>
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() =>
                    setRows((old) =>
                      old.filter((_, position) => position !== index),
                    )
                  }
                >
                  Remove asset {index + 1}
                </Button>
              </fieldset>
            ))}
            <Button
              type="button"
              variant="secondary"
              disabled={noAssets || rows.length >= 10}
              onClick={() => setRows((old) => [...old, blank()])}
            >
              Add asset
            </Button>
            <Button type="submit">Review asset rows</Button>
          </fieldset>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
