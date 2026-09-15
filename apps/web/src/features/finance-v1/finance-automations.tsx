import { FinanceJournalDrafts } from './finance-journal-drafts.js';
import { FinanceExtractionAutomation } from './finance-extraction-automation.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  FinanceAutomationGrantSchema,
  FinanceAutomationLimitsSchema,
  type FinanceAutomationGrant,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import { useAuth } from '../auth/auth-context.js';
import './finance-automations.css';
import { FinanceSchedules } from './finance-schedules.js';
import { FinancePlanningAutomation } from './finance-planning-automation.js';

const Grants = z.object({ grants: z.array(FinanceAutomationGrantSchema) });
const capabilities = {
  'finance.documents.extract': 'Extract document information',
  'finance.reports.generate': 'Generate financial reports',
  'finance.journals.draft': 'Prepare draft journals',
  'finance.planning.budget-vs-actuals': 'Compare budgets with actuals',
  'finance.planning.forecast': 'Generate reviewed forecasts',
} as const;

class GrantRequestError extends Error {
  constructor(
    readonly status: number,
    operation: 'read' | 'revoke' | 'create',
  ) {
    super(
      status === 403
        ? operation === 'create'
          ? 'Grant creation is not authorized. Check administrator access, entitlement and operation availability.'
          : 'Administrator access to this book is required to manage automation grants.'
        : status === 503
          ? 'Automation grant management is not available in this environment yet.'
          : operation === 'read'
            ? 'Unable to load automation grants. Refresh to try again.'
            : 'Revocation could not be confirmed. Retry to confirm the same request.',
    );
  }
}

/** A fresh component boundary discards grants and retry keys when access changes. */
export function FinanceAutomations({
  bookId,
  bookName,
  role,
}: {
  bookId: string;
  bookName: string;
  role: string;
}) {
  const auth = useAuth();
  return (
    <FinanceAutomationGrants
      key={`${auth.sessionBinding}:${bookId}:${role}`}
      bookId={bookId}
      bookName={bookName}
      role={role}
      {...(auth.csrfToken ? { csrfToken: auth.csrfToken } : {})}
    />
  );
}

function FinanceAutomationGrants({
  bookId,
  bookName,
  role,
  csrfToken,
}: {
  bookId: string;
  bookName: string;
  role: string;
  csrfToken?: string;
}) {
  const [creationPending, setCreationPending] = useState(false);
  const [grants, setGrants] = useState<FinanceAutomationGrant[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmId, setConfirmId] = useState<string>();
  const mounted = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const pendingKeys = useRef(new Map<string, string>());
  const working = useRef(false);
  const confirmation = useRef<HTMLButtonElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const previousConfirmId = useRef<string | undefined>(undefined);
  const base = `/api/v2/finance/books/${bookId}/automations/grants`;
  const isAdministrator = role === 'administrator';

  const load = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError('');
    setNotice('');
    setGrants(undefined);
    setConfirmId(undefined);
    try {
      const response = await fetch(base, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: current.signal,
      });
      if (!response.ok) throw new GrantRequestError(response.status, 'read');
      const result = Grants.parse(await response.json());
      if (result.grants.some((grant) => grant.bookId !== bookId))
        throw new Error('Unexpected book scope');
      if (mounted.current && !current.signal.aborted) setGrants(result.grants);
    } catch (cause) {
      if (mounted.current && !current.signal.aborted)
        setError(
          cause instanceof GrantRequestError
            ? cause.message
            : 'Unable to load automation grants. Refresh to try again.',
        );
    } finally {
      if (mounted.current && !current.signal.aborted) setBusy(false);
    }
  }, [base, bookId]);

  useEffect(() => {
    mounted.current = true;
    if (isAdministrator) void load();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [isAdministrator, load]);

  useEffect(() => {
    if (confirmId) confirmation.current?.focus();
    else if (previousConfirmId.current) {
      const trigger = document.getElementById(
        `revoke-grant-${previousConfirmId.current}`,
      );
      if (trigger) trigger.focus();
      else if (notice) feedback.current?.focus();
    }
    previousConfirmId.current = confirmId;
  }, [confirmId, notice]);

  async function revoke(grant: FinanceAutomationGrant) {
    if (working.current || busy || !csrfToken || !isAdministrator) return;
    working.current = true;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const key = pendingKeys.current.get(grant.id) ?? crypto.randomUUID();
    pendingKeys.current.set(grant.id, key);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${base}/${grant.id}/revoke`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: current.signal,
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
          'idempotency-key': key,
        },
        body: '{}',
      });
      if (!response.ok) throw new GrantRequestError(response.status, 'revoke');
      const result = FinanceAutomationGrantSchema.parse(await response.json());
      if (
        result.id !== grant.id ||
        result.bookId !== bookId ||
        result.workspaceId !== grant.workspaceId ||
        result.status !== 'revoked' ||
        result.revision < grant.revision
      )
        throw new Error('Unexpected revocation result');
      if (!mounted.current || current.signal.aborted) return;
      pendingKeys.current.delete(grant.id);
      setGrants((previous) =>
        previous?.map((value) => (value.id === result.id ? result : value)),
      );
      setConfirmId(undefined);
      setNotice(
        'Grant revoked. Its authority is no longer available for new execution.',
      );
    } catch (cause) {
      if (!mounted.current || current.signal.aborted) return;
      if (
        cause instanceof GrantRequestError &&
        (cause.status === 403 || cause.status === 503)
      ) {
        setGrants(undefined);
        setConfirmId(undefined);
      }
      setError(
        cause instanceof GrantRequestError
          ? cause.message
          : 'Revocation could not be confirmed. Retry to confirm the same request.',
      );
    } finally {
      working.current = false;
      if (mounted.current && !current.signal.aborted) setBusy(false);
    }
  }

  return (
    <section className="finance-automations" aria-label="Automation grants">
      <div className="finance-automations__heading">
        <div>
          <span className="finance-automations__eyebrow">
            Access &amp; limits
          </span>
          <h2>Automation grants</h2>
          <p>Review the authority recorded for {bookName}.</p>
        </div>
        {isAdministrator && (
          <Button
            variant="secondary"
            disabled={busy || creationPending}
            onClick={() => void load()}
          >
            <Icon name="sync" size={16} />
            Refresh grants
          </Button>
        )}
      </div>
      <div className="finance-automations__availability">
        <Icon name="info" size={20} />
        <div>
          <h3>Scoped authority for Finance workflows</h3>
          <p>
            Grants authorize selected operations within explicit limits. Access,
            expiry, available capabilities and worker readiness are checked when
            a workflow runs. Creating a grant does not start a workflow.
          </p>
        </div>
        <span className="finance-status finance-status--pending">
          Checked at execution
        </span>
      </div>
      {!isAdministrator ? (
        <p className="finance-automations__empty">
          Administrator access to this book is required to manage automation
          grants.
        </p>
      ) : (
        <>
          {error && (
            <p className="finance-automations__feedback" role="alert">
              {error}
            </p>
          )}
          <p
            ref={feedback}
            className="finance-automations__feedback"
            role="status"
            tabIndex={-1}
          >
            {notice || (busy ? 'Loading grant information…' : '')}
          </p>
          {grants && (
            <CreateAutomationGrant
              bookId={bookId}
              bookName={bookName}
              csrfToken={csrfToken}
              disabled={busy}
              onCreated={(updated) => setGrants(updated)}
              onAccessLost={() => setGrants(undefined)}
              onPending={setCreationPending}
            />
          )}
          {grants?.length === 0 && (
            <div className="finance-automations__empty">
              <span className="finance-empty__icon">
                <Icon name="clock" size={24} />
              </span>
              <h3>No automation grants for this book</h3>
              <p>
                There is no stored automation authority to review or revoke.
              </p>
            </div>
          )}
          {grants && grants.length > 0 && (
            <div className="finance-grants">
              <p className="finance-grants__count">
                {grants.length} {grants.length === 1 ? 'grant' : 'grants'} ·{' '}
                {bookName}
              </p>
              {grants.map((grant) => (
                <article
                  className="finance-grant"
                  key={grant.id}
                  aria-label={`Grant ${grant.id}`}
                >
                  <div className="finance-grant__heading">
                    <div>
                      <h3>Finance automation authority</h3>
                      <span className="finance-grant__reference">
                        {grant.id}
                      </span>
                    </div>
                    <span
                      className={`finance-status ${grant.status === 'revoked' ? 'finance-status--pending' : ''}`}
                    >
                      {grant.status === 'revoked' ? 'Revoked' : 'Active grant'}
                    </span>
                  </div>
                  <div className="finance-grant__body">
                    <div className="finance-grant__scope">
                      <h4>Granted operations</h4>
                      <ul>
                        {grant.allowedCapabilities.map((capability) => (
                          <li key={capability}>
                            <span className="finance-grant__operation-dot" />
                            {capabilities[capability]}
                          </li>
                        ))}
                      </ul>
                      <p>Only these operations and limits are authorized.</p>
                    </div>
                    <div className="finance-grant__limits">
                      <h4>Grant limits</h4>
                      <dl>
                        <div>
                          <dt>Total runs</dt>
                          <dd>{grant.limits.maxRuns}</dd>
                        </div>
                        <div>
                          <dt>Attempts per run</dt>
                          <dd>{grant.limits.maxAttemptsPerRun}</dd>
                        </div>
                        <div>
                          <dt>Items per run</dt>
                          <dd>{grant.limits.maxItemsPerRun}</dd>
                        </div>
                        <div>
                          <dt>Total items</dt>
                          <dd>{grant.limits.maxTotalItems}</dd>
                        </div>
                        <div>
                          <dt>Amount per run</dt>
                          <dd>
                            {grant.limits.maxAmountPerRun}{' '}
                            {grant.limits.currency}
                          </dd>
                        </div>
                        <div>
                          <dt>Total amount</dt>
                          <dd>
                            {grant.limits.maxTotalAmount}{' '}
                            {grant.limits.currency}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </div>
                  <dl className="finance-grant__validity">
                    <div>
                      <dt>Valid from</dt>
                      <dd>
                        <time dateTime={grant.validFrom}>
                          {grant.validFrom}
                        </time>
                      </dd>
                    </div>
                    <div>
                      <dt>Expires</dt>
                      <dd>
                        <time dateTime={grant.expiresAt}>
                          {grant.expiresAt}
                        </time>
                      </dd>
                    </div>
                  </dl>
                  <div className="finance-grant__footer">
                    <details>
                      <summary>Authority details</summary>
                      <dl className="finance-grant__details">
                        <div>
                          <dt>Book</dt>
                          <dd>
                            {bookName} · {grant.bookId}
                          </dd>
                        </div>
                        <div>
                          <dt>Workspace</dt>
                          <dd>{grant.workspaceId}</dd>
                        </div>
                        <div>
                          <dt>Granted by</dt>
                          <dd>{grant.grantedByUserId}</dd>
                        </div>
                        <div>
                          <dt>Executor</dt>
                          <dd>{grant.executor}</dd>
                        </div>
                        <div>
                          <dt>Specialist</dt>
                          <dd>{grant.specialist}</dd>
                        </div>
                        <div>
                          <dt>Grant revision</dt>
                          <dd>{grant.revision}</dd>
                        </div>
                        <div>
                          <dt>Membership revision</dt>
                          <dd>{grant.authorityRevision.membership}</dd>
                        </div>
                        <div>
                          <dt>Book access revision</dt>
                          <dd>{grant.authorityRevision.bookAccess}</dd>
                        </div>
                        <div>
                          <dt>Entitlement revision</dt>
                          <dd>{grant.authorityRevision.entitlement}</dd>
                        </div>
                        <div>
                          <dt>Capability identifiers</dt>
                          <dd>{grant.allowedCapabilities.join(', ')}</dd>
                        </div>
                      </dl>
                    </details>
                    {grant.status === 'active' && confirmId !== grant.id && (
                      <Button
                        id={`revoke-grant-${grant.id}`}
                        variant="quiet"
                        className="finance-grant__revoke"
                        disabled={busy || creationPending || !csrfToken}
                        onClick={() => setConfirmId(grant.id)}
                      >
                        Revoke grant
                      </Button>
                    )}
                  </div>
                  {confirmId === grant.id && (
                    <div
                      className="finance-grant__confirmation"
                      role="group"
                      aria-label="Confirm grant revocation"
                    >
                      <div>
                        <h4>Revoke this grant?</h4>
                        <p>
                          Its authority will end. Revoked grants cannot be
                          reactivated here.
                        </p>
                      </div>
                      <div>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => setConfirmId(undefined)}
                        >
                          Cancel
                        </Button>
                        <button
                          ref={confirmation}
                          className="button button--danger"
                          disabled={busy || creationPending || !csrfToken}
                          onClick={() => void revoke(grant)}
                        >
                          {busy ? 'Revoking…' : 'Confirm revocation'}
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {isAdministrator && (
        <FinanceSchedules
          bookId={bookId}
          grants={grants}
          {...(csrfToken ? { csrfToken } : {})}
        />
      )}
      <FinanceJournalDrafts
        bookId={bookId}
        bookName={bookName}
        role={role}
        grants={grants}
        {...(csrfToken ? { csrfToken } : {})}
      />
      {isAdministrator && (
        <FinanceExtractionAutomation
          bookId={bookId}
          bookName={bookName}
          grants={grants}
          {...(csrfToken ? { csrfToken } : {})}
        />
      )}
      {isAdministrator && (
        <FinancePlanningAutomation
          bookId={bookId}
          bookName={bookName}
          grants={grants}
          {...(csrfToken ? { csrfToken } : {})}
        />
      )}
    </section>
  );
}

const GrantInput = z
  .object({
    capabilities: FinanceAutomationGrantSchema.shape.allowedCapabilities,
    limits: FinanceAutomationLimitsSchema,
    validFrom: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .refine(
    (value) => Date.parse(value.expiresAt) > Date.parse(value.validFrom),
    'Expiry must be after the start time.',
  );
type GrantInput = z.infer<typeof GrantInput>;
const limitFields = [
  ['maxRuns', 'Total runs', '10'],
  ['maxAttemptsPerRun', 'Attempts per run', '3'],
  ['maxItemsPerRun', 'Items per run', '100'],
  ['maxTotalItems', 'Total items', '1000'],
  ['maxAmountPerRun', 'Amount per run', '0'],
  ['maxTotalAmount', 'Total amount', '0'],
] as const;

function CreateAutomationGrant({
  bookId,
  bookName,
  csrfToken,
  disabled,
  onCreated,
  onAccessLost,
  onPending,
}: {
  bookId: string;
  bookName: string;
  csrfToken: string | undefined;
  disabled: boolean;
  onCreated: (grants: FinanceAutomationGrant[]) => void;
  onAccessLost: () => void;
  onPending: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<GrantInput>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<{ key: string; input: GrantInput } | undefined>(
    undefined,
  );
  const controller = useRef<AbortController | undefined>(undefined);
  const working = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);

  async function create() {
    if (!review || !csrfToken || working.current || disabled) return;
    working.current = true;
    const attempt = pending.current ?? {
      key: crypto.randomUUID(),
      input: review,
    };
    pending.current = attempt;
    onPending(true);
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError('');
    const base = `/api/v2/finance/books/${bookId}/automations/grants`;
    let accepted = false;
    try {
      const response = await fetch(base, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: current.signal,
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
          'idempotency-key': attempt.key,
        },
        body: JSON.stringify(attempt.input),
      });
      if (!response.ok) throw new GrantRequestError(response.status, 'create');
      accepted = true;
      const result = FinanceAutomationGrantSchema.parse(await response.json());
      if (
        result.bookId !== bookId ||
        result.status !== 'active' ||
        JSON.stringify([...result.allowedCapabilities].sort()) !==
          JSON.stringify([...attempt.input.capabilities].sort()) ||
        result.validFrom !== attempt.input.validFrom ||
        result.expiresAt !== attempt.input.expiresAt ||
        Object.entries(attempt.input.limits).some(
          ([key, value]) =>
            String(result.limits[key as keyof typeof result.limits]) !==
            String(value),
        )
      )
        throw new Error('Unexpected grant response');
      const read = await fetch(base, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: current.signal,
      });
      if (!read.ok) throw new GrantRequestError(read.status, 'read');
      const updated = Grants.parse(await read.json()).grants;
      if (
        updated.some((grant) => grant.bookId !== bookId) ||
        !updated.some(
          (grant) =>
            grant.id === result.id &&
            grant.workspaceId === result.workspaceId &&
            grant.revision >= result.revision,
        )
      )
        throw new Error('Grant readback did not confirm creation');
      if (current.signal.aborted) return;
      onCreated(updated);
      pending.current = undefined;
      onPending(false);
      setReview(undefined);
      setOpen(false);
      setNotice(
        'Grant created and confirmed. Choose a workflow below to use its authority.',
      );
    } catch (cause) {
      if (current.signal.aborted) return;
      if (cause instanceof GrantRequestError && cause.status === 401)
        onAccessLost();
      if (
        !accepted &&
        cause instanceof GrantRequestError &&
        [400, 403, 409, 422, 503].includes(cause.status)
      ) {
        pending.current = undefined;
        onPending(false);
      }
      setError(
        cause instanceof GrantRequestError && [403, 503].includes(cause.status)
          ? cause.message
          : 'Creation could not be confirmed. Retry confirmation with the same request to avoid a duplicate grant.',
      );
    } finally {
      working.current = false;
      if (!current.signal.aborted) setBusy(false);
    }
  }

  return (
    <div className="finance-grant-create">
      {notice && <p role="status">{notice}</p>}
      {!open ? (
        <Button
          disabled={disabled || !csrfToken}
          onClick={() => {
            setOpen(true);
            setNotice('');
          }}
        >
          Create automation grant
        </Button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            try {
              const input = GrantInput.parse({
                capabilities: data.getAll('capability'),
                limits: Object.fromEntries([
                  ...limitFields.map(([key]) => [
                    key,
                    key.startsWith('maxAmount') || key === 'maxTotalAmount'
                      ? data.get(key)
                      : Number(data.get(key)),
                  ]),
                  ['currency', data.get('currency')],
                ]),
                validFrom: new Date(
                  String(data.get('validFrom')),
                ).toISOString(),
                expiresAt: new Date(
                  String(data.get('expiresAt')),
                ).toISOString(),
              });
              if (Date.parse(input.expiresAt) <= Date.now())
                throw new Error('Choose a future expiry.');
              setReview(input);
              setError('');
            } catch {
              setError(
                'Choose at least one operation, valid limits and a future expiry after the start time. Amounts must match the currency precision.',
              );
            }
          }}
        >
          <h3>Create automation grant</h3>
          <p>
            Authority applies only to {bookName}. This does not authorize
            posting journals or moving money. The server checks entitlement and
            operation availability before creating the grant.
          </p>
          <fieldset disabled={!!review || busy || disabled}>
            <legend>Allowed operations</legend>
            {Object.entries(capabilities).map(([value, label]) => (
              <label className="finance-grant-create__check" key={value}>
                <input type="checkbox" name="capability" value={value} />
                {label}
              </label>
            ))}
            <div className="finance-grant-create__fields">
              {limitFields.map(([key, label, value]) => (
                <label key={key}>
                  {label}
                  <input
                    name={key}
                    required
                    defaultValue={value}
                    type={key.includes('Amount') ? 'text' : 'number'}
                    min="1"
                    step="1"
                    inputMode={key.includes('Amount') ? 'decimal' : 'numeric'}
                  />
                </label>
              ))}
              <label>
                Currency
                <input
                  name="currency"
                  defaultValue="CAD"
                  required
                  pattern="[A-Z]{3}"
                  maxLength={3}
                />
              </label>
              <label>
                Valid from (local time)
                <input
                  name="validFrom"
                  type="datetime-local"
                  required
                  defaultValue={localDateTime(new Date())}
                />
              </label>
              <label>
                Expires (local time)
                <input
                  name="expiresAt"
                  type="datetime-local"
                  required
                  defaultValue={localDateTime(
                    new Date(Date.now() + 30 * 86400000),
                  )}
                />
              </label>
            </div>
          </fieldset>
          {error && <p role="alert">{error}</p>}
          {review ? (
            <div
              className="finance-grant-create__review"
              aria-label="Review grant authority"
            >
              <h4>Review authority for {bookName}</h4>
              <p>
                {review.capabilities
                  .map((value) => capabilities[value])
                  .join('; ')}
              </p>
              <p>
                {limitFields
                  .map(([key, label]) => `${label}: ${review.limits[key]}`)
                  .join(' · ')}{' '}
                · {review.limits.currency}
              </p>
              <p>
                Valid from {review.validFrom} until {review.expiresAt}.
              </p>
              <Button
                type="button"
                disabled={busy || disabled || !csrfToken}
                onClick={() => void create()}
              >
                {busy
                  ? 'Creating…'
                  : pending.current
                    ? 'Retry confirmation'
                    : 'Confirm grant creation'}
              </Button>
              {!pending.current && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setReview(undefined)}
                >
                  Edit authority
                </Button>
              )}
            </div>
          ) : (
            <Button type="submit" disabled={disabled || !csrfToken}>
              Review grant
            </Button>
          )}
          {!pending.current && (
            <Button
              type="button"
              variant="quiet"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setReview(undefined);
                setError('');
              }}
            >
              Cancel creation
            </Button>
          )}
        </form>
      )}
    </div>
  );
}
function localDateTime(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
