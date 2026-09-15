import { TaxLegalEntityAttachment } from './finance-tax-legal-entity.js';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  CreatePrivateTaxCaseSchema,
  ResetPrivateTaxInputsSchema,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import { useAuth } from '../auth/auth-context.js';
import { FinanceTaxCreate } from './finance-tax-create.js';
import { FinanceTaxInputs } from './finance-tax-inputs.js';
import { FinanceTaxAccess } from './finance-tax-access.js';
import { FinanceTaxWorkingPapers } from './finance-tax-working-papers.js';
import {
  TaxCaseListSchema,
  TaxGrantsSchema,
  TaxMutationSchema,
  TaxRequestError,
  readTaxJson,
  taxMutationRequest,
  taxCountryName,
  taxRoleDescriptions,
  taxTriState,
  verifyTaxCase,
  taxCountries,
  type TaxCaseSummary,
} from './finance-tax-model.js';
import './finance-tax-workspace.css';

const base = '/api/v2/finance/tax/cases';
type ExplainCase = (caseId: string) => Promise<boolean>;
export function FinanceTaxWorkspace({
  onExplainCase,
}: {
  onExplainCase?: ExplainCase;
}) {
  const auth = useAuth();
  if (auth.state && auth.state !== 'authenticated')
    return (
      <section className="finance-surface">
        <h2>Private tax cases</h2>
        <p>Connect and sign in to open private tax inputs.</p>
      </section>
    );
  return (
    <TaxWorkspace
      key={`${auth.sessionBinding}:${auth.state}`}
      {...(auth.csrfToken ? { csrfToken: auth.csrfToken } : {})}
      {...(onExplainCase ? { onExplainCase } : {})}
    />
  );
}
function TaxWorkspace({
  csrfToken,
  onExplainCase,
}: {
  csrfToken?: string;
  onExplainCase?: ExplainCase;
}) {
  const [cases, setCases] = useState<TaxCaseSummary[]>(),
    [offset, setOffset] = useState(0),
    [next, setNext] = useState(false);
  const [selected, setSelected] = useState<TaxCaseSummary>(),
    [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const controller = useRef<AbortController | undefined>(undefined),
    alive = useRef(true),
    working = useRef(false);
  const post = useRef(taxMutationRequest()).current;
  async function load(nextOffset = offset) {
    controller.current?.abort();
    const control = new AbortController();
    controller.current = control;
    setBusy(true);
    setError('');
    try {
      const result = TaxCaseListSchema.parse(
        await readTaxJson(
          `${base}?offset=${nextOffset}&limit=26`,
          control.signal,
        ),
      );
      if (!alive.current || control.signal.aborted) return [];
      setCases(result.cases.slice(0, 25));
      setNext(result.cases.length > 25);
      setOffset(nextOffset);
      return result.cases;
    } catch (failure) {
      if (alive.current && !control.signal.aborted) {
        setCases(undefined);
        setError(
          failure instanceof Error
            ? failure.message
            : 'Unable to load private tax cases.',
        );
      }
      return [];
    } finally {
      if (alive.current && !control.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load(0);
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  async function create(input: z.infer<typeof CreatePrivateTaxCaseSchema>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    const control = new AbortController();
    controller.current?.abort();
    controller.current = control;
    try {
      const result = await post(
        base,
        CreatePrivateTaxCaseSchema.parse(input),
        TaxMutationSchema,
        control.signal,
        csrfToken,
      );
      if (!alive.current || control.signal.aborted) return;
      const refreshed = await load(0);
      if (!alive.current) return;
      setCreating(false);
      setSelected(refreshed.find((item) => item.caseId === result.caseId));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (selected)
    return (
      <TaxCaseWorkspace
        key={selected.caseId}
        summary={selected}
        listOffset={offset}
        {...(csrfToken ? { csrfToken } : {})}
        {...(onExplainCase ? { onExplainCase } : {})}
        onBack={() => {
          setSelected(undefined);
          void load();
        }}
      />
    );
  return (
    <section
      className="finance-tax-workspace finance-surface"
      aria-label="Private tax cases"
    >
      <div className="finance-tax-heading">
        <div>
          <span className="finance-tax-eyebrow">
            <Icon name="lock" size={13} /> Private workspace
          </span>
          <h2>Tax cases</h2>
          <p>
            Keep tax inputs, source permissions and review findings together.
          </p>
        </div>
        <div className="finance-tax-actions">
          <Button
            variant="quiet"
            disabled={busy || creating}
            onClick={() => void load()}
          >
            Refresh tax cases
          </Button>
          <Button
            disabled={busy || creating || !cases || !csrfToken}
            onClick={() => setCreating(true)}
          >
            New tax case
          </Button>
        </div>
      </div>
      <div className="finance-tax-availability">
        <Icon name="info" size={19} />
        <div>
          <strong>Canada tax returns — work in progress (WIP).</strong>
          <p>
            Save and review private inputs now. No country has a validated
            full-return calculation package or filing support. Available
            working-paper workflows identify their supported scope and missing
            inputs for explicit review.
          </p>
          <details>
            <summary>Country availability</summary>
            <div className="finance-tax-countries">
              {taxCountries.map(([code, name]) => (
                <div key={code}>
                  <span>{name}</span>
                  <span>Full-return calculations unavailable</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>
      <p className="finance-tax-hint">
        Tax cases have their own permissions. The accounting book selected
        elsewhere is not automatically a source.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Loading private tax cases…</p>}
      {creating ? (
        <FinanceTaxCreate
          busy={busy}
          onSave={create}
          onCancel={() => setCreating(false)}
        />
      ) : (
        cases && (
          <>
            {!cases.length ? (
              <div className="finance-tax-empty">
                <Icon name="lock" size={26} />
                <h3>No private cases on this page</h3>
                <p>
                  Create a case to save inputs for a person or legal entity.
                  Access starts with you.
                </p>
              </div>
            ) : (
              <ul className="finance-tax-case-list">
                {cases.map((item) => (
                  <li key={item.caseId}>
                    <button
                      type="button"
                      onClick={() => setSelected(item)}
                      aria-label={`Open tax case ${item.title}`}
                    >
                      <span className="finance-tax-case-symbol">
                        <Icon name="wallet" size={20} />
                      </span>
                      <span>
                        <strong>{item.title}</strong>
                        <small>
                          {item.taxSubjectName} · saved revision {item.revision}
                        </small>
                      </span>
                      <span className="finance-tax-case-role">
                        {item.caseRole}
                      </span>
                      <Icon name="chevron-right" size={18} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="finance-tax-pagination">
              <Button
                variant="quiet"
                disabled={busy || !offset}
                onClick={() => void load(Math.max(0, offset - 25))}
              >
                Previous tax cases
              </Button>
              <span>Page {Math.floor(offset / 25) + 1}</span>
              <Button
                variant="quiet"
                disabled={busy || !next}
                onClick={() => void load(offset + 25)}
              >
                Next tax cases
              </Button>
            </div>
          </>
        )
      )}
    </section>
  );
}

export type TaxCaseOperation = <T>(
  path: string,
  payload: unknown,
  schema: z.ZodType<T>,
  notice: string,
) => Promise<T>;
function TaxCaseWorkspace({
  summary,
  listOffset,
  csrfToken,
  onBack,
  onExplainCase,
}: {
  summary: TaxCaseSummary;
  listOffset: number;
  csrfToken?: string;
  onBack: () => void;
  onExplainCase?: ExplainCase;
}) {
  const [resource, setResource] = useState<ReturnType<typeof verifyTaxCase>>();
  const [tab, setTab] = useState<'summary' | 'inputs' | 'working' | 'access'>(
    'summary',
  );
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [loadedVersion, setLoadedVersion] = useState(0);
  const [busy, setBusy] = useState(true),
    [saving, setSaving] = useState(false),
    [stale, setStale] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [blocked, setBlocked] = useState(false),
    [recovery, setRecovery] = useState<TaxCaseSummary>();
  const [confirmReset, setConfirmReset] = useState(false),
    [resetChecked, setResetChecked] = useState(false);
  const [asking, setAsking] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined),
    alive = useRef(true),
    working = useRef(false);
  const post = useRef(taxMutationRequest()).current;
  const caseBase = `${base}/${summary.caseId}`;
  async function load() {
    controller.current?.abort();
    const control = new AbortController();
    controller.current = control;
    setBusy(true);
    setResource(undefined);
    setError('');
    setStale(false);
    setBlocked(false);
    setRecovery(undefined);
    setConfirmReset(false);
    setResetChecked(false);
    try {
      const results = await Promise.all([
        readTaxJson(caseBase, control.signal),
        readTaxJson(`${caseBase}/declarations`, control.signal),
        readTaxJson(`${caseBase}/assessment`, control.signal),
      ]);
      const value = verifyTaxCase(
        results[0],
        results[1],
        results[2],
        summary.caseId,
      );
      if (alive.current && !control.signal.aborted) {
        setResource(value);
        setLoadedVersion((version) => version + 1);
      }
    } catch (failure) {
      if (!alive.current || control.signal.aborted) return;
      setError(
        failure instanceof z.ZodError
          ? 'This private tax response could not be verified.'
          : failure instanceof Error
            ? failure.message
            : 'Unable to load this case.',
      );
      if (
        failure instanceof TaxRequestError &&
        (failure.status === 403 ||
          failure.code === 'finance-tax-source-revoked')
      ) {
        setBlocked(true);
        // Recovery needs fresh, case-specific owner authority even when inputs are unreadable.
        try {
          const list = TaxCaseListSchema.parse(
            await readTaxJson(
              `${base}?offset=${listOffset}&limit=100`,
              control.signal,
            ),
          );
          const current = list.cases.find(
            (item) => item.caseId === summary.caseId,
          );
          if (current?.caseRole === 'owner') {
            TaxGrantsSchema.parse(
              await readTaxJson(`${caseBase}/grants`, control.signal),
            );
            if (alive.current && !control.signal.aborted) setRecovery(current);
          }
        } catch {
          /* No owner-only recovery controls without current authority. */
        }
      }
    } finally {
      if (alive.current && !control.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const operate: TaxCaseOperation = async (path, payload, schema, success) => {
    if (
      working.current ||
      stale ||
      !controller.current ||
      controller.current.signal.aborted
    )
      throw new Error('Refresh this case before continuing.');
    working.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    const control = controller.current;
    try {
      const result = await post(
        `${caseBase}/${path}`,
        payload,
        schema,
        control.signal,
        csrfToken,
      );
      if (!alive.current || control.signal.aborted) return result;
      const identity = z
        .object({ caseId: z.literal(summary.caseId) })
        .safeParse(result);
      if (!identity.success)
        throw new Error(
          'The tax mutation response belongs to a different case. Refresh to verify it.',
        );
      await load();
      if (alive.current) setNotice(success);
      return result;
    } catch (failure) {
      if (alive.current && !control.signal.aborted) {
        if (
          failure instanceof TaxRequestError &&
          ([401, 403, 503].includes(failure.status) ||
            failure.code === 'finance-tax-source-revoked')
        )
          await load();
        else {
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to save this change.',
          );
          if (failure instanceof TaxRequestError && failure.status === 409)
            setStale(true);
        }
      }
      throw failure;
    } finally {
      working.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const role = resource?.detail.caseRole ?? recovery?.caseRole;
  const locked = busy || saving || stale || !csrfToken;
  const questionnaire = resource?.detail.questionnaire;
  async function explain() {
    if (!onExplainCase || !resource || asking) return;
    setAsking(true);
    setError('');
    try {
      const accepted = await onExplainCase(summary.caseId);
      if (alive.current) {
        if (!accepted) setError('EMDO could not start this explanation.');
        else
          setNotice(
            'Explanation requested. Open the Finance conversation to review it.',
          );
      }
    } catch {
      if (alive.current) setError('EMDO could not start this explanation.');
    } finally {
      if (alive.current) setAsking(false);
    }
  }
  const visibleSummary = resource || !error ? summary : recovery;
  return (
    <section
      className="finance-tax-workspace finance-surface"
      aria-label="Private tax case"
    >
      <Button variant="quiet" disabled={saving} onClick={onBack}>
        All tax cases
      </Button>
      <div className="finance-tax-heading">
        <div>
          <span className="finance-tax-eyebrow">
            <Icon name="lock" size={13} /> Private case
          </span>
          <h2>{visibleSummary?.title ?? 'Private tax case'}</h2>
          <p>
            {visibleSummary?.taxSubjectName ??
              'Refresh to check current case access.'}
            {questionnaire?.intake.scope.year
              ? ` · ${questionnaire.intake.scope.year}`
              : ''}
          </p>
        </div>
        <div className="finance-tax-actions">
          {onExplainCase && (
            <Button
              variant="secondary"
              disabled={!resource || busy || asking}
              onClick={() => void explain()}
              aria-label="Ask EMDO about this case"
            >
              {asking ? 'Requesting…' : 'Ask EMDO'}
            </Button>
          )}
          <Button
            variant="quiet"
            disabled={saving || busy}
            onClick={() => {
              setNotice('');
              void load();
            }}
          >
            Refresh tax case
          </Button>
        </div>
      </div>
      {role && (
        <div className="finance-tax-role">
          <span>{role}</span>
          <p>{taxRoleDescriptions[role]}</p>
          {resource && (
            <small>Saved revision {resource.detail.currentRevision}</small>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Loading current case inputs…</p>}
      {blocked && (
        <div className="finance-tax-recovery">
          <h3>Questionnaire inputs are unavailable</h3>
          <p>
            A case or source authorization has changed. Previously loaded inputs
            have been cleared from this view.
          </p>
          {recovery ? (
            <>
              <p>
                As the current case owner, you can reset the questionnaire
                inputs at revision {recovery.revision} and explicitly authorize
                fresh sources.
              </p>
              <Button
                variant="secondary"
                disabled={locked}
                onClick={() => setConfirmReset(true)}
              >
                Review questionnaire reset
              </Button>
              {confirmReset && (
                <div
                  className="finance-tax-confirm"
                  role="group"
                  aria-label="Confirm questionnaire reset"
                >
                  <h4>Reset inputs for {recovery.title}?</h4>
                  <p>
                    This creates a new questionnaire revision without attached
                    declarations, book bindings, saved answers, related people
                    or residency answers. Declaration source history is
                    retained. Old revoked snapshots remain unavailable.
                  </p>
                  <label className="finance-tax-check">
                    <input
                      type="checkbox"
                      checked={resetChecked}
                      onChange={(event) =>
                        setResetChecked(event.target.checked)
                      }
                    />
                    <span>
                      I understand which questionnaire inputs will be removed
                      and that declaration sources will remain.
                    </span>
                  </label>
                  <div className="finance-tax-actions">
                    <Button
                      disabled={locked || !resetChecked}
                      onClick={() =>
                        void operate(
                          'reset-after-source-revocation',
                          ResetPrivateTaxInputsSchema.parse({
                            expectedCaseRevision: recovery.revision,
                          }),
                          TaxMutationSchema,
                          'Questionnaire inputs reset. Declaration source history is retained. You can explicitly authorize fresh book sources.',
                        ).catch(() => undefined)
                      }
                    >
                      Reset questionnaire inputs
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={saving}
                      onClick={() => {
                        setConfirmReset(false);
                        setResetChecked(false);
                      }}
                    >
                      Cancel reset
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p>
              Return to the case list to check current access, or ask the case
              owner to review source permissions.
            </p>
          )}
        </div>
      )}
      {resource && questionnaire && (
        <>
          <nav className="finance-tax-nav" aria-label="Tax case sections">
            {(
              [
                ['summary', 'Case summary'],
                ['inputs', 'Saved inputs'],
                ['working', 'Working papers'],
                ['access', 'Sources & access'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-current={tab === value ? 'page' : undefined}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab === 'summary' && (
            <div className="finance-tax-summary">
              <div className="finance-tax-availability">
                <Icon name="info" size={19} />
                <div>
                  <strong>
                    {questionnaire.binding.manifest
                      ? 'Input assessment available; no completed return.'
                      : 'Full-return calculations are unavailable for this case.'}
                  </strong>
                  <p>
                    Saved declarations and source permissions remain available
                    for review. This case has not produced or filed a completed
                    tax return. Available working-paper calculations depend on
                    this case’s jurisdiction and supported coverage, with
                    explicit input and output review.
                  </p>
                </div>
              </div>
              {resource.detail.caseRole === 'owner' &&
                questionnaire.intake.scope.taxpayerType === 'corporation' &&
                questionnaire.intake.legalEntityId === null && (
                  <TaxLegalEntityAttachment
                    key={`${resource.detail.caseId}:${resource.detail.currentRevision}`}
                    revision={resource.detail.currentRevision}
                    disabled={saving || stale || busy}
                    operate={operate}
                    onAccessUnavailable={() => {
                      setResource(undefined);
                      setError(
                        'Current entity choices could not be authorized. Refresh this case before continuing.',
                      );
                    }}
                  />
                )}
              <div className="finance-tax-metrics">
                <div>
                  <span>Saved inputs</span>
                  <strong>{resource.detail.declaredInputs.length}</strong>
                </div>
                <div>
                  <span>Authorized books</span>
                  <strong>
                    {questionnaire.sourceAuthorizationBindings.length}
                  </strong>
                </div>
                <div>
                  <span>Reviewed answers</span>
                  <strong>
                    {
                      questionnaire.answers.filter(
                        (answer) => answer.fact.reviewState === 'reviewed',
                      ).length
                    }
                  </strong>
                </div>
              </div>
              <div className="finance-tax-summary-grid">
                <section>
                  <h3>Case setup</h3>
                  <dl className="finance-tax-facts">
                    <div>
                      <dt>Country and region</dt>
                      <dd>
                        {taxCountryName(questionnaire.intake.scope.country)} ·{' '}
                        {questionnaire.intake.scope.subdivision ??
                          'Not specified'}
                      </dd>
                    </div>
                    <div>
                      <dt>Taxpayer type</dt>
                      <dd>
                        {questionnaire.intake.scope.taxpayerType?.replaceAll(
                          '-',
                          ' ',
                        ) ?? 'Not specified'}
                      </dd>
                    </div>
                    <div>
                      <dt>Tax year</dt>
                      <dd>
                        {questionnaire.intake.scope.year ?? 'Not specified'}
                      </dd>
                    </div>
                    <div>
                      <dt>Form reference</dt>
                      <dd>
                        {questionnaire.intake.scope.formVersion ??
                          'Not specified'}
                      </dd>
                    </div>
                    <div>
                      <dt>Domestic residency</dt>
                      <dd>
                        {taxTriState(questionnaire.intake.domesticResident)}
                      </dd>
                    </div>
                    <div>
                      <dt>Cross-border activity</dt>
                      <dd>
                        {taxTriState(
                          questionnaire.intake.hasCrossBorderActivity,
                        )}
                      </dd>
                    </div>
                    {questionnaire.intake.scope.taxpayerType ===
                      'corporation' && (
                      <div>
                        <dt>Standalone corporation</dt>
                        <dd>
                          {taxTriState(
                            questionnaire.intake.standaloneCorporation,
                          )}
                        </dd>
                      </div>
                    )}
                  </dl>
                </section>
                <section>
                  <h3>Assessment findings</h3>
                  {resource.assessment.issues.length ? (
                    <ul className="finance-tax-findings">
                      {resource.assessment.issues.map((issue, index) => (
                        <li key={index}>
                          <Icon name="info" size={16} />
                          <span>
                            {issue.code === 'package-unavailable'
                              ? 'A validated full-return calculation package is not available for this case. Input completeness cannot yet be established.'
                              : issue.message}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>
                      No issues were returned by this input assessment. This
                      does not establish a completed tax return.
                    </p>
                  )}
                  {!resource.assessment.questions.length && (
                    <p className="finance-tax-hint">
                      Country-specific required questions are not available. An
                      empty question list does not mean that every tax input has
                      been supplied.
                    </p>
                  )}
                </section>
              </div>
              {!!questionnaire.relatedParties.length && (
                <details>
                  <summary>
                    Related people ({questionnaire.relatedParties.length})
                  </summary>
                  <ul>
                    {questionnaire.relatedParties.map((party) => (
                      <li key={party.id}>
                        {party.displayName} · {party.relationship}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="finance-tax-actions">
                <Button variant="secondary" onClick={() => setTab('inputs')}>
                  Review saved inputs
                </Button>
                <Button variant="quiet" onClick={() => setTab('working')}>
                  Open working papers
                </Button>
                {role === 'owner' && (
                  <Button variant="quiet" onClick={() => setTab('access')}>
                    Manage case sources
                  </Button>
                )}
              </div>
            </div>
          )}
          {tab === 'inputs' && (
            <FinanceTaxInputs
              key={`${resource.detail.currentRevision}:${role}:${loadedVersion}`}
              resource={resource}
              disabled={locked}
              operate={operate}
            />
          )}
          {tab === 'access' && (
            <FinanceTaxAccess
              key={`${resource.detail.currentRevision}:${role}:${loadedVersion}`}
              detail={resource.detail}
              onAccessUnavailable={(message) => {
                controller.current?.abort();
                setResource(undefined);
                setError(message);
              }}
              disabled={locked}
              operate={operate}
            />
          )}
          {tab === 'working' && (
            <FinanceTaxWorkingPapers
              key={`${resource.detail.currentRevision}:${role}:${loadedVersion}`}
              resource={resource}
              disabled={locked}
              operate={operate}
              selectedRunId={selectedRunId}
              onSelectRun={setSelectedRunId}
              onAccessUnavailable={(message) => {
                controller.current?.abort();
                setResource(undefined);
                setError(
                  `${message} Refresh the tax case to check current access and recovery options.`,
                );
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
