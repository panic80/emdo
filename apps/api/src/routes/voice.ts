import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { ApiLimits } from '../config.js';
import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  prepareAuthenticatedMutation,
  readHeader,
  takePreparedMutation,
} from '../request-context.js';
import {
  AudioRunClaimSchema,
  RecordingInspectionResultSchema,
  SpeechConfigurationSchema,
  SpeechGatewayResultSchema,
  SpeechRequestSchema,
  TranscriptionGatewayResultSchema,
  TranscriptionQuerySchema,
} from '../schemas.js';
import type {
  ApiServices,
  AudioRunClaim,
  AudioRunKind,
  AuthenticatedPrincipal,
  VoiceGatewaySafeError,
} from '../services/contracts.js';

const AUDIO_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-wav',
]);

const idempotencyConflict = () =>
  new ApiProblem({
    status: 409,
    code: 'audio-idempotency-conflict',
    title: 'Audio request conflict',
    detail: 'The idempotency key is already bound to another audio request.',
  });

const requestInProgress = (retryAfterMs: number) =>
  new ApiProblem({
    status: 409,
    code: 'audio-request-in-progress',
    title: 'Audio request in progress',
    detail: 'An identical audio request is already in progress.',
    extensions: { retryAfterMs },
  });

const audioCannotReplay = () =>
  new ApiProblem({
    status: 409,
    code: 'speech-audio-not-replayable',
    title: 'Speech audio cannot be replayed',
    detail:
      'Generated speech is ephemeral. Start a new explicit speech request to generate it again.',
  });

const audioRequestIndeterminate = () =>
  new ApiProblem({
    status: 409,
    code: 'audio-request-indeterminate',
    title: 'Audio request needs review',
    detail:
      'The earlier provider outcome is uncertain. Do not retry this request until it is reconciled.',
  });

const voiceFailureProblem = (safeError: VoiceGatewaySafeError) => {
  const status =
    safeError.code === 'ai-spend-limit-reached'
      ? 429
      : safeError.code === 'audio-request-invalid'
        ? 400
        : safeError.code === 'audio-provider-unavailable'
          ? 503
          : 502;
  return new ApiProblem({
    status,
    code: safeError.code,
    title:
      safeError.code === 'ai-spend-limit-reached'
        ? 'AI spend limit reached'
        : safeError.code === 'audio-request-invalid'
          ? 'Audio request invalid'
          : 'Audio service unavailable',
    detail: safeError.message,
    extensions: { retryable: safeError.retryable },
  });
};

const requestFingerprint = (value: Readonly<Record<string, unknown>>) =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

const transcriptionModelForAttempt = (attempt: 'default' | 'accuracy-retry') =>
  attempt === 'accuracy-retry'
    ? ('gpt-4o-transcribe' as const)
    : ('gpt-4o-mini-transcribe' as const);

const setEphemeralAudioHeaders = (reply: {
  header(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
}) => {
  reply.header('cache-control', 'no-store, private');
  reply.header('pragma', 'no-cache');
  reply.header('expires', '0');
  reply.header('x-content-type-options', 'nosniff');
  reply.removeHeader('etag');
};

const claimAudioRequest = async (input: {
  readonly services: ApiServices;
  readonly kind: AudioRunKind;
  readonly model: string;
  readonly inputUnits: number;
  readonly requestFingerprint: string;
  readonly principal: AuthenticatedPrincipal;
  readonly requestId: string;
  readonly idempotencyKey: string;
}): Promise<
  Extract<AudioRunClaim, { readonly status: 'claimed' | 'replay' }>
> => {
  const claim = parseServiceResponse(
    AudioRunClaimSchema,
    await input.services.audioRequests.claim({
      kind: input.kind,
      model: input.model,
      inputUnits: input.inputUnits,
      requestFingerprint: input.requestFingerprint,
      principal: input.principal,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
    }),
  );
  if (claim.status === 'conflict') throw idempotencyConflict();
  if (claim.status === 'in-progress') {
    throw requestInProgress(claim.retryAfterMs);
  }
  if (claim.status === 'completed-nonreplayable') throw audioCannotReplay();
  if (claim.status === 'indeterminate') throw audioRequestIndeterminate();
  return claim as Extract<
    AudioRunClaim,
    { readonly status: 'claimed' | 'replay' }
  >;
};

const markClaimIndeterminate = async (
  services: ApiServices,
  claim: Extract<AudioRunClaim, { readonly status: 'claimed' }>,
  principal: AuthenticatedPrincipal,
  requestId: string,
  reasonCode:
    | 'transcription-provider-state-unknown'
    | 'speech-provider-state-unknown'
    | 'transcription-settlement-state-unknown'
    | 'speech-settlement-state-unknown',
): Promise<boolean> => {
  try {
    await services.audioRequests.markIndeterminate({
      claimId: claim.claimId,
      ownershipToken: claim.ownershipToken,
      reasonCode,
      principal,
      requestId,
    });
    return true;
  } catch {
    return false;
  }
};

const releaseClaimKnownNoDispatch = async (
  services: ApiServices,
  claim: Extract<AudioRunClaim, { readonly status: 'claimed' }>,
  principal: AuthenticatedPrincipal,
  requestId: string,
  reasonCode:
    'transcription-provider-not-dispatched' | 'speech-provider-not-dispatched',
): Promise<boolean> => {
  try {
    await services.audioRequests.releaseKnownNoDispatch({
      claimId: claim.claimId,
      ownershipToken: claim.ownershipToken,
      reasonCode,
      principal,
      requestId,
    });
    return true;
  } catch {
    return false;
  }
};

export const registerVoiceRoutes = (
  app: FastifyInstance,
  services: ApiServices,
  limits: ApiLimits,
): void => {
  const authenticateBeforeBody = async (request: FastifyRequest) =>
    prepareAuthenticatedMutation(request, services);

  app.post(
    '/api/v1/voice/transcribe',
    {
      bodyLimit: limits.maximumAudioBytes,
      onRequest: authenticateBeforeBody,
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const audio = Buffer.isBuffer(request.body)
        ? new Uint8Array(
            request.body.buffer,
            request.body.byteOffset,
            request.body.byteLength,
          )
        : undefined;
      try {
        const { durationMs, attempt } = parseRequest(
          TranscriptionQuerySchema,
          request.query,
        );
        const model = transcriptionModelForAttempt(attempt);
        const rawContentType = readHeader(request, 'content-type', 256);
        const contentType = rawContentType
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase();
        if (
          contentType === undefined ||
          !AUDIO_CONTENT_TYPES.has(contentType)
        ) {
          throw new ApiProblem({
            status: 415,
            code: 'unsupported-audio-type',
            title: 'Unsupported audio type',
            detail: 'Use a supported audio recording format.',
          });
        }
        if (audio === undefined || audio.byteLength === 0) {
          throw new ApiProblem({
            status: 400,
            code: 'audio-body-required',
            title: 'Audio required',
            detail: 'A non-empty audio recording is required.',
          });
        }
        let inspection: z.infer<typeof RecordingInspectionResultSchema>;
        let receiptTransitioned = false;
        try {
          inspection = parseServiceResponse(
            RecordingInspectionResultSchema,
            await services.voice.inspectRecording({
              audio,
              declaredContentType: contentType,
              durationHintMs: durationMs,
              maximumDurationMs: 60_000,
            }),
          );
        } catch (error) {
          if (error instanceof ApiProblem) throw error;
          throw new ApiProblem({
            status: 503,
            code: 'audio-inspector-unavailable',
            title: 'Audio inspection unavailable',
            detail: 'The recording could not be verified safely.',
          });
        }
        if (inspection.status === 'rejected') {
          throw new ApiProblem({
            status:
              inspection.code === 'audio-inspector-unavailable' ? 503 : 400,
            code: inspection.code,
            title:
              inspection.code === 'audio-inspector-unavailable'
                ? 'Audio inspection unavailable'
                : 'Audio recording invalid',
            detail:
              inspection.code === 'audio-inspector-unavailable'
                ? 'The recording could not be verified safely.'
                : 'The recording container or duration is invalid.',
          });
        }
        const audioSha256 = createHash('sha256').update(audio).digest('hex');
        const claim = await claimAudioRequest({
          services,
          kind: 'transcription',
          model,
          inputUnits: audio.byteLength,
          requestFingerprint: requestFingerprint({
            kind: 'transcription',
            model,
            attempt,
            durationMs: inspection.durationMs,
            contentType: inspection.verifiedContentType,
            audioSha256,
          }),
          principal,
          requestId: request.id,
          idempotencyKey,
        });
        if (claim.status === 'replay') {
          if (claim.result.model !== model) throw serviceContractProblem();
          setEphemeralAudioHeaders(reply);
          return reply
            .header('pragma', 'no-cache')
            .header('x-emdo-spend-warning', String(claim.result.spendWarning))
            .header('x-emdo-idempotent-replay', 'true')
            .send({
              schemaVersion: 1,
              transcript: claim.result.transcript,
              model: claim.result.model,
              attempt,
              spendWarning: claim.result.spendWarning,
              replayed: true,
            });
        }

        try {
          const result = parseServiceResponse(
            TranscriptionGatewayResultSchema,
            await services.voice.transcribe({
              audio,
              contentType: inspection.verifiedContentType,
              durationMs: inspection.durationMs,
              attempt,
              model,
              principal,
              requestId: request.id,
              executionId: claim.executionId,
              reservationId: claim.reservationId,
            }),
          );
          if (result.status === 'failed') {
            receiptTransitioned = true;
            if (result.reconciliationRequired) {
              const marked = await markClaimIndeterminate(
                services,
                claim,
                principal,
                request.id,
                'transcription-provider-state-unknown',
              );
              if (!marked) throw audioRequestIndeterminate();
            } else {
              const released = await releaseClaimKnownNoDispatch(
                services,
                claim,
                principal,
                request.id,
                'transcription-provider-not-dispatched',
              );
              if (!released) {
                await markClaimIndeterminate(
                  services,
                  claim,
                  principal,
                  request.id,
                  'transcription-settlement-state-unknown',
                );
                throw audioRequestIndeterminate();
              }
            }
            throw voiceFailureProblem(result.safeError);
          }
          if (result.model !== model) throw serviceContractProblem();
          try {
            await services.audioRequests.completeTranscription({
              claimId: claim.claimId,
              ownershipToken: claim.ownershipToken,
              transcript: result.transcript,
              model: result.model,
              spendWarning: result.spendWarning,
              principal,
              requestId: request.id,
            });
          } catch {
            receiptTransitioned = true;
            await markClaimIndeterminate(
              services,
              claim,
              principal,
              request.id,
              'transcription-settlement-state-unknown',
            );
            throw audioRequestIndeterminate();
          }
          receiptTransitioned = true;
          setEphemeralAudioHeaders(reply);
          return reply
            .header('pragma', 'no-cache')
            .header('x-emdo-spend-warning', String(result.spendWarning))
            .header('x-emdo-idempotent-replay', 'false')
            .send({
              schemaVersion: 1,
              transcript: result.transcript,
              model: result.model,
              attempt,
              spendWarning: result.spendWarning,
              replayed: false,
            });
        } catch (error) {
          if (!receiptTransitioned) {
            receiptTransitioned = true;
            await markClaimIndeterminate(
              services,
              claim,
              principal,
              request.id,
              'transcription-settlement-state-unknown',
            );
            throw audioRequestIndeterminate();
          }
          throw error;
        }
      } finally {
        audio?.fill(0);
      }
    },
  );

  app.post(
    '/api/v1/voice/speak',
    {
      bodyLimit: limits.maximumJsonBodyBytes,
      onRequest: authenticateBeforeBody,
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const input = parseRequest(SpeechRequestSchema, request.body);
      if (input.text.length > limits.maximumSpeechCharacters) {
        throw new ApiProblem({
          status: 400,
          code: 'speech-text-too-long',
          title: 'Speech text too long',
          detail: 'The speech text exceeds the configured character limit.',
        });
      }
      const speechConfiguration = parseServiceResponse(
        SpeechConfigurationSchema,
        await services.voice.getSpeechConfiguration(),
      );
      const claim = await claimAudioRequest({
        services,
        kind: 'speech',
        model: speechConfiguration.model,
        inputUnits: input.text.length,
        requestFingerprint: requestFingerprint({
          kind: 'speech',
          model: speechConfiguration.model,
          configurationVersion: speechConfiguration.configurationVersion,
          voice: input.voice,
          text: input.text,
        }),
        principal,
        requestId: request.id,
        idempotencyKey,
      });
      if (claim.status === 'replay') throw serviceContractProblem();

      let ownedProviderAudio: Uint8Array | undefined;
      let responseAudio: Buffer | undefined;
      let responseMetadata:
        | {
            readonly contentType: 'audio/mpeg' | 'audio/ogg' | 'audio/wav';
            readonly model: string;
            readonly spendWarning: boolean;
          }
        | undefined;
      let receiptTransitioned = false;
      try {
        try {
          const rawResult = await services.voice.speak({
            text: input.text,
            voice: input.voice,
            principal,
            requestId: request.id,
            executionId: claim.executionId,
            reservationId: claim.reservationId,
          });
          if (rawResult !== null && typeof rawResult === 'object') {
            const descriptor = Object.getOwnPropertyDescriptor(
              rawResult,
              'audio',
            );
            if (descriptor?.value instanceof Uint8Array) {
              ownedProviderAudio = descriptor.value;
            }
          }
          const result = parseServiceResponse(
            SpeechGatewayResultSchema,
            rawResult,
          );
          if (result.status === 'failed') {
            receiptTransitioned = true;
            if (result.reconciliationRequired) {
              const marked = await markClaimIndeterminate(
                services,
                claim,
                principal,
                request.id,
                'speech-provider-state-unknown',
              );
              if (!marked) throw audioRequestIndeterminate();
            } else {
              const released = await releaseClaimKnownNoDispatch(
                services,
                claim,
                principal,
                request.id,
                'speech-provider-not-dispatched',
              );
              if (!released) {
                await markClaimIndeterminate(
                  services,
                  claim,
                  principal,
                  request.id,
                  'speech-settlement-state-unknown',
                );
                throw audioRequestIndeterminate();
              }
            }
            throw voiceFailureProblem(result.safeError);
          }
          ownedProviderAudio = result.audio;
          if (result.model !== speechConfiguration.model) {
            throw serviceContractProblem();
          }
          if (result.audio.byteLength > limits.maximumAudioBytes) {
            throw serviceContractProblem();
          }
          try {
            await services.audioRequests.completeSpeech({
              claimId: claim.claimId,
              ownershipToken: claim.ownershipToken,
              model: result.model,
              contentType: result.contentType,
              principal,
              requestId: request.id,
            });
          } catch {
            receiptTransitioned = true;
            await markClaimIndeterminate(
              services,
              claim,
              principal,
              request.id,
              'speech-settlement-state-unknown',
            );
            throw audioRequestIndeterminate();
          }
          receiptTransitioned = true;
          responseAudio = Buffer.from(result.audio);
          responseMetadata = Object.freeze({
            contentType: result.contentType,
            model: result.model,
            spendWarning: result.spendWarning,
          });
        } catch (error) {
          if (!receiptTransitioned) {
            receiptTransitioned = true;
            await markClaimIndeterminate(
              services,
              claim,
              principal,
              request.id,
              'speech-settlement-state-unknown',
            );
            throw audioRequestIndeterminate();
          }
          throw error;
        }
      } finally {
        ownedProviderAudio?.fill(0);
      }

      if (responseAudio === undefined || responseMetadata === undefined) {
        responseAudio?.fill(0);
        throw serviceContractProblem();
      }
      let responseAudioWiped = false;
      const wipeResponseAudio = () => {
        if (responseAudioWiped) return;
        responseAudioWiped = true;
        responseAudio.fill(0);
      };
      reply.raw.once('finish', wipeResponseAudio);
      reply.raw.once('close', wipeResponseAudio);
      reply.raw.once('error', wipeResponseAudio);
      setEphemeralAudioHeaders(reply);
      return reply
        .header('pragma', 'no-cache')
        .header('x-emdo-spend-warning', String(responseMetadata.spendWarning))
        .header('x-emdo-idempotent-replay', 'false')
        .header('x-emdo-audio-model', responseMetadata.model)
        .type(responseMetadata.contentType)
        .send(responseAudio);
    },
  );
};
