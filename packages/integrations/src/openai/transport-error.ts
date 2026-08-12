export type OpenAiAudioTransportErrorKind =
  | 'invalid-request'
  | 'credential-unavailable'
  | 'request-aborted'
  | 'timeout'
  | 'network'
  | 'provider-rejected'
  | 'provider-unavailable'
  | 'response-too-large'
  | 'response-invalid';

export class OpenAiAudioTransportError extends Error {
  readonly kind: OpenAiAudioTransportErrorKind;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly providerRequestId?: string;

  constructor(input: {
    readonly kind: OpenAiAudioTransportErrorKind;
    readonly httpStatus?: number;
    readonly retryable: boolean;
    readonly providerRequestId?: string;
  }) {
    super('OpenAI audio transport failed.');
    this.name = 'OpenAiAudioTransportError';
    this.kind = input.kind;
    this.httpStatus = input.httpStatus;
    this.retryable = input.retryable;
    this.providerRequestId = input.providerRequestId;
    Object.freeze(this);
  }
}
