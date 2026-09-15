import { TaxMexicoInvestmentsEditor } from './finance-tax-mexico-investments.js';
import { TaxWageEvidence } from './finance-tax-wage-evidence.js';
import { useEffect, useRef, useState } from 'react';
import {
  CreatePrivateTaxCalculationRunSchema,
  FinanceTaxCalculationRunSummarySchema,
  ReviewPrivateTaxWorkingInputsSchema,
  type FinanceTaxCalculationRunSummary,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import { TaxDeclarationEditor } from './finance-tax-inputs.js';
import { TaxRunViewer } from './finance-tax-run-viewer.js';
import {
  readTaxJson,
  TaxMutationSchema,
  TaxRequestError,
  taxValueText,
  type TaxDeclaration,
  type verifyTaxCase,
} from './finance-tax-model.js';
import {
  TaxWorkingInputReceiptSchema,
  taxInputBinding,
  taxRunLabel,
  taxWorkingBinding,
  taxWorkingInputs,
  verifyTaxPreparation,
  verifyTaxRunList,
  type TaxWorkingPreparation,
  type TaxWorkingQuestion,
} from './finance-tax-working-model.js';
import type { TaxCaseOperation } from './finance-tax-workspace.js';
import './finance-tax-working-papers.css';

type Resource = ReturnType<typeof verifyTaxCase>;
export function FinanceTaxWorkingPapers({
  resource,
  disabled,
  operate,
  selectedRunId,
  onSelectRun,
  onAccessUnavailable,
}: {
  resource: Resource;
  disabled: boolean;
  operate: TaxCaseOperation;
  selectedRunId: string | undefined;
  onSelectRun: (runId: string | undefined) => void;
  onAccessUnavailable: (message: string) => void;
}) {
  const { detail, declarations } = resource;
  const [preparation, setPreparation] = useState<TaxWorkingPreparation>();
  const [runs, setRuns] = useState<FinanceTaxCalculationRunSummary[]>([]);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<'prepare' | 'history'>('prepare');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [selectedInputs, setSelectedInputs] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<'inputs' | 'run'>();
  const [checked, setChecked] = useState(false);
  const [editing, setEditing] = useState<{
    question: TaxWorkingQuestion;
    source?: TaxDeclaration;
  }>();
  const [filter, setFilter] = useState<'all' | 'attention'>('attention');
  const controller = useRef<AbortController | undefined>(undefined);
  const canEdit = detail.caseRole === 'owner' || detail.caseRole === 'preparer';
  const canReview =
    detail.caseRole === 'owner' || detail.caseRole === 'reviewer';
  const base = `/api/v2/finance/tax/cases/${detail.caseId}`;
  async function load(nextPage: number) {
    controller.current?.abort();
    const control = new AbortController();
    controller.current = control;
    setBusy(true);
    setPreparation(undefined);
    setRuns([]);
    setError('');
    setConfirm(undefined);
    setChecked(false);
    setSelectedInputs([]);
    try {
      const [rawPreparation, rawRuns] = await Promise.all([
        readTaxJson(`${base}/working-papers`, control.signal),
        readTaxJson(
          `${base}/runs?offset=${nextPage * 25}&limit=26`,
          control.signal,
        ),
      ]);
      const prepared = verifyTaxPreparation(rawPreparation, detail);
      const history = verifyTaxRunList(rawRuns, detail);
      if (control.signal.aborted) return;
      setPreparation(prepared);
      setRuns(history);
      setPage(nextPage);
    } catch (failure) {
      if (control.signal.aborted) return;
      const message =
        failure instanceof Error
          ? failure.message
          : 'Working papers could not be loaded.';
      setError(message);
      if (
        failure instanceof TaxRequestError &&
        ([401, 403].includes(failure.status) ||
          failure.code === 'finance-tax-source-revoked')
      )
        onAccessUnavailable(message);
    } finally {
      if (!control.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void load(0);
    return () => controller.current?.abort();
  }, []);
  const inputs = preparation ? taxWorkingInputs(preparation, detail) : [];
  const selected = inputs.filter(
    (item) => item.input && selectedInputs.includes(item.input.sourceId),
  );
  const approvedCount = inputs.filter((item) => item.review).length;
  const savedCount = inputs.filter(
    (item) => item.input && !item.wrongType,
  ).length;
  const extraInputs = detail.declaredInputs.filter(
    (input) =>
      !preparation?.questions.some(
        (question) => question.key === input.factKey,
      ),
  );
  const us = preparation?.workflowId === 'us-fed-2025-working-papers';
  const corporate =
    preparation?.workflowId === 'ca-on-2025-corporate-working-papers';
  const DeclarationEditor =
    preparation?.workflowId === 'mx-fed-2025-working-papers' &&
    detail.questionnaire.intake.scope.taxpayerType === 'corporation' &&
    editing?.question.key === 'corporation.investments.rows'
      ? TaxMexicoInvestmentsEditor
      : TaxDeclarationEditor;
  const scopeLabel =
    preparation?.workflowId === 'mx-fed-2025-working-papers'
      ? 'Mexico 2025 federal'
      : us
        ? 'US 2025 federal (state and local excluded)'
        : `Ontario 2025 ${corporate ? 'standalone corporate' : 'personal-tax'}`;
  const groups = us
    ? [
        {
          name: 'Identity and address',
          accept: (key: string) => key.startsWith('identity.'),
        },
        {
          name: 'Wages and originals',
          accept: (key: string) =>
            key.startsWith('w2.') || key.startsWith('wageEvidence.'),
        },
        {
          name: 'Business details and amounts',
          accept: (key: string) => key.startsWith('business.'),
        },
        {
          name: 'Filing, payments and applicability',
          accept: (key: string) =>
            !key.startsWith('identity.') &&
            !key.startsWith('w2.') &&
            !key.startsWith('wageEvidence.') &&
            !key.startsWith('business.'),
        },
      ]
    : corporate
      ? [
          {
            name: 'Corporate identity',
            accept: (key: string) => key.startsWith('identity.'),
          },
          {
            name: 'Eligibility and additional schedules',
            accept: (key: string) =>
              key.startsWith('corporate.declarations.') ||
              key.startsWith('corporate.attachmentAnswers.'),
          },
          {
            name: 'Financial statements and prior balances',
            accept: (key: string) =>
              key.startsWith('corporate.financialStatements.') ||
              key.startsWith('corporate.priorYear.'),
          },
          {
            name: 'Disclosures and payments',
            accept: (key: string) =>
              key.startsWith('corporate.') &&
              !key.startsWith('corporate.declarations.') &&
              !key.startsWith('corporate.attachmentAnswers.') &&
              !key.startsWith('corporate.financialStatements.') &&
              !key.startsWith('corporate.priorYear.'),
          },
        ]
      : [
          {
            name: 'Eligibility & scope',
            accept: (key: string) =>
              key.startsWith('scope.') || key === 'business.simpleService',
          },
          {
            name: 'Personal details',
            accept: (key: string) =>
              key === 'dateOfBirth' || key.startsWith('identity.'),
          },
          {
            name: 'Employment & other income',
            accept: (key: string) =>
              !key.startsWith('scope.') &&
              !key.startsWith('business.') &&
              !key.startsWith('identity.') &&
              !key.startsWith('businessIdentity.') &&
              key !== 'dateOfBirth',
          },
          {
            name: 'Business details and amounts',
            accept: (key: string) =>
              (key.startsWith('business.') &&
                key !== 'business.simpleService') ||
              key.startsWith('businessIdentity.'),
          },
        ];
  async function apply() {
    if (!preparation || !confirm || !checked || disabled) return;
    setError('');
    try {
      if (confirm === 'inputs') {
        const payload = ReviewPrivateTaxWorkingInputsSchema.parse({
          ...taxWorkingBinding(preparation),
          inputs: selected.map((item) => taxInputBinding(item.input!)),
        });
        await operate(
          'working-papers/input-reviews',
          payload,
          TaxWorkingInputReceiptSchema.refine(
            (receipt) =>
              receipt.snapshotRevision === preparation.snapshotRevision &&
              receipt.snapshotHash === preparation.snapshotHash &&
              receipt.reviewedInputCount === payload.inputs.length,
            'Input review receipt does not match the selected versions.',
          ),
          'Exact input versions reviewed for this questionnaire revision and working-paper package.',
        );
      } else {
        const run = await operate(
          'runs',
          CreatePrivateTaxCalculationRunSchema.parse(
            taxWorkingBinding(preparation),
          ),
          FinanceTaxCalculationRunSummarySchema.refine(
            (receipt) =>
              receipt.taxSubjectId === detail.taxSubjectId &&
              receipt.snapshotRevision === preparation.snapshotRevision &&
              receipt.snapshotHash === preparation.snapshotHash &&
              receipt.packageVersion === preparation.packageVersion &&
              receipt.packageHash === preparation.packageHash &&
              receipt.workflowId === preparation.workflowId,
            'Run receipt does not match the reviewed creation scope.',
          ),
          'Working-paper run saved. It remains incomplete and is not fileable.',
        );
        onSelectRun(run.runId);
      }
    } catch (failure) {
      if (!controller.current?.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Unable to save this working-paper action.',
        );
    }
  }
  function startConfirmation(value: 'inputs' | 'run') {
    setConfirm(value);
    setChecked(false);
    setEditing(undefined);
  }
  if (selectedRunId)
    return (
      <TaxRunViewer
        key={selectedRunId}
        runId={selectedRunId}
        detail={detail}
        disabled={disabled}
        operate={operate}
        onBack={() => {
          onSelectRun(undefined);
          setView('history');
        }}
        onAccessUnavailable={onAccessUnavailable}
      />
    );
  return (
    <div className="finance-tax-working">
      <div className="finance-tax-heading">
        <div>
          <span className="finance-tax-eyebrow">
            Prepare · review · preserve
          </span>
          <h3>Working papers</h3>
          <p>
            Limited {scopeLabel} calculations for review. Every run preserves
            the exact input and package versions used.
          </p>
        </div>
        <Button
          variant="quiet"
          disabled={busy || disabled}
          onClick={() => void load(page)}
        >
          Refresh working papers
        </Button>
      </div>
      <div
        className="finance-tax-working-switch"
        aria-label="Working-paper views"
      >
        <Button
          variant={view === 'prepare' ? 'secondary' : 'quiet'}
          aria-pressed={view === 'prepare'}
          onClick={() => setView('prepare')}
        >
          Prepare inputs
        </Button>
        <Button
          variant={view === 'history' ? 'secondary' : 'quiet'}
          aria-pressed={view === 'history'}
          onClick={() => setView('history')}
        >
          Run history
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && (
        <p role="status">Checking the current snapshot and saved runs…</p>
      )}
      {preparation && view === 'prepare' && (
        <>
          <div className="finance-tax-working-boundary">
            <Icon name="info" size={19} />
            <div>
              <strong>Incomplete working papers · not fileable</strong>
              <p>
                This workflow covers a limited set of {scopeLabel}{' '}
                circumstances. It does not establish a completed return, refund
                or balance owing. Required inputs and exclusions must be
                reviewed individually.
              </p>
            </div>
          </div>
          {!preparation.scopeSupported && (
            <section
              className="finance-tax-note"
              aria-label="Unsupported working-paper scope"
            >
              <strong>
                This case’s scope is outside the available working-paper
                workflow.
              </strong>
              <p>
                Your saved inputs remain preserved. The supported scopes below
                require an exact country, region, year, taxpayer type and form
                reference match. Input review and run creation are unavailable
                for this case.
              </p>
              <ul>
                {preparation.supportedScopes.map((scope, index) => (
                  <li key={index}>
                    {scope.country} · {scope.subdivision} · {scope.year} ·{' '}
                    {scope.taxpayerType?.replaceAll('-', ' ')}
                    <small>
                      {scope.regime} · {scope.formVersion}
                    </small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div
            className="finance-tax-working-progress"
            aria-label="Working-paper input progress"
          >
            <div>
              <span>01 · Saved inputs</span>
              <strong>
                {savedCount}
                <small>of {inputs.length} prompts</small>
              </strong>
            </div>
            <div>
              <span>02 · Exact versions reviewed</span>
              <strong>
                {approvedCount}
                <small>for revision {detail.currentRevision}</small>
              </strong>
            </div>
            <div>
              <span>03 · Preserved output</span>
              <p>An explicit run records calculations or input blockers.</p>
            </div>
          </div>
          <p className="finance-tax-hint">
            Finish saving your inputs before approving their versions. Any new
            questionnaire revision requires a fresh input review. Enter zero
            only when your source establishes zero; no values are assumed.
          </p>
          {extraInputs.length > 0 && (
            <div className="finance-tax-note">
              <strong>Additional saved inputs need attention.</strong>{' '}
              {extraInputs.length} declaration
              {extraInputs.length === 1 ? ' is' : 's are'} outside this
              workflow’s prompts. They will be included in the run assessment
              and may block calculation; nothing is silently omitted.
            </div>
          )}
          {us && (
            <TaxWageEvidence
              caseId={detail.caseId}
              preparation={preparation}
              source={declarations.find(
                (d) => d.factKey === 'wageEvidence.documents',
              )}
              canEdit={canEdit}
              canReview={canReview}
              disabled={disabled}
              operate={operate}
            />
          )}
          {editing ? (
            <DeclarationEditor
              key={editing.question.key}
              question={editing.question}
              {...(editing.source ? { source: editing.source } : {})}
              revision={detail.currentRevision}
              disabled={disabled}
              onCancel={() => setEditing(undefined)}
              onSave={async (input) => {
                await operate(
                  'declarations',
                  input,
                  TaxMutationSchema,
                  'Input saved as an unreviewed declaration. Review all exact input versions after finishing your changes.',
                );
              }}
            />
          ) : (
            <>
              <div className="finance-tax-working-toolbar">
                <label>
                  Show inputs
                  <select
                    value={filter}
                    onChange={(event) =>
                      setFilter(event.target.value as typeof filter)
                    }
                  >
                    <option value="all">All required prompts</option>
                    <option value="attention">Needs input or review</option>
                  </select>
                </label>
                {canReview && (
                  <p>
                    {selected.length} exact version
                    {selected.length === 1 ? '' : 's'} selected for review
                  </p>
                )}
              </div>
              <div className="finance-tax-working-groups">
                {groups.map((group, groupIndex) => {
                  const rows = inputs.filter((item) =>
                    group.accept(item.question.key),
                  );
                  const visible = rows.filter(
                    (item) => filter === 'all' || !item.review,
                  );
                  if (!rows.length) return null;
                  return (
                    <details
                      key={group.name}
                      open={groupIndex === 0 || undefined}
                    >
                      <summary>
                        <span>{group.name}</span>
                        <small>
                          {rows.filter((item) => item.review).length} /{' '}
                          {rows.length} reviewed
                        </small>
                      </summary>
                      <ul className="finance-tax-working-inputs">
                        {visible.map((item) => (
                          <li key={item.question.key}>
                            <div className="finance-tax-working-input-name">
                              <strong>{item.question.label}</strong>
                              <small>{item.question.locator}</small>
                              <span className="finance-tax-badge">
                                {item.ambiguous
                                  ? 'Duplicate input names'
                                  : item.wrongType
                                    ? 'Value format differs'
                                    : item.review
                                      ? 'Version reviewed'
                                      : item.input
                                        ? 'Awaiting review'
                                        : 'Not supplied'}
                              </span>
                            </div>
                            <div className="finance-tax-working-input-value">
                              {item.input ? (
                                <>
                                  <strong className="finance-tax-exact">
                                    {taxValueText(item.input.value)}
                                  </strong>
                                  <small>
                                    Source revision {item.input.sourceRevision}
                                    {item.question.type === 'decimal' &&
                                    !item.question.key.startsWith(
                                      'businessIdentity.',
                                    )
                                      ? ' · CAD'
                                      : ''}
                                  </small>
                                  <details>
                                    <summary>Version evidence</summary>
                                    <code>{item.input.sourceId}</code>
                                    <code>{item.input.contentHash}</code>
                                    {item.review && (
                                      <p>
                                        Reviewed by {item.review.reviewedBy}
                                        <br />
                                        {item.review.reviewedAt}
                                      </p>
                                    )}
                                  </details>
                                </>
                              ) : (
                                <p>
                                  {item.ambiguous
                                    ? 'Resolve duplicate declarations before creating a run.'
                                    : 'No saved declaration'}
                                </p>
                              )}
                            </div>
                            <div className="finance-tax-working-input-action">
                              {canReview &&
                                preparation.scopeSupported &&
                                item.input &&
                                !item.review &&
                                !item.wrongType && (
                                  <label className="finance-tax-check">
                                    <input
                                      type="checkbox"
                                      disabled={disabled || !!confirm}
                                      checked={selectedInputs.includes(
                                        item.input.sourceId,
                                      )}
                                      onChange={(event) =>
                                        setSelectedInputs((current) =>
                                          event.target.checked
                                            ? [...current, item.input!.sourceId]
                                            : current.filter(
                                                (id) =>
                                                  id !== item.input!.sourceId,
                                              ),
                                        )
                                      }
                                      aria-label={`Review saved version: ${item.question.label}`}
                                    />
                                    <span>Review version</span>
                                  </label>
                                )}
                              {canEdit &&
                                item.question.key !==
                                  'wageEvidence.documents' &&
                                preparation.scopeSupported &&
                                !item.ambiguous && (
                                  <Button
                                    variant="quiet"
                                    disabled={disabled || !!confirm}
                                    onClick={() => {
                                      const source = declarations.find(
                                        (candidate) =>
                                          candidate.sourceId ===
                                          item.input?.sourceId,
                                      );
                                      setEditing({
                                        question: item.question,
                                        ...(source ? { source } : {}),
                                      });
                                    }}
                                    aria-label={`${item.input ? 'Revise' : 'Add'} working input: ${item.question.label}`}
                                  >
                                    {item.input ? 'Revise input' : 'Add input'}
                                  </Button>
                                )}
                            </div>
                          </li>
                        ))}
                      </ul>
                      {!visible.length && (
                        <p className="finance-tax-hint">
                          All input versions in this group have been reviewed
                          for this snapshot.
                        </p>
                      )}
                    </details>
                  );
                })}
              </div>
              <div className="finance-tax-working-next">
                <div>
                  <h4>Save an auditable run</h4>
                  <p>
                    Missing, unreviewed or unsupported inputs are preserved as
                    blockers. Creating a run never approves its inputs or
                    completes a return.
                  </p>
                </div>
                <div className="finance-tax-actions">
                  {canReview && (
                    <Button
                      variant="secondary"
                      disabled={
                        disabled ||
                        !preparation.scopeSupported ||
                        !selected.length ||
                        !!confirm
                      }
                      onClick={() => startConfirmation('inputs')}
                    >
                      Review selected input versions
                    </Button>
                  )}
                  {canEdit && (
                    <Button
                      disabled={
                        disabled || !preparation.scopeSupported || !!confirm
                      }
                      onClick={() => startConfirmation('run')}
                    >
                      Review run creation
                    </Button>
                  )}
                </div>
              </div>
              {!canEdit && (
                <p className="finance-tax-hint">
                  A case owner or preparer can create a run.{' '}
                  {canReview
                    ? 'Your reviewer role can approve exact input versions and review saved working papers.'
                    : 'Your viewer role can inspect runs and download explicitly reviewed working papers.'}
                </p>
              )}
            </>
          )}
          {confirm && (
            <section
              className="finance-tax-confirm"
              aria-label={
                confirm === 'inputs'
                  ? 'Confirm exact input review'
                  : 'Confirm working-paper run'
              }
            >
              <h4>
                {confirm === 'inputs'
                  ? `Review ${selected.length} exact saved input versions`
                  : 'Create a run from this saved snapshot'}
              </h4>
              <dl className="finance-tax-facts">
                <div>
                  <dt>Questionnaire</dt>
                  <dd>Revision {preparation.snapshotRevision}</dd>
                </div>
                <div>
                  <dt>Package version</dt>
                  <dd>{preparation.packageVersion}</dd>
                </div>
                <div>
                  <dt>Snapshot fingerprint</dt>
                  <dd>
                    <code>{preparation.snapshotHash}</code>
                  </dd>
                </div>
              </dl>
              {confirm === 'inputs' && (
                <ul className="finance-tax-working-review-list">
                  {selected.map((item) => (
                    <li key={item.input!.sourceId}>
                      <strong>{item.question.label}</strong>
                      <span className="finance-tax-exact">
                        {taxValueText(item.input!.value)}
                      </span>
                      <small>
                        Source revision {item.input!.sourceRevision}
                      </small>
                      <code>{item.input!.sourceId}</code>
                      <code>{item.input!.contentHash}</code>
                    </li>
                  ))}
                </ul>
              )}
              <label className="finance-tax-check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(event) => setChecked(event.target.checked)}
                />
                <span>
                  {confirm === 'inputs'
                    ? 'I have reviewed these exact source values and versions for this questionnaire and package. This approval does not certify a complete tax return.'
                    : 'Create incomplete working papers from this exact snapshot and package. Missing or unreviewed inputs will remain blockers; no return will be completed or filed.'}
                </span>
              </label>
              <div className="finance-tax-actions">
                <Button
                  disabled={disabled || !checked}
                  onClick={() => void apply()}
                >
                  {confirm === 'inputs'
                    ? 'Approve exact input versions'
                    : 'Create working-paper run'}
                </Button>
                <Button
                  variant="quiet"
                  disabled={disabled}
                  onClick={() => setConfirm(undefined)}
                >
                  Cancel review
                </Button>
              </div>
            </section>
          )}
          <details className="finance-tax-history">
            <summary>Preparation provenance</summary>
            <p>
              Questionnaire revision {preparation.snapshotRevision} · package{' '}
              {preparation.packageVersion}
            </p>
            <small>Snapshot fingerprint</small>
            <code>{preparation.snapshotHash}</code>
            <small>Package fingerprint</small>
            <code>{preparation.packageHash}</code>
          </details>
        </>
      )}
      {preparation && view === 'history' && (
        <section aria-label="Saved working-paper runs">
          <h4>Run history</h4>
          <p>
            Each run retains its original snapshot. Access still depends on
            current case permissions and its exact source authorizations.
          </p>
          {runs.length ? (
            <ul className="finance-tax-run-list">
              {runs.slice(0, 25).map((run) => (
                <li key={run.runId}>
                  <button type="button" onClick={() => onSelectRun(run.runId)}>
                    <span>
                      <strong>{taxRunLabel(run.status)}</strong>
                      <small>
                        Snapshot revision {run.snapshotRevision} ·{' '}
                        {run.createdAt}
                      </small>
                    </span>
                    <span className="finance-tax-badge">
                      {run.snapshotRevision === detail.currentRevision &&
                      run.snapshotHash === detail.snapshotHash
                        ? 'Current snapshot'
                        : 'Earlier snapshot'}
                    </span>
                    <Icon name="chevron-right" size={17} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="finance-tax-empty finance-tax-empty--compact">
              <Icon name="finance" size={24} />
              <h4>No saved runs</h4>
              <p>
                Prepare your inputs, then explicitly create a working-paper run.
              </p>
            </div>
          )}
          <div className="finance-tax-pagination">
            <Button
              variant="quiet"
              disabled={!page || busy}
              onClick={() => void load(page - 1)}
            >
              Previous runs
            </Button>
            <span>Page {page + 1}</span>
            <Button
              variant="quiet"
              disabled={runs.length <= 25 || busy}
              onClick={() => void load(page + 1)}
            >
              Next runs
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
