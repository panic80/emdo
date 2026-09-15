import {
  deepFreeze,
  FinanceTaxIntakeSchema,
  FinanceTaxScopeSchema,
  FinanceTaxQuestionnaireSchema,
  FinanceTaxQuestionnaireAccessSchema,
  FinanceTaxCreateQuestionnaireSchema,
  FinanceTaxSaveQuestionnaireAnswerSchema,
  FinanceTaxReviewQuestionnaireAnswerSchema,
  FinanceTaxWithdrawQuestionnaireAnswerSchema,
} from '@emdo/contracts';
import type {
  FinanceTaxQuestionnaire,
  FinanceTaxQuestionnaireAccess,
  FinanceTaxQuestionnaireAnswer,
} from '@emdo/contracts';
import { FinanceTaxPackageRegistry, financeTaxScopeKey } from './index.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
async function hash(value: unknown) {
  const result = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(value)),
  );
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
function assertIdentity(
  expected: { caseId: string; workspaceId: string; taxSubjectId: string },
  actual: { caseId: string; workspaceId: string; taxSubjectId: string },
) {
  if (
    expected.caseId !== actual.caseId ||
    expected.workspaceId !== actual.workspaceId ||
    expected.taxSubjectId !== actual.taxSubjectId
  )
    throw new Error('finance-tax-questionnaire-identity-mismatch');
}
function assertUnique(values: string[], code: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`finance-tax-questionnaire-duplicate-${code}`);
}
function assertAccess(
  state: FinanceTaxQuestionnaire,
  access: FinanceTaxQuestionnaireAccess,
) {
  assertIdentity(state.intake, access);
  assertUnique(
    access.bookAuthorizations.map((entry) => entry.bookId),
    'book-authorization',
  );
  for (const book of state.intake.sourceBooks) {
    const allowed = access.bookAuthorizations.find(
      (entry) => entry.bookId === book.bookId,
    );
    const pinned = state.sourceAuthorizationBindings.find(
      (entry) => entry.bookId === book.bookId,
    );
    if (
      !allowed ||
      allowed.snapshotRevision !== book.snapshotRevision ||
      allowed.snapshotHash !== book.snapshotHash ||
      !pinned ||
      canonical(allowed) !== canonical(pinned)
    )
      throw new Error('finance-tax-questionnaire-source-authorization-changed');
  }
}
function assertSource(
  answer: FinanceTaxQuestionnaireAnswer['fact'],
  access: FinanceTaxQuestionnaireAccess,
) {
  if (
    !access.availableSources.some(
      (source) => canonical(source) === canonical(answer.source),
    )
  )
    throw new Error('finance-tax-questionnaire-source-revision-unavailable');
}
function materialize(state: FinanceTaxQuestionnaire) {
  return FinanceTaxIntakeSchema.parse({
    ...state.intake,
    facts: state.answers.map((answer) => answer.fact),
  });
}
function assertState(state: FinanceTaxQuestionnaire) {
  assertUnique(
    state.answers.map((answer) => answer.fact.key),
    'answer',
  );
  assertUnique(
    state.questions.map((question) => question.factKey),
    'question',
  );
  assertUnique(
    state.relatedParties.map((party) => party.id),
    'related-party',
  );
  if (
    canonical(state.intake.facts) !==
    canonical(state.answers.map((answer) => answer.fact))
  )
    throw new Error('finance-tax-questionnaire-answer-facts-mismatch');
  if (
    financeTaxScopeKey(state.intake.scope) !==
    financeTaxScopeKey(state.binding.scope)
  )
    throw new Error('finance-tax-questionnaire-scope-binding-changed');
  for (const answer of [
    ...state.answers,
    ...state.withdrawnAnswers.map((entry) => entry.answer),
  ]) {
    assertIdentity(state.intake, answer);
    if (
      answer.relatedPartyId &&
      !state.relatedParties.some((party) => party.id === answer.relatedPartyId)
    )
      throw new Error('finance-tax-questionnaire-related-party-unknown');
    if (
      answer.fact.reviewState !== 'unreviewed' &&
      (!answer.review ||
        answer.review.reviewedAnswerRevision !== answer.revision)
    )
      throw new Error('finance-tax-questionnaire-answer-review-stale');
  }
}

/** Private orchestration: does not establish a country's requirements or activate a package. */
export async function createFinanceTaxQuestionnaire(
  input: unknown,
  accessInput: unknown,
  registry: FinanceTaxPackageRegistry,
) {
  const request = FinanceTaxCreateQuestionnaireSchema.parse(input);
  const access = FinanceTaxQuestionnaireAccessSchema.parse(accessInput);
  assertIdentity(request.intake, access);
  if (request.intake.facts.length)
    throw new Error('finance-tax-questionnaire-bound-answers-required');
  const scope = FinanceTaxScopeSchema.parse(request.intake.scope);
  const manifest = registry.get(request.packageId, request.packageVersion);
  if (
    manifest &&
    financeTaxScopeKey(manifest.scope) !== financeTaxScopeKey(scope)
  )
    throw new Error('finance-tax-questionnaire-package-scope-mismatch');
  const requirements = manifest?.requiredFacts ?? [];
  assertUnique(
    request.questionMetadata.map((question) => question.factKey),
    'question',
  );
  if (
    request.questionMetadata.some(
      (question) =>
        !requirements.some(
          (requirement) => requirement.key === question.factKey,
        ),
    )
  )
    throw new Error('finance-tax-questionnaire-metadata-not-in-package');
  const state = FinanceTaxQuestionnaireSchema.parse({
    schemaVersion: 1,
    visibility: 'private',
    declarationSourceBindings: [],
    intake: request.intake,
    binding: {
      packageId: request.packageId,
      packageVersion: request.packageVersion,
      scope,
      manifest,
      manifestHash: manifest ? await hash(manifest) : null,
    },
    questions: requirements.map(
      (requirement) =>
        request.questionMetadata.find(
          (question) => question.factKey === requirement.key,
        ) ?? {
          factKey: requirement.key,
          category: 'general',
          label: requirement.key,
        },
    ),
    relatedParties: request.relatedParties,
    answers: [],
    withdrawnAnswers: [],
    sourceAuthorizationBindings: access.bookAuthorizations.filter(
      (authorization) =>
        request.intake.sourceBooks.some(
          (book) => book.bookId === authorization.bookId,
        ),
    ),
  });
  assertState(state);
  assertAccess(state, access);
  return deepFreeze(state);
}

/** Editing a fact always requires a new review, even when only provenance or a prior-balance revision changed. */
export async function saveFinanceTaxQuestionnaireAnswer(
  stateInput: unknown,
  input: unknown,
  accessInput: unknown,
) {
  const state = FinanceTaxQuestionnaireSchema.parse(stateInput);
  const request = FinanceTaxSaveQuestionnaireAnswerSchema.parse(input);
  const access = FinanceTaxQuestionnaireAccessSchema.parse(accessInput);
  assertState(state);
  assertAccess(state, access);
  assertIdentity(state.intake, request);
  if (request.expectedCaseRevision !== state.intake.revision)
    throw new Error('finance-tax-questionnaire-case-revision-conflict');
  const previous =
    state.answers.find((answer) => answer.fact.key === request.fact.key) ??
    [...state.withdrawnAnswers]
      .reverse()
      .find((entry) => entry.answer.fact.key === request.fact.key)?.answer;
  if ((previous?.revision ?? null) !== request.expectedAnswerRevision)
    throw new Error('finance-tax-questionnaire-answer-revision-conflict');
  const requirement = state.binding.manifest?.requiredFacts.find(
    (fact) => fact.key === request.fact.key,
  );
  if (!requirement || request.fact.value.type !== requirement.type)
    throw new Error('finance-tax-questionnaire-fact-not-in-package');
  assertSource(request.fact, access);
  const answer: FinanceTaxQuestionnaireAnswer = {
    caseId: state.intake.caseId,
    workspaceId: state.intake.workspaceId,
    taxSubjectId: state.intake.taxSubjectId,
    fact: { ...request.fact, reviewState: 'unreviewed' },
    revision: (previous?.revision ?? 0) + 1,
    relatedPartyId: request.relatedPartyId,
    updatedAt: request.updatedAt,
    previousRevisionHash: previous ? await hash(previous) : null,
    review: null,
  };
  const answers = [
    ...state.answers.filter((entry) => entry.fact.key !== answer.fact.key),
    answer,
  ].sort((a, b) =>
    a.fact.key < b.fact.key ? -1 : a.fact.key > b.fact.key ? 1 : 0,
  );
  const next = {
    ...state,
    answers,
    intake: {
      ...state.intake,
      revision: state.intake.revision + 1,
      facts: answers.map((entry) => entry.fact),
    },
  };
  materialize(next);
  assertState(next);
  return deepFreeze(next);
}

export async function reviewFinanceTaxQuestionnaireAnswer(
  stateInput: unknown,
  input: unknown,
  accessInput: unknown,
) {
  const state = FinanceTaxQuestionnaireSchema.parse(stateInput);
  const request = FinanceTaxReviewQuestionnaireAnswerSchema.parse(input);
  const access = FinanceTaxQuestionnaireAccessSchema.parse(accessInput);
  assertState(state);
  assertAccess(state, access);
  assertIdentity(state.intake, request);
  if (request.expectedCaseRevision !== state.intake.revision)
    throw new Error('finance-tax-questionnaire-case-revision-conflict');
  const previous = state.answers.find(
    (answer) => answer.fact.key === request.factKey,
  );
  if (!previous || previous.revision !== request.expectedAnswerRevision)
    throw new Error('finance-tax-questionnaire-answer-revision-conflict');
  assertSource(previous.fact, access);
  const answer = {
    ...previous,
    fact: { ...previous.fact, reviewState: request.decision },
    revision: previous.revision + 1,
    updatedAt: request.reviewedAt,
    previousRevisionHash: await hash(previous),
    review: {
      actorId: access.actorId,
      reviewedAt: request.reviewedAt,
      reviewedAnswerRevision: previous.revision + 1,
    },
  };
  const answers = state.answers.map((entry) =>
    entry.fact.key === request.factKey ? answer : entry,
  );
  const next = {
    ...state,
    answers,
    intake: {
      ...state.intake,
      revision: state.intake.revision + 1,
      facts: answers.map((entry) => entry.fact),
    },
  };
  assertState(next);
  return deepFreeze(next);
}

/** Withdraw an inapplicable or incorrect answer without erasing its bound historical revision. */
export async function withdrawFinanceTaxQuestionnaireAnswer(
  stateInput: unknown,
  input: unknown,
  accessInput: unknown,
) {
  const state = FinanceTaxQuestionnaireSchema.parse(stateInput);
  const request = FinanceTaxWithdrawQuestionnaireAnswerSchema.parse(input);
  const access = FinanceTaxQuestionnaireAccessSchema.parse(accessInput);
  assertState(state);
  assertAccess(state, access);
  assertIdentity(state.intake, request);
  if (request.expectedCaseRevision !== state.intake.revision)
    throw new Error('finance-tax-questionnaire-case-revision-conflict');
  const previous = state.answers.find(
    (answer) => answer.fact.key === request.factKey,
  );
  if (!previous || previous.revision !== request.expectedAnswerRevision)
    throw new Error('finance-tax-questionnaire-answer-revision-conflict');
  const answers = state.answers.filter(
    (answer) => answer.fact.key !== request.factKey,
  );
  const next = {
    ...state,
    answers,
    withdrawnAnswers: [
      ...state.withdrawnAnswers,
      {
        answer: previous,
        withdrawnAt: request.withdrawnAt,
        actorId: access.actorId,
      },
    ],
    intake: {
      ...state.intake,
      revision: state.intake.revision + 1,
      facts: answers.map((answer) => answer.fact),
    },
  };
  assertState(next);
  return deepFreeze(next);
}

/** Only ready-for-calculation can be reached here. Complete remains the actual package evaluator's decision. */
export async function assessFinanceTaxQuestionnaire(
  stateInput: unknown,
  accessInput: unknown,
  registry: FinanceTaxPackageRegistry,
) {
  try {
    const state = FinanceTaxQuestionnaireSchema.parse(stateInput);
    const access = FinanceTaxQuestionnaireAccessSchema.parse(accessInput);
    assertState(state);
    assertAccess(state, access);
    for (const answer of state.answers) assertSource(answer.fact, access);
    const current = registry.get(
      state.binding.packageId,
      state.binding.packageVersion,
    );
    if (!state.binding.manifest || !current)
      return deepFreeze({
        status: 'incomplete' as const,
        complete: false as const,
        issues: [
          {
            code: 'package-unavailable',
            path: 'binding',
            message:
              'No validated full-return package is bound to this questionnaire',
          },
        ],
        intake: null,
        questions: state.questions,
      });
    if (
      state.binding.manifestHash !== (await hash(state.binding.manifest)) ||
      state.binding.manifestHash !== (await hash(current))
    )
      throw new Error('finance-tax-questionnaire-package-binding-changed');
    const intake = materialize(state);
    const assessment = registry.assess(intake, state.binding);
    return deepFreeze({
      status:
        assessment.status === 'ready'
          ? ('ready-for-calculation' as const)
          : ('incomplete' as const),
      complete: false as const,
      issues: assessment.issues,
      intake: assessment.status === 'ready' ? intake : null,
      questions: state.questions.map((question) => {
        const requirement = current.requiredFacts.find(
          (entry) => entry.key === question.factKey,
        )!;
        const condition = requirement.when;
        const controllingFact = condition
          ? intake.facts.find((fact) => fact.key === condition.factKey)
          : null;
        const applicability = !condition
          ? 'required'
          : !controllingFact || controllingFact.reviewState !== 'reviewed'
            ? 'undetermined'
            : controllingFact.value.value === condition.equals
              ? 'required'
              : 'not-applicable';
        return {
          ...question,
          applicability,
          answerRevision:
            state.answers.find((answer) => answer.fact.key === question.factKey)
              ?.revision ?? null,
        };
      }),
    });
  } catch (error) {
    return deepFreeze({
      status: 'incomplete' as const,
      complete: false as const,
      issues: [
        {
          code:
            error instanceof Error &&
            error.message.startsWith('finance-tax-questionnaire-')
              ? error.message
              : 'invalid-questionnaire',
          path: 'questionnaire',
          message:
            'Questionnaire identity, revision, source authorization or immutable package binding requires review',
        },
      ],
      intake: null,
      questions: [],
    });
  }
}
