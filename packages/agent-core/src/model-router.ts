export const EMDO_MODEL_IDS = ['gpt-5.6-luna', 'gpt-5.6-terra'] as const;

export type EmdoModelId = (typeof EMDO_MODEL_IDS)[number];

export const MODEL_ESCALATION_TRIGGERS = [
  'dependent-cross-domain',
  'failed-output-validation',
  'low-confidence-reconciliation',
  'complex-reasoning',
  'luna-unavailable',
] as const;

export type ModelEscalationTrigger = (typeof MODEL_ESCALATION_TRIGGERS)[number];
export type RequestedModelEscalationTrigger = Exclude<
  ModelEscalationTrigger,
  'luna-unavailable'
>;

export interface ModelRoutingPolicy {
  readonly defaultModel: 'gpt-5.6-luna';
  readonly complexModel: 'gpt-5.6-terra';
  readonly escalationReasons: readonly ModelEscalationTrigger[];
}

const MODEL_ESCALATION_PRIORITY = [
  'failed-output-validation',
  'luna-unavailable',
  'low-confidence-reconciliation',
  'dependent-cross-domain',
  'complex-reasoning',
] as const satisfies readonly ModelEscalationTrigger[];

export interface ModelAvailability {
  isAvailable(model: EmdoModelId): Promise<boolean>;
}

export type ModelResolution =
  | Readonly<{
      status: 'resolved';
      requestedModel: EmdoModelId;
      resolvedModel: EmdoModelId;
      reason: 'default' | RequestedModelEscalationTrigger | 'luna-unavailable';
    }>
  | Readonly<{
      status: 'resolved';
      requestedModel: 'gpt-5.6-terra';
      resolvedModel: 'gpt-5.6-luna';
      reason: 'terra-unavailable';
      escalationTrigger: 'complex-reasoning';
    }>
  | Readonly<{
      status: 'unavailable';
      requestedModel: EmdoModelId;
      attemptedModels: readonly EmdoModelId[];
      reason: 'no-configured-model-available';
      safeError: Readonly<{
        code: 'agent-model-unavailable';
        message: 'AI is temporarily unavailable. Local features still work.';
        retryable: true;
      }>;
    }>
  | Readonly<{
      status: 'unavailable';
      requestedModel: 'gpt-5.6-terra';
      attemptedModels: readonly ['gpt-5.6-terra'];
      reason: 'required-complex-model-unavailable';
      escalationTrigger: Exclude<ModelEscalationTrigger, 'complex-reasoning'>;
      safeError: Readonly<{
        code: 'required-agent-model-unavailable';
        message: 'The model required to complete this request safely is temporarily unavailable.';
        retryable: true;
      }>;
    }>
  | Readonly<{
      status: 'unavailable';
      requestedModel: 'gpt-5.6-terra';
      attemptedModels: readonly [];
      reason: 'configured-model-escalation-not-allowed';
      escalationTrigger: ModelEscalationTrigger;
      safeError: Readonly<{
        code: 'agent-model-escalation-not-allowed';
        message: 'The active agent policy does not allow the required model escalation.';
        retryable: false;
      }>;
    }>
  | Readonly<{
      status: 'unavailable';
      requestedModel: 'gpt-5.6-luna';
      attemptedModels: readonly ['gpt-5.6-luna'];
      reason: 'configured-model-fallback-not-allowed';
      safeError: Readonly<{
        code: 'agent-model-fallback-not-allowed';
        message: 'The active agent policy does not allow a model fallback.';
        retryable: false;
      }>;
    }>;

const freezeResolution = <Resolution extends ModelResolution>(
  resolution: Resolution,
): Resolution => {
  if (resolution.status === 'unavailable') {
    Object.freeze(resolution.attemptedModels);
    Object.freeze(resolution.safeError);
  }
  return Object.freeze(resolution);
};

const isPlainObject = (value: unknown): value is object =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const snapshotArray = <Item>(input: {
  readonly value: unknown;
  readonly maxLength: number;
  readonly allowEmpty: boolean;
  readonly parse: (value: unknown) => Item;
}): readonly Item[] => {
  if (
    !Array.isArray(input.value) ||
    Object.getPrototypeOf(input.value) !== Array.prototype
  ) {
    throw new Error('invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input.value);
  const length = Object.getOwnPropertyDescriptor(input.value, 'length')
    ?.value as unknown;
  if (
    !Number.isSafeInteger(length) ||
    (length as number) < (input.allowEmpty ? 0 : 1) ||
    (length as number) > input.maxLength ||
    Reflect.ownKeys(input.value).length !== (length as number) + 1
  ) {
    throw new Error('invalid');
  }
  const snapshot: Item[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new Error('invalid');
    }
    snapshot.push(input.parse(descriptor.value));
  }
  return Object.freeze(snapshot);
};

const snapshotRoutingRequest = (
  input: unknown,
): Readonly<{
  triggers: readonly ModelEscalationTrigger[];
  policy: Readonly<ModelRoutingPolicy>;
}> => {
  try {
    if (!isPlainObject(input)) throw new Error('invalid');
    const inputDescriptors = Object.getOwnPropertyDescriptors(input);
    const inputKeys = Reflect.ownKeys(input);
    const triggersDescriptor = inputDescriptors.triggers;
    const policyDescriptor = inputDescriptors.policy;
    if (
      inputKeys.length !== 2 ||
      !inputKeys.includes('triggers') ||
      !inputKeys.includes('policy') ||
      triggersDescriptor === undefined ||
      triggersDescriptor.get !== undefined ||
      triggersDescriptor.set !== undefined ||
      triggersDescriptor.enumerable !== true ||
      policyDescriptor === undefined ||
      policyDescriptor.get !== undefined ||
      policyDescriptor.set !== undefined ||
      policyDescriptor.enumerable !== true ||
      !isPlainObject(policyDescriptor.value)
    ) {
      throw new Error('invalid');
    }

    const triggers = snapshotArray<ModelEscalationTrigger>({
      value: triggersDescriptor.value,
      maxLength: MODEL_ESCALATION_PRIORITY.length,
      allowEmpty: true,
      parse: (trigger) => {
        if (
          typeof trigger !== 'string' ||
          !MODEL_ESCALATION_TRIGGERS.includes(trigger as ModelEscalationTrigger)
        ) {
          throw new Error('invalid');
        }
        return trigger as ModelEscalationTrigger;
      },
    });

    const rawPolicy = policyDescriptor.value;
    const policyDescriptors = Object.getOwnPropertyDescriptors(rawPolicy);
    const policyKeys = Reflect.ownKeys(rawPolicy);
    const defaultModel = policyDescriptors.defaultModel;
    const complexModel = policyDescriptors.complexModel;
    const escalationReasons = policyDescriptors.escalationReasons;
    if (
      policyKeys.length !== 3 ||
      !policyKeys.includes('defaultModel') ||
      !policyKeys.includes('complexModel') ||
      !policyKeys.includes('escalationReasons') ||
      defaultModel === undefined ||
      defaultModel.get !== undefined ||
      defaultModel.set !== undefined ||
      defaultModel.enumerable !== true ||
      defaultModel.value !== 'gpt-5.6-luna' ||
      complexModel === undefined ||
      complexModel.get !== undefined ||
      complexModel.set !== undefined ||
      complexModel.enumerable !== true ||
      complexModel.value !== 'gpt-5.6-terra' ||
      escalationReasons === undefined ||
      escalationReasons.get !== undefined ||
      escalationReasons.set !== undefined ||
      escalationReasons.enumerable !== true
    ) {
      throw new Error('invalid');
    }
    const reasons = snapshotArray<ModelEscalationTrigger>({
      value: escalationReasons.value,
      maxLength: MODEL_ESCALATION_TRIGGERS.length,
      allowEmpty: false,
      parse: (reason) => {
        if (
          typeof reason !== 'string' ||
          !MODEL_ESCALATION_TRIGGERS.includes(reason as ModelEscalationTrigger)
        ) {
          throw new Error('invalid');
        }
        return reason as ModelEscalationTrigger;
      },
    });
    if (new Set(reasons).size !== reasons.length) throw new Error('invalid');

    return Object.freeze({
      triggers,
      policy: Object.freeze({
        defaultModel: 'gpt-5.6-luna',
        complexModel: 'gpt-5.6-terra',
        escalationReasons: reasons,
      }),
    });
  } catch {
    throw new Error('invalid-model-routing-request');
  }
};

export class ModelRouter {
  private readonly checkAvailability: ModelAvailability['isAvailable'];

  constructor(availability: ModelAvailability) {
    if (typeof availability.isAvailable !== 'function') {
      throw new Error('invalid-model-availability-provider');
    }
    this.checkAvailability = availability.isAvailable.bind(availability);
  }

  private async available(model: EmdoModelId): Promise<boolean> {
    try {
      return (await this.checkAvailability(model)) === true;
    } catch {
      return false;
    }
  }

  async resolve(input: {
    readonly triggers: readonly ModelEscalationTrigger[];
    readonly policy: ModelRoutingPolicy;
  }): Promise<ModelResolution> {
    const { policy, triggers } = snapshotRoutingRequest(input);
    const escalation = MODEL_ESCALATION_PRIORITY.find((trigger) =>
      triggers.includes(trigger),
    );
    const disallowedEscalation = MODEL_ESCALATION_PRIORITY.find(
      (trigger) =>
        triggers.includes(trigger) &&
        !policy.escalationReasons.includes(trigger),
    );
    if (disallowedEscalation !== undefined) {
      return freezeResolution({
        status: 'unavailable',
        requestedModel: policy.complexModel,
        attemptedModels: [] as const,
        reason: 'configured-model-escalation-not-allowed',
        escalationTrigger: disallowedEscalation,
        safeError: {
          code: 'agent-model-escalation-not-allowed',
          message:
            'The active agent policy does not allow the required model escalation.',
          retryable: false,
        },
      });
    }

    const requestedModel: EmdoModelId =
      escalation === undefined ? policy.defaultModel : policy.complexModel;
    if (await this.available(requestedModel)) {
      return freezeResolution({
        status: 'resolved',
        requestedModel,
        resolvedModel: requestedModel,
        reason: escalation ?? 'default',
      });
    }

    if (
      requestedModel === policy.complexModel &&
      escalation !== 'complex-reasoning'
    ) {
      return freezeResolution({
        status: 'unavailable',
        requestedModel: policy.complexModel,
        attemptedModels: [policy.complexModel] as const,
        reason: 'required-complex-model-unavailable',
        escalationTrigger: escalation as Exclude<
          ModelEscalationTrigger,
          'complex-reasoning'
        >,
        safeError: {
          code: 'required-agent-model-unavailable',
          message:
            'The model required to complete this request safely is temporarily unavailable.',
          retryable: true,
        },
      });
    }

    if (
      requestedModel === policy.defaultModel &&
      !policy.escalationReasons.includes('luna-unavailable')
    ) {
      return freezeResolution({
        status: 'unavailable',
        requestedModel: policy.defaultModel,
        attemptedModels: [policy.defaultModel] as const,
        reason: 'configured-model-fallback-not-allowed',
        safeError: {
          code: 'agent-model-fallback-not-allowed',
          message: 'The active agent policy does not allow a model fallback.',
          retryable: false,
        },
      });
    }

    const fallbackModel: EmdoModelId =
      requestedModel === policy.defaultModel
        ? policy.complexModel
        : policy.defaultModel;
    if (await this.available(fallbackModel)) {
      if (requestedModel === policy.complexModel) {
        return freezeResolution({
          status: 'resolved',
          requestedModel: policy.complexModel,
          resolvedModel: policy.defaultModel,
          reason: 'terra-unavailable',
          escalationTrigger: 'complex-reasoning',
        });
      }
      return freezeResolution({
        status: 'resolved',
        requestedModel: policy.defaultModel,
        resolvedModel: policy.complexModel,
        reason: 'luna-unavailable',
      });
    }

    return freezeResolution({
      status: 'unavailable',
      requestedModel,
      attemptedModels: [requestedModel, fallbackModel],
      reason: 'no-configured-model-available',
      safeError: {
        code: 'agent-model-unavailable',
        message: 'AI is temporarily unavailable. Local features still work.',
        retryable: true,
      },
    });
  }
}

export class InMemoryModelAvailability implements ModelAvailability {
  readonly #checks: EmdoModelId[] = [];

  constructor(
    private readonly availability: Readonly<Record<EmdoModelId, boolean>>,
  ) {}

  async isAvailable(model: EmdoModelId): Promise<boolean> {
    this.#checks.push(model);
    return this.availability[model];
  }

  checkedModels(): readonly EmdoModelId[] {
    return Object.freeze([...this.#checks]);
  }
}
