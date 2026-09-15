import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  RecordPrivateTaxDeclarationSchema,
  ReviewPrivateTaxAnswerSchema,
  WithdrawPrivateTaxAnswerSchema,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import {
  TaxMutationSchema,
  taxCategoryLabels,
  taxValueText,
  type TaxDeclaration,
  type verifyTaxCase,
} from './finance-tax-model.js';
import type { TaxCaseOperation } from './finance-tax-workspace.js';
import type { TaxWorkingQuestion } from './finance-tax-working-model.js';

type Resource = ReturnType<typeof verifyTaxCase>;
type DeclarationInput = z.infer<typeof RecordPrivateTaxDeclarationSchema>;

export function FinanceTaxInputs({
  resource,
  disabled,
  operate,
}: {
  resource: Resource;
  disabled: boolean;
  operate: TaxCaseOperation;
}) {
  const { detail, declarations, assessment } = resource;
  const [editing, setEditing] = useState<TaxDeclaration | 'new'>();
  const [page, setPage] = useState(0);
  const canEdit = detail.caseRole === 'owner' || detail.caseRole === 'preparer';
  const current = detail.declaredInputs;
  return (
    <div className="finance-tax-inputs">
      <div className="finance-tax-heading">
        <div>
          <h3>Saved inputs</h3>
          <p>
            Declarations attached to questionnaire revision{' '}
            {detail.currentRevision}. Values are preserved as supplied.
          </p>
        </div>
        {canEdit && (
          <Button
            disabled={disabled || !!editing}
            onClick={() => setEditing('new')}
          >
            <Icon name="plus" size={16} />
            Add input
          </Button>
        )}
      </div>
      <div className="finance-tax-note">
        <strong>Saved does not mean reviewed.</strong> These declarations have a
        separate source history. Working-paper approvals apply only to the exact
        input versions, questionnaire revision and calculation package reviewed
        in Working papers. They do not complete a tax return.
      </div>
      {detail.declarationBindingStatus === 'legacy-unbound' && (
        <p role="status" className="finance-tax-note">
          This older questionnaire has no verified declaration bindings.
          Retained sources below are not assumed to be its saved inputs.
        </p>
      )}
      {current.length ? (
        <>
          <div
            className="finance-tax-table-scroll"
            role="region"
            aria-label="Saved tax inputs"
            tabIndex={0}
          >
            <table>
              <caption className="sr-only">
                Inputs attached to this questionnaire
              </caption>
              <thead>
                <tr>
                  <th scope="col">Input</th>
                  <th scope="col">Value</th>
                  <th scope="col">Source</th>
                  <th scope="col">Review</th>
                  {canEdit && <th scope="col">Action</th>}
                </tr>
              </thead>
              <tbody>
                {current.slice(page * 20, page * 20 + 20).map((input) => {
                  const latest = declarations.find(
                    (source) => source.sourceId === input.sourceId,
                  );
                  return (
                    <tr key={input.sourceId}>
                      <th scope="row">
                        <strong>{input.factKey}</strong>
                        <small>{taxCategoryLabels[input.category]}</small>
                      </th>
                      <td className="finance-tax-exact" data-label="Value">
                        {taxValueText(input.value)}
                        <small>
                          {input.value.type === 'decimal'
                            ? 'Exact decimal'
                            : input.value.type}
                        </small>
                      </td>
                      <td data-label="Source">
                        Revision {input.sourceRevision}
                        <details>
                          <summary>Source reference</summary>
                          <code>{input.sourceId}</code>
                          <small>Content fingerprint</small>
                          <code>{input.contentHash}</code>
                        </details>
                      </td>
                      <td data-label="Review">
                        <span className="finance-tax-badge">Unreviewed</span>
                      </td>
                      {canEdit && (
                        <td>
                          <Button
                            variant="quiet"
                            disabled={disabled || !!editing || !latest}
                            onClick={() => latest && setEditing(latest)}
                          >
                            Revise {input.factKey}
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {current.length > 20 && (
            <div className="finance-tax-pagination">
              <Button
                variant="quiet"
                disabled={!page}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous inputs
              </Button>
              <span>Page {page + 1}</span>
              <Button
                variant="quiet"
                disabled={(page + 1) * 20 >= current.length}
                onClick={() => setPage((value) => value + 1)}
              >
                Next inputs
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="finance-tax-empty finance-tax-empty--compact">
          <Icon name="finance" size={24} />
          <h4>No inputs attached to this questionnaire</h4>
          <p>
            {canEdit
              ? 'Add a declaration, or explicitly save a new revision from a retained source below.'
              : 'A case owner or preparer can save declarations here.'}
          </p>
        </div>
      )}
      {editing && (
        <TaxDeclarationEditor
          key={editing === 'new' ? 'new' : editing.sourceId}
          {...(editing === 'new' ? {} : { source: editing })}
          revision={detail.currentRevision}
          disabled={disabled}
          onCancel={() => setEditing(undefined)}
          onSave={async (input) => {
            await operate(
              'declarations',
              input,
              TaxMutationSchema,
              'Declaration saved in a new questionnaire revision. It remains unreviewed.',
            );
          }}
        />
      )}
      <details className="finance-tax-history">
        <summary>Retained declaration sources ({declarations.length})</summary>
        <p>
          The latest saved revision of each declaration source is retained
          independently of questionnaire resets. Sources are attached again only
          through an explicit save.
        </p>
        <ul className="finance-tax-source-list">
          {declarations.map((source) => {
            const bound = current.some(
              (input) =>
                input.sourceId === source.sourceId &&
                input.sourceRevision === source.sourceRevision &&
                input.contentHash === source.contentHash,
            );
            return (
              <li key={source.sourceId}>
                <div>
                  <strong>{source.factKey}</strong>
                  <p className="finance-tax-exact">
                    {taxValueText(source.value)}
                  </p>
                  <small>
                    Source revision {source.sourceRevision} ·{' '}
                    {bound
                      ? 'Attached to this questionnaire'
                      : 'Not attached to this questionnaire'}
                  </small>
                </div>
                {canEdit && (
                  <Button
                    variant="quiet"
                    disabled={disabled || !!editing}
                    onClick={() => setEditing(source)}
                  >
                    {bound
                      ? `Revise source ${source.factKey}`
                      : `Review retained source ${source.factKey}`}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {!declarations.length && <p>No retained declaration sources.</p>}
      </details>
      <section className="finance-tax-questions">
        <h3>Country-specific questions</h3>
        {assessment.questions.length ? (
          <ul className="finance-tax-findings">
            {assessment.questions.map((question) => (
              <li key={question.factKey}>
                <Icon name="info" size={16} />
                <span>
                  <strong>{question.label}</strong>
                  <small>
                    {taxCategoryLabels[question.category]}
                    {question.applicability
                      ? ` · ${question.applicability.replaceAll('-', ' ')}`
                      : ''}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            Required questions are unavailable for this return scope. You can
            preserve declarations now; an empty question list does not establish
            completeness.
          </p>
        )}
      </section>
      {!!detail.questionnaire.answers.length && (
        <TaxAnswerReview
          resource={resource}
          disabled={disabled}
          operate={operate}
        />
      )}
    </div>
  );
}

export function TaxDeclarationEditor({
  source,
  question,
  revision,
  disabled,
  onCancel,
  onSave,
}: {
  source?: TaxDeclaration;
  question?: TaxWorkingQuestion;
  revision: number;
  disabled: boolean;
  onCancel: () => void;
  onSave: (input: DeclarationInput) => Promise<void>;
}) {
  const [type, setType] = useState(
    question?.type ?? source?.value.type ?? 'text',
  );
  const factKey = question?.key ?? source?.factKey;
  const textChoices =
    factKey === 'business.incomeKind'
      ? [
          ['business', 'Business income'],
          ['commission', 'Commission income'],
        ]
      : factKey === 'business.reportingMethod'
        ? [
            ['cash', 'Cash — receipts and payments'],
            ['accrual', 'Accrual — earned income and incurred expenses'],
          ]
        : undefined;
  const [review, setReview] = useState<DeclarationInput>();
  const [error, setError] = useState('');
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      setReview(
        RecordPrivateTaxDeclarationSchema.parse({
          expectedCaseRevision: revision,
          ...(source ? { sourceId: source.sourceId } : {}),
          expectedSourceRevision: source?.sourceRevision ?? null,
          factKey: question?.key ?? source?.factKey ?? form.get('factKey'),
          category: question
            ? (source?.category ?? 'general')
            : form.get('category'),
          value: {
            type,
            value:
              type === 'boolean'
                ? form.get('value') === 'yes'
                : form.get('value'),
          },
        }),
      );
    } catch {
      setError(
        'Check the input name and value. Use an exact decimal without commas, an ISO date, a Yes/No choice or non-empty text.',
      );
    }
  }
  async function save() {
    if (!review || disabled) return;
    setError('');
    try {
      await onSave(review);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to save this input.',
      );
    }
  }
  const initial =
    source && source.value.type === type ? source.value : undefined;
  return (
    <section className="finance-tax-editor" aria-label="Tax declaration editor">
      <div className="finance-tax-heading">
        <div>
          <span className="finance-tax-eyebrow">
            Save an unreviewed declaration
          </span>
          <h4>
            {question?.label ??
              (source ? `Revise ${source.factKey}` : 'Add a tax input')}
          </h4>
          {question && <p>{question.locator}</p>}
        </div>
        <Button variant="quiet" disabled={disabled} onClick={onCancel}>
          Cancel input
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      <form hidden={!!review} onSubmit={prepare}>
        <fieldset disabled={disabled}>
          <legend className="sr-only">Declaration values</legend>
          <div className="finance-tax-form-grid">
            {!question && (
              <label>
                Input name
                <input
                  name="factKey"
                  required
                  maxLength={160}
                  defaultValue={source?.factKey}
                  readOnly={!!source}
                  placeholder="For example, employment income (CAD)"
                />
              </label>
            )}
            {!question && (
              <label>
                Category
                <select
                  name="category"
                  defaultValue={source?.category ?? 'general'}
                >
                  {Object.entries(taxCategoryLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!question && (
              <label>
                Value format
                <select
                  value={type}
                  onChange={(event) =>
                    setType(event.target.value as typeof type)
                  }
                >
                  <option value="text">Text</option>
                  <option value="decimal">Exact decimal</option>
                  <option value="date">Date</option>
                  <option value="boolean">Yes / No</option>
                </select>
              </label>
            )}
            <label className="finance-tax-form-wide">
              Declaration value
              {type === 'boolean' ? (
                <select
                  key={type}
                  name="value"
                  required
                  defaultValue={
                    initial?.type === 'boolean'
                      ? initial.value
                        ? 'yes'
                        : 'no'
                      : ''
                  }
                >
                  <option value="" disabled>
                    Choose a value
                  </option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              ) : type === 'text' && textChoices ? (
                <select
                  key={factKey}
                  name="value"
                  required
                  defaultValue={
                    initial?.type === 'text' &&
                    textChoices.some(([value]) => value === initial.value)
                      ? initial.value
                      : ''
                  }
                >
                  <option value="" disabled>
                    Choose a value
                  </option>
                  {textChoices.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : type === 'text' ? (
                <textarea
                  key={type}
                  name="value"
                  required
                  maxLength={2000}
                  rows={3}
                  defaultValue={initial?.type === 'text' ? initial.value : ''}
                />
              ) : (
                <input
                  key={type}
                  name="value"
                  type={type === 'date' ? 'date' : 'text'}
                  inputMode={type === 'decimal' ? 'decimal' : undefined}
                  required
                  maxLength={type === 'decimal' ? 100 : undefined}
                  defaultValue={
                    initial && initial.type !== 'boolean' ? initial.value : ''
                  }
                />
              )}
              <small>
                {type === 'decimal'
                  ? question
                    ? 'Enter the CAD amount exactly, without commas. This working-paper workflow accepts nonnegative source amounts with at most two decimal places; no conversion is applied.'
                    : 'Keep the exact value and decimal places. Include the currency or unit in the input name; no conversion is applied.'
                  : 'Record what your source establishes. Saving does not verify tax eligibility.'}
              </small>
            </label>
          </div>
        </fieldset>
        <Button disabled={disabled}>Review input</Button>
      </form>
      {review && (
        <div className="finance-tax-review" aria-label="Review declaration">
          <dl className="finance-tax-facts">
            <div>
              <dt>Input</dt>
              <dd>{question?.label ?? review.factKey}</dd>
            </div>
            <div>
              <dt>Value</dt>
              <dd className="finance-tax-exact">
                {taxValueText(review.value)}
              </dd>
            </div>
            <div>
              <dt>Category</dt>
              <dd>{taxCategoryLabels[review.category]}</dd>
            </div>
            <div>
              <dt>Source revision</dt>
              <dd>
                {source
                  ? `${source.sourceRevision} → new revision`
                  : 'New declaration source'}
              </dd>
            </div>
          </dl>
          <p>
            A new unreviewed declaration revision will be attached to the next
            questionnaire revision. Existing source revisions remain in history.
          </p>
          <div className="finance-tax-actions">
            <Button disabled={disabled} onClick={() => void save()}>
              Save unreviewed input
            </Button>
            <Button
              variant="quiet"
              disabled={disabled}
              onClick={() => setReview(undefined)}
            >
              Edit input
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function TaxAnswerReview({
  resource,
  disabled,
  operate,
}: {
  resource: Resource;
  disabled: boolean;
  operate: TaxCaseOperation;
}) {
  const { detail } = resource;
  const [pending, setPending] = useState<{
    factKey: string;
    revision: number;
    decision: 'reviewed' | 'disputed' | 'withdraw';
    value: string;
  }>();
  const canReview =
    detail.caseRole === 'owner' || detail.caseRole === 'reviewer';
  const canEdit = detail.caseRole === 'owner' || detail.caseRole === 'preparer';
  return (
    <section>
      <h3>Questionnaire answers</h3>
      <p>
        These are separately bound answers. Their review status does not
        establish a complete return.
      </p>
      <ul className="finance-tax-source-list">
        {detail.questionnaire.answers.map((answer) => (
          <li key={answer.fact.key}>
            <div>
              <strong>
                {detail.questionnaire.questions.find(
                  (question) => question.factKey === answer.fact.key,
                )?.label ?? answer.fact.key}
              </strong>
              <p className="finance-tax-exact">
                {taxValueText(answer.fact.value)}
              </p>
              <small>
                {answer.fact.reviewState} · answer revision {answer.revision} ·
                source revision {answer.fact.source.revision}
              </small>
            </div>
            <div className="finance-tax-actions">
              {canReview &&
                (['reviewed', 'disputed'] as const).map((decision) => (
                  <Button
                    key={decision}
                    variant="quiet"
                    disabled={disabled}
                    onClick={() =>
                      setPending({
                        factKey: answer.fact.key,
                        revision: answer.revision,
                        decision,
                        value: taxValueText(answer.fact.value),
                      })
                    }
                  >
                    {decision === 'reviewed' ? 'Review' : 'Dispute'}{' '}
                    {answer.fact.key}
                  </Button>
                ))}
              {canEdit && (
                <Button
                  variant="quiet"
                  disabled={disabled}
                  onClick={() =>
                    setPending({
                      factKey: answer.fact.key,
                      revision: answer.revision,
                      decision: 'withdraw',
                      value: taxValueText(answer.fact.value),
                    })
                  }
                >
                  Withdraw {answer.fact.key}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {pending && (
        <div
          className="finance-tax-confirm"
          role="group"
          aria-label="Confirm answer review"
        >
          <h4>
            {pending.decision === 'withdraw'
              ? 'Withdraw this answer?'
              : `Mark this answer ${pending.decision}?`}
          </h4>
          <p>
            {pending.factKey} · {pending.value} · answer revision{' '}
            {pending.revision}
          </p>
          {pending.decision === 'withdraw' && (
            <p>
              The answer will leave the current questionnaire. Its declaration
              source history is retained.
            </p>
          )}
          <div className="finance-tax-actions">
            <Button
              disabled={disabled}
              onClick={() => {
                const input = {
                  expectedCaseRevision: detail.currentRevision,
                  expectedAnswerRevision: pending.revision,
                  factKey: pending.factKey,
                };
                void operate(
                  pending.decision === 'withdraw'
                    ? 'answers/withdraw'
                    : 'answers/review',
                  pending.decision === 'withdraw'
                    ? WithdrawPrivateTaxAnswerSchema.parse(input)
                    : ReviewPrivateTaxAnswerSchema.parse({
                        ...input,
                        decision: pending.decision,
                      }),
                  TaxMutationSchema,
                  'Answer review saved in a new questionnaire revision.',
                ).catch(() => undefined);
              }}
            >
              Confirm answer change
            </Button>
            <Button
              variant="quiet"
              disabled={disabled}
              onClick={() => setPending(undefined)}
            >
              Cancel answer change
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
