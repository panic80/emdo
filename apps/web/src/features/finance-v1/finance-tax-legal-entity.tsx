import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { Button } from '../../components/button.js';
import {
  readTaxJson,
  TaxBooksSchema,
  TaxMutationSchema,
  TaxRequestError,
} from './finance-tax-model.js';
import type { TaxCaseOperation } from './finance-tax-workspace.js';

type Book = z.infer<typeof TaxBooksSchema>['books'][number];
export function TaxLegalEntityAttachment({
  revision,
  disabled,
  operate,
  onAccessUnavailable,
}: {
  revision: number;
  disabled: boolean;
  operate: TaxCaseOperation;
  onAccessUnavailable: () => void;
}) {
  const [books, setBooks] = useState<Book[]>([]);
  const [selected, setSelected] = useState('');
  const [review, setReview] = useState<Book>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [uncertain, setUncertain] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const control = new AbortController();
    void readTaxJson('/api/v2/finance/books', control.signal)
      .then((raw) => {
        const result = TaxBooksSchema.parse(raw);
        if (!control.signal.aborted)
          setBooks(result.books.filter((book) => !!book.legalEntityId));
      })
      .catch((failure: unknown) => {
        if (control.signal.aborted) return;
        setBooks([]);
        setSelected('');
        setReview(undefined);
        setError(
          'Accessible corporate entities could not be loaded. Refresh the case to retry.',
        );
        if (
          failure instanceof TaxRequestError &&
          [401, 403, 503].includes(failure.status)
        )
          onAccessUnavailable();
      })
      .finally(() => {
        if (!control.signal.aborted) setLoading(false);
      });
    return () => control.abort();
  }, []);
  async function save() {
    if (!review?.legalEntityId || disabled || saving) return;
    setSaving(true);
    setError('');
    try {
      await operate(
        'legal-entity',
        { expectedCaseRevision: revision, legalEntityId: review.legalEntityId },
        TaxMutationSchema,
        'Corporate entity attached to this existing case. Review the new exact input versions before calculating. No book sources were authorized.',
      );
    } catch (failure) {
      setUncertain(true);
      setError(
        failure instanceof Error
          ? failure.message
          : 'Attachment was not confirmed. Retry the same reviewed choice or refresh this case.',
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section
      className="finance-tax-editor"
      aria-label="Attach corporate legal entity"
    >
      <h3>Attach the corporation to this case</h3>
      <p>
        This case has no legal entity attached. Keep the existing case and saved
        inputs by choosing its corporation explicitly.
      </p>
      <p>
        Attachment cannot be changed here afterward. It authorizes no book
        balances or other source facts. The new case revision requires fresh
        input review.
      </p>
      {loading && <p role="status">Loading accessible entities…</p>}
      {error && <p role="alert">{error}</p>}
      {review ? (
        <>
          <h4>Review entity attachment</h4>
          <p>
            {review.entityName} · {review.name}
          </p>
          <p>
            Attach this entity to saved case revision {revision}. Existing
            declarations and permissions remain in place.
          </p>
          <Button disabled={disabled || saving} onClick={() => void save()}>
            {uncertain
              ? 'Retry exact entity attachment'
              : 'Attach reviewed entity'}
          </Button>
          <Button
            variant="quiet"
            disabled={disabled || saving || uncertain}
            onClick={() => setReview(undefined)}
          >
            Change entity choice
          </Button>
          {uncertain && (
            <p>
              The result is unconfirmed. Retry uses the same entity and case
              revision; refresh the case before choosing anything else.
            </p>
          )}
        </>
      ) : (
        <>
          <label>
            Corporate legal entity
            <select
              value={selected}
              disabled={disabled || loading}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">Choose the corporation</option>
              {books.map((book) => (
                <option key={book.id} value={book.id}>
                  {book.entityName} · {book.name}
                </option>
              ))}
            </select>
          </label>
          {!loading && !books.length && !error && (
            <p>
              No accessible books identify a legal entity. Ask an administrator
              to provide access to the corporation’s book.
            </p>
          )}
          <Button
            disabled={disabled || loading || !selected}
            onClick={() =>
              setReview(books.find((book) => book.id === selected))
            }
          >
            Review entity attachment
          </Button>
        </>
      )}
    </section>
  );
}
