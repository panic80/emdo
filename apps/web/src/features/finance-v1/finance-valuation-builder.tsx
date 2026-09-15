import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  PreviewInvestmentValuationSchema,
  UuidSchema,
  FinanceDecimalSchema,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
const Record = z.object({ id: UuidSchema }).catchall(z.unknown());
const Catalog = z.object({
  instruments: z.array(Record),
  prices: z.array(Record),
  fx: z.array(Record),
  openings: z.array(Record),
  observedPositions: z.array(Record),
});
const Preview = z.object({
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['complete', 'incomplete']),
  currency: z.string(),
  total: FinanceDecimalSchema.nullable(),
  availableSubtotal: FinanceDecimalSchema,
  unavailableCount: z.number(),
  positions: z.array(z.unknown()),
});
type Input = z.infer<typeof PreviewInvestmentValuationSchema>;
export function FinanceValuationBuilder({
  bookId,
  onSaved,
}: {
  bookId: string;
  onSaved: (id: string) => void;
}) {
  const auth = useAuth(),
    alive = useRef(true),
    working = useRef(false),
    pending = useRef<{ body: string; key: string } | undefined>(undefined);
  const [catalog, setCatalog] = useState<z.infer<typeof Catalog>>(),
    [accounts, setAccounts] = useState<z.infer<typeof Record>[]>([]),
    [count, setCount] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [preview, setPreview] = useState<{
      input: Input;
      result: z.infer<typeof Preview>;
    }>();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const base = `/api/v2/finance/books/${bookId}`;
  async function request(path: string, input?: unknown) {
    if (!alive.current) throw new Error('The active book changed.');
    const body = input === undefined ? undefined : JSON.stringify(input);
    if (body && !auth.csrfToken)
      throw new Error('Sign in again before saving.');
    if (body && pending.current?.body !== body)
      pending.current = { body, key: crypto.randomUUID() };
    const response = await fetch(base + path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body
        ? {
            method: 'POST',
            body,
            headers: {
              'content-type': 'application/json',
              'x-csrf-token': auth.csrfToken!,
              'idempotency-key': pending.current!.key,
            },
          }
        : {}),
    });
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? 'The selection is no longer valid or its inputs changed. Preview again before saving.'
          : response.status === 403
            ? 'Current book access does not permit this action.'
            : 'Unable to load or calculate this selection. Check the source records and dates.',
      );
    const result: unknown = await response.json();
    if (body) pending.current = undefined;
    return result;
  }
  async function action(work: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Unable to finish.');
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function calculate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPreview(undefined);
    void action(async () => {
      const value = (key: string) => String(form.get(key) ?? '');
      const input = PreviewInvestmentValuationSchema.parse({
        asOf: value('asOf'),
        positions: Array.from({ length: count }, (_, i) => ({
          financialAccountId: value(`account${i}`),
          instrumentId: value(`instrument${i}`),
          openingId: value(`opening${i}`) || null,
          priceId: value(`price${i}`) || null,
          fxId: value(`fx${i}`) || null,
          observedPositionId: value(`observed${i}`) || null,
        })),
      });
      const result = Preview.parse(
        await request('/investments/valuation-preview', input),
      );
      if (alive.current) setPreview({ input, result });
    });
  }
  const options = (records: z.infer<typeof Record>[]) =>
    records.map((record) => (
      <option key={record.id} value={record.id}>
        {[
          record.name,
          record.asOf,
          record.currency,
          record.fromCurrency,
          record.toCurrency,
          record.quantity,
          record.price,
          record.rate,
          record.sourceReference,
          record.id,
        ]
          .filter((v) => typeof v === 'string')
          .join(' · ')}
      </option>
    ));
  return (
    <div>
      <Button
        variant="quiet"
        disabled={busy}
        onClick={() =>
          void action(async () => {
            const [c, a] = await Promise.all([
              request('/investments'),
              request('/financial-accounts'),
            ]);
            const parsed = Catalog.parse(c),
              financial = z.object({ accounts: z.array(Record) }).parse(a);
            if (alive.current) {
              setCatalog(parsed);
              setAccounts(
                financial.accounts.filter(
                  (a) => a.kind === 'brokerage' && a.active === true,
                ),
              );
              setPreview(undefined);
            }
          })
        }
      >
        {catalog ? 'Refresh valuation sources' : 'Create a valuation'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {catalog && (
        <form onSubmit={calculate} onChange={() => setPreview(undefined)}>
          <h4>Select valuation inputs</h4>
          <p>
            Choose recorded source observations explicitly. Missing inputs
            remain unavailable. Price and FX observations must match the
            valuation date.
          </p>
          <fieldset disabled={busy}>
            <label>
              Valuation date
              <input name="asOf" type="date" required />
            </label>
            {Array.from({ length: count }, (_, i) => (
              <fieldset key={i}>
                <legend>Position {i + 1}</legend>
                <label>
                  Brokerage account
                  <select name={`account${i}`} required defaultValue="">
                    <option value="" disabled>
                      Select account
                    </option>
                    {options(accounts)}
                  </select>
                </label>
                <label>
                  Instrument
                  <select name={`instrument${i}`} required defaultValue="">
                    <option value="" disabled>
                      Select instrument
                    </option>
                    {options(catalog.instruments)}
                  </select>
                </label>
                <label>
                  Opening position
                  <select name={`opening${i}`} defaultValue="">
                    <option value="">Unavailable</option>
                    {options(catalog.openings)}
                  </select>
                </label>
                <label>
                  Price observation
                  <select name={`price${i}`} defaultValue="">
                    <option value="">Unavailable</option>
                    {options(catalog.prices)}
                  </select>
                </label>
                <label>
                  FX observation
                  <select name={`fx${i}`} defaultValue="">
                    <option value="">None selected</option>
                    {options(catalog.fx)}
                  </select>
                </label>
                <label>
                  Statement observation
                  <select name={`observed${i}`} defaultValue="">
                    <option value="">No comparison</option>
                    {options(catalog.observedPositions)}
                  </select>
                </label>
              </fieldset>
            ))}
            <Button
              type="button"
              variant="quiet"
              disabled={count >= 500}
              onClick={() => {
                setCount((c) => c + 1);
                setPreview(undefined);
              }}
            >
              Add position
            </Button>
            {count > 1 && (
              <Button
                type="button"
                variant="quiet"
                onClick={() => {
                  setCount((c) => c - 1);
                  setPreview(undefined);
                }}
              >
                Remove last position
              </Button>
            )}
            <Button>Preview valuation</Button>
          </fieldset>
        </form>
      )}
      {preview && (
        <div>
          <h4>Valuation preview · {preview.result.status}</h4>
          <p>
            Selected-position total:{' '}
            {preview.result.total === null
              ? 'Unavailable'
              : `${preview.result.total} ${preview.result.currency}`}
          </p>
          {preview.result.status === 'incomplete' && (
            <p>
              Available subtotal: {preview.result.availableSubtotal}{' '}
              {preview.result.currency}. Unavailable positions:{' '}
              {preview.result.unavailableCount}.
            </p>
          )}
          <details>
            <summary>Preview position details</summary>
            <pre className="finance-provenance">
              {JSON.stringify(preview.result.positions, null, 2)}
            </pre>
          </details>
          <Button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const saved = z.object({ id: UuidSchema }).parse(
                  await request('/investments/valuation-runs', {
                    ...preview.input,
                    expectedInputHash: preview.result.inputHash,
                  }),
                );
                if (alive.current) {
                  setPreview(undefined);
                  onSaved(saved.id);
                }
              })
            }
          >
            Save reviewed valuation
          </Button>
        </div>
      )}
    </div>
  );
}
