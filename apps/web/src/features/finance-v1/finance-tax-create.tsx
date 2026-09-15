import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  CreatePrivateTaxCaseSchema,
  type FinanceTaxQuestionnaire,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import {
  TaxBooksSchema,
  readTaxJson,
  taxCountries,
  taxCountryName,
  taxTriState,
} from './finance-tax-model.js';

type Input = z.infer<typeof CreatePrivateTaxCaseSchema>;
export function FinanceTaxCreate({
  busy,
  onSave,
  onCancel,
}: {
  busy: boolean;
  onSave: (input: Input) => Promise<void>;
  onCancel: () => void;
}) {
  const [review, setReview] = useState<Input>();
  const [error, setError] = useState('');
  const [type, setType] = useState('');
  const [books, setBooks] = useState<z.infer<typeof TaxBooksSchema>['books']>(
    [],
  );
  const [entityId, setEntityId] = useState('');
  const [booksError, setBooksError] = useState('');
  useEffect(() => {
    if (type !== 'corporation') {
      setEntityId('');
      return;
    }
    const controller = new AbortController();
    void readTaxJson('/api/v2/finance/books', controller.signal)
      .then((raw) => {
        const result = TaxBooksSchema.parse(raw);
        if (!controller.signal.aborted) {
          setBooks(result.books);
          setBooksError('');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setBooks([]);
          setEntityId('');
          setBooksError(
            'Entity choices are unavailable. You can still save incomplete intake.',
          );
        }
      });
    return () => controller.abort();
  }, [type]);
  const [parties, setParties] = useState<
    FinanceTaxQuestionnaire['relatedParties']
  >([]);
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    const boolean = (name: string) =>
      form.get(name) === 'yes' ? true : form.get(name) === 'no' ? false : null;
    try {
      setReview(
        CreatePrivateTaxCaseSchema.parse({
          mode: 'intake-only',
          ...(type === 'corporation' && entityId
            ? { legalEntityId: entityId }
            : {}),
          title: form.get('title'),
          taxSubjectName: form.get('taxSubjectName'),
          scope: {
            country: form.get('country'),
            subdivision: form.get('subdivision'),
            taxpayerType: type,
            year: Number(form.get('year')),
            regime: form.get('regime'),
            formVersion: form.get('formVersion'),
          },
          domesticResident: boolean('domesticResident'),
          hasCrossBorderActivity: boolean('hasCrossBorderActivity'),
          standaloneCorporation:
            type === 'corporation' ? boolean('standaloneCorporation') : null,
          relatedParties: parties,
        }),
      );
    } catch (failure) {
      setError(
        failure instanceof z.ZodError
          ? failure.issues.map((issue) => issue.message).join(' ')
          : 'Check the case setup.',
      );
    }
  }
  async function save() {
    if (!review || busy) return;
    setError('');
    try {
      await onSave(review);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to create this tax case.',
      );
    }
  }
  return (
    <section
      className="finance-tax-create"
      aria-label="Create private tax case"
    >
      <div className="finance-tax-heading">
        <div>
          <span className="finance-tax-eyebrow">Private preparation</span>
          <h3>Start a tax case</h3>
          <p>
            Save inputs for an exact tax subject and period. Full-return
            calculations and filing are not available.
          </p>
        </div>
        <Button
          type="button"
          variant="quiet"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel new case
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={prepare}
        hidden={!!review}
        style={review ? { display: 'none' } : undefined}
      >
        <fieldset disabled={busy}>
          <legend>Case and tax subject</legend>
          <div className="finance-tax-form-grid">
            <label>
              Case title
              <input
                name="title"
                required
                maxLength={200}
                placeholder="A name you will recognize"
              />
            </label>
            <label>
              Person or legal entity
              <input
                name="taxSubjectName"
                required
                maxLength={200}
                autoComplete="off"
              />
            </label>
            <label>
              Taxpayer type
              <select
                required
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                <option value="" disabled>
                  Choose a type
                </option>
                <option value="individual">Individual</option>
                <option value="sole-proprietor">Sole proprietor</option>
                <option value="corporation">Corporation</option>
              </select>
            </label>
          </div>
        </fieldset>
        {type === 'corporation' && (
          <label>
            Corporate legal entity
            <select
              value={entityId}
              onChange={(event) => setEntityId(event.target.value)}
              disabled={busy}
            >
              <option value="">Not selected — incomplete intake</option>
              {books
                .filter((book) => book.legalEntityId)
                .map((book) => (
                  <option key={book.id} value={book.legalEntityId!}>
                    {book.entityName} · {book.name}
                  </option>
                ))}
            </select>
            <small>
              Choose the corporation explicitly for corporate calculations. This
              does not authorize book balances as tax sources.
            </small>
            {booksError && <span role="status">{booksError}</span>}
          </label>
        )}
        <fieldset disabled={busy}>
          <legend>Exact return scope</legend>
          <Button
            type="button"
            variant="quiet"
            onClick={(event) => {
              const form = event.currentTarget.form;
              if (!form) return;
              setType('corporation');
              for (const [name, value] of Object.entries({
                country: 'CA',
                subdivision: 'CA-ON',
                year: '2025',
                regime: 'income-tax-return',
                formVersion: 'T2-2025_GIFI-2025_ON-2025',
              })) {
                const control = form.elements.namedItem(name);
                if (
                  control instanceof HTMLInputElement ||
                  control instanceof HTMLSelectElement
                )
                  control.value = value;
              }
            }}
          >
            Use Ontario 2025 corporate scope
          </Button>
          <Button
            type="button"
            variant="quiet"
            onClick={(event) => {
              const form = event.currentTarget.form;
              if (!form) return;
              setType('sole-proprietor');
              for (const [name, value] of Object.entries({
                country: 'US',
                subdivision: 'US-FED',
                year: '2025',
                regime: 'income-tax-return',
                formVersion: '1040-2025',
              })) {
                const control = form.elements.namedItem(name);
                if (
                  control instanceof HTMLInputElement ||
                  control instanceof HTMLSelectElement
                )
                  control.value = value;
              }
            }}
          >
            Use US 2025 sole-proprietor federal scope
          </Button>
          <p>US federal working papers exclude state and local returns.</p>
          {(
            [
              [
                'individual',
                'salary individual',
                'declaracion-anual-pf-2025-sueldos',
              ],
              [
                'sole-proprietor',
                'professional sole proprietor',
                'declaracion-anual-pf-2025-actividad-profesional',
              ],
              [
                'corporation',
                'standalone corporation',
                'declaracion-anual-pm-2025-regimen-general',
              ],
            ] as const
          ).map(([taxpayerType, label, formVersion]) => (
            <Button
              key={taxpayerType}
              type="button"
              variant="quiet"
              onClick={(event) => {
                const form = event.currentTarget.form;
                if (!form) return;
                setType(taxpayerType);
                for (const [name, value] of Object.entries({
                  country: 'MX',
                  subdivision: 'MX-FED',
                  year: '2025',
                  regime: 'income-tax-return',
                  formVersion,
                })) {
                  const control = form.elements.namedItem(name);
                  if (
                    control instanceof HTMLInputElement ||
                    control instanceof HTMLSelectElement
                  )
                    control.value = value;
                }
              }}
            >
              Use Mexico 2025 {label} scope
            </Button>
          ))}
          <p>
            Mexico federal working papers are incomplete preparation records,
            not a completed SAT return or filing.
          </p>
          <div className="finance-tax-form-grid">
            <label>
              Country
              <select name="country" required defaultValue="">
                <option value="" disabled>
                  Choose a country
                </option>
                {taxCountries.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Province, state or region code
              <input
                name="subdivision"
                required
                maxLength={160}
                placeholder="For example, CA-ON"
              />
              <small>Use the region identifier for this return.</small>
            </label>
            <label>
              Tax year
              <input
                name="year"
                type="number"
                required
                min={1900}
                max={9999}
                step={1}
              />
            </label>
            <label>
              Return type
              <select name="regime" required defaultValue="">
                <option value="" disabled>
                  Choose a return type
                </option>
                <option value="income-tax-return">Income tax return</option>
              </select>
            </label>
            <label>
              Form and version reference
              <input
                name="formVersion"
                required
                maxLength={160}
                placeholder="For example, T1-2025"
              />
              <small>
                Record the exact form identifier and version from your
                documents. The limited Ontario 2025 personal working-paper
                workflow uses 5006-R-E-25_5006-C-E-25 for individuals and sole
                proprietors. Standalone corporate working papers use
                T2-2025_GIFI-2025_ON-2025 for CA / CA-ON / 2025. Neither
                workflow completes a return.
              </small>
            </label>
          </div>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>What is established so far?</legend>
          <div className="finance-tax-form-grid">
            {(
              [
                ['domesticResident', 'Domestic tax residency established'],
                ['hasCrossBorderActivity', 'Cross-border activity'],
                ...(type === 'corporation'
                  ? [['standaloneCorporation', 'Standalone corporation']]
                  : []),
              ] as string[][]
            ).map(([name, label]) => (
              <label key={name}>
                {label}
                <select name={name} defaultValue="unknown">
                  <option value="unknown">Not established</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>
            ))}
          </div>
        </fieldset>
        <details>
          <summary>Related people · optional</summary>
          <p>
            Record a spouse, dependant or another relevant person. This does not
            establish eligibility for a tax claim.
          </p>
          {parties.map((party) => (
            <div className="finance-tax-party" key={party.id}>
              <label>
                Related person name
                <input
                  value={party.displayName}
                  required
                  maxLength={200}
                  onChange={(event) =>
                    setParties((old) =>
                      old.map((item) =>
                        item.id === party.id
                          ? { ...item, displayName: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Relationship
                <select
                  value={party.relationship}
                  onChange={(event) =>
                    setParties((old) =>
                      old.map((item) =>
                        item.id === party.id
                          ? {
                              ...item,
                              relationship: event.target
                                .value as typeof item.relationship,
                            }
                          : item,
                      ),
                    )
                  }
                >
                  <option value="dependant">Dependant</option>
                  <option value="spouse">Spouse</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <Button
                type="button"
                variant="quiet"
                onClick={() =>
                  setParties((old) =>
                    old.filter((item) => item.id !== party.id),
                  )
                }
              >
                Remove related person
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            disabled={busy || parties.length >= 1000}
            onClick={() =>
              setParties((old) => [
                ...old,
                {
                  id: crypto.randomUUID(),
                  displayName: '',
                  relationship: 'other',
                },
              ])
            }
          >
            Add related person
          </Button>
        </details>
        <p className="finance-tax-note">
          A new case is private to you. Books and other people receive no
          automatic access.
        </p>
        <Button disabled={busy}>Review case setup</Button>
      </form>
      {review && (
        <div className="finance-tax-review" aria-label="Review new tax case">
          <h4>{review.title}</h4>
          {review.legalEntityId && (
            <p>
              Corporate entity:{' '}
              {
                books.find(
                  (book) => book.legalEntityId === review.legalEntityId,
                )?.entityName
              }
            </p>
          )}
          <dl className="finance-tax-facts">
            <div>
              <dt>Tax subject</dt>
              <dd>{review.taxSubjectName}</dd>
            </div>
            <div>
              <dt>Return scope</dt>
              <dd>
                {taxCountryName(review.scope.country)} ·{' '}
                {review.scope.subdivision} · {review.scope.year}
              </dd>
            </div>
            <div>
              <dt>Taxpayer</dt>
              <dd>{review.scope.taxpayerType.replaceAll('-', ' ')}</dd>
            </div>
            <div>
              <dt>Form reference</dt>
              <dd>{review.scope.formVersion}</dd>
            </div>
            <div>
              <dt>Domestic residency</dt>
              <dd>{taxTriState(review.domesticResident)}</dd>
            </div>
            <div>
              <dt>Cross-border activity</dt>
              <dd>{taxTriState(review.hasCrossBorderActivity)}</dd>
            </div>
            <div>
              <dt>Related people</dt>
              <dd>{review.relatedParties.length}</dd>
            </div>
            <div>
              <dt>Book sources</dt>
              <dd>None authorized</dd>
            </div>
          </dl>
          <p className="finance-tax-note">
            This case will save inputs only. It does not prepare a completed
            return or calculate tax.
          </p>
          <div className="finance-tax-actions">
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? 'Creating case…' : 'Create case · save inputs only'}
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => setReview(undefined)}
            >
              Edit case setup
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
