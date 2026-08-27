import { Readable } from 'node:stream';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { OpaqueReferenceSchema, UuidSchema } from '@emdo/contracts';
import {
  FINANCE_DOCUMENT_LIMITS,
  FinanceDocumentDetailSchema,
  FinanceDocumentEvidenceListSchema,
  FinanceDocumentListSchema,
  FinanceDocumentMatchDecisionSchema,
  FinanceDocumentMatchListSchema,
  FinanceDocumentReviewCommitSchema,
  FinanceDocumentReviewDraftSchema,
  FinanceDocumentReviewPatchSchema,
  FinanceDocumentStateSchema,
  FinanceDocumentSummarySchema,
  FinanceDocumentMimeTypeSchema,
  FinanceDocumentTypeSchema,
} from '@emdo/domains/finance';

import { ApiProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  prepareAuthenticatedMutation,
  requirePrincipal,
  takePreparedMutation,
} from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';

const DocumentParamsSchema = z.strictObject({ id: UuidSchema });
const MatchParamsSchema = z.strictObject({ id: UuidSchema });
const EvidenceParamsSchema = z.strictObject({ id: UuidSchema });
const DocumentListQuerySchema = z.strictObject({
  cursor: OpaqueReferenceSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  state: FinanceDocumentStateSchema.optional(),
  documentType: FinanceDocumentTypeSchema.optional(),
});

const privateNoStore = (reply: {
  header(name: string, value: string): unknown;
}) => reply.header('cache-control', 'no-store, private');

const financeDocumentProblem = (error: unknown): ApiProblem | undefined => {
  const code =
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : undefined;
  if (
    code === 'FST_FILES_LIMIT' ||
    code === 'FST_PARTS_LIMIT' ||
    code === 'FST_FIELDS_LIMIT' ||
    code === 'FST_STREAM_PREMATURE_CLOSE' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE'
  ) {
    return new ApiProblem({
      status: 400,
      code: 'invalid-input',
      title: 'Exactly one finance document is required',
      detail: 'Send exactly one file in the file field and no other parts.',
    });
  }
  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return new ApiProblem({
      status: 413,
      code: 'finance-document-too-large',
      title: 'Finance document is too large',
      detail: 'Each finance document must be 25 MB or smaller.',
    });
  }
  const known: Readonly<Record<string, { status: number; title: string }>> = {
    'authorization-revoked': {
      status: 403,
      title: 'Finance document authority unavailable',
    },
    'document-not-found': { status: 404, title: 'Finance document not found' },
    'evidence-not-found': { status: 404, title: 'Finance evidence not found' },
    'match-not-found': { status: 404, title: 'Finance match not found' },
    'duplicate-document': { status: 409, title: 'Duplicate finance document' },
    'document-state-conflict': {
      status: 409,
      title: 'Finance document state changed',
    },
    'review-token-invalid': { status: 409, title: 'Finance review changed' },
    'review-token-expired': { status: 409, title: 'Finance review expired' },
    'idempotency-conflict': {
      status: 409,
      title: 'Finance document request conflict',
    },
    'quota-exceeded': { status: 413, title: 'Finance document quota reached' },
    'invalid-input': { status: 400, title: 'Invalid finance document request' },
    'approval-required': {
      status: 409,
      title: 'EMDO confirmation required',
    },
  };
  const mapped = code === undefined ? undefined : known[code];
  return mapped === undefined
    ? undefined
    : new ApiProblem({
        status: mapped.status,
        code: code!,
        title: mapped.title,
        detail: 'The finance document operation could not be completed safely.',
      });
};

const invoke = async <Result>(operation: () => Promise<Result>) => {
  try {
    return await operation();
  } catch (error) {
    throw financeDocumentProblem(error) ?? error;
  }
};

const requireEmdoConfirmation = (detail: string): never => {
  throw new ApiProblem({
    status: 409,
    code: 'approval-required',
    title: 'EMDO confirmation required',
    detail,
  });
};

const requirePrivatePrincipal = async (
  request: FastifyRequest,
  services: ApiServices,
) => {
  const principal = await requirePrincipal(request, services);
  if (principal.privateSpaceId === undefined) {
    throw new ApiProblem({
      status: 403,
      code: 'authorization-revoked',
      title: 'Finance document authority unavailable',
      detail: 'A current private-space authorization is required.',
    });
  }
  return principal;
};

const boundedUploadSource = (
  file: NodeJS.ReadableStream &
    AsyncIterable<Buffer> & { readonly truncated?: boolean },
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for await (const chunk of file) {
      if (!(chunk instanceof Uint8Array)) {
        throw new ApiProblem({
          status: 400,
          code: 'invalid-input',
          title: 'Invalid finance document upload',
          detail: 'The uploaded file stream is invalid.',
        });
      }
      yield chunk;
    }
    if (file.truncated === true) {
      throw new ApiProblem({
        status: 413,
        code: 'finance-document-too-large',
        title: 'Finance document is too large',
        detail: 'Each finance document must be 25 MB or smaller.',
      });
    }
  },
});

const safeAttachmentName = (value: string): string =>
  value.replace(/[\p{Cc}\p{Cf}"\\/]/gu, '_').slice(0, 255) ||
  'finance-document';

const multipartProblem = (app: FastifyInstance, error: unknown): ApiProblem => {
  const code =
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : undefined;
  if (
    error instanceof app.multipartErrors.FilesLimitError ||
    error instanceof app.multipartErrors.PartsLimitError ||
    error instanceof app.multipartErrors.FieldsLimitError ||
    code === 'FST_FILES_LIMIT' ||
    code === 'FST_PARTS_LIMIT' ||
    code === 'FST_FIELDS_LIMIT' ||
    code === 'FST_STREAM_PREMATURE_CLOSE' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE'
  ) {
    return new ApiProblem({
      status: 400,
      code: 'invalid-input',
      title: 'Exactly one finance document is required',
      detail: 'Send exactly one file in the file field and no other parts.',
    });
  }
  if (
    error instanceof app.multipartErrors.RequestFileTooLargeError ||
    code === 'FST_REQ_FILE_TOO_LARGE'
  ) {
    return new ApiProblem({
      status: 413,
      code: 'finance-document-too-large',
      title: 'Finance document is too large',
      detail: 'Each finance document must be 25 MB or smaller.',
    });
  }
  if (error instanceof app.multipartErrors.InvalidMultipartContentTypeError) {
    return new ApiProblem({
      status: 415,
      code: 'unsupported-media-type',
      title: 'Multipart finance document required',
      detail: 'Send the finance document as multipart form data.',
    });
  }
  throw error;
};

export const registerFinanceDocumentRoutes = (
  app: FastifyInstance,
  services: ApiServices,
): void => {
  app.post(
    '/api/v1/finance/documents',
    { onRequest: (request) => prepareAuthenticatedMutation(request, services) },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      if (principal.privateSpaceId === undefined) {
        throw financeDocumentProblem({ code: 'authorization-revoked' });
      }
      const part = await request
        .file({
          limits: {
            files: 1,
            fields: 0,
            parts: 1,
            fileSize: FINANCE_DOCUMENT_LIMITS.maximumBytesPerFile,
          },
        })
        .catch((error: unknown) => {
          throw multipartProblem(app, error);
        });
      if (part === undefined || part.fieldname !== 'file') {
        throw new ApiProblem({
          status: 400,
          code: 'invalid-input',
          title: 'Finance document file required',
          detail: 'Send exactly one file in the file field.',
        });
      }
      const declaredMimeType = FinanceDocumentMimeTypeSchema.safeParse(
        part.mimetype,
      );
      if (!declaredMimeType.success) {
        part.file.resume();
        throw new ApiProblem({
          status: 415,
          code: 'unsupported-media-type',
          title: 'Unsupported finance document type',
          detail: 'Finance documents must be PDF, JPEG, or PNG files.',
        });
      }
      const result = parseServiceResponse(
        FinanceDocumentSummarySchema,
        await invoke(() =>
          services.financeDocuments.upload({
            displayName: part.filename,
            declaredMimeType: declaredMimeType.data,
            source: boundedUploadSource(part.file),
            idempotencyKey,
            principal,
            requestId: request.id,
          }),
        ),
      );
      return (privateNoStore(reply), reply.code(201).send(result));
    },
  );

  app.get('/api/v1/finance/documents', async (request, reply) => {
    const principal = await requirePrivatePrincipal(request, services);
    const query = parseRequest(DocumentListQuerySchema, request.query);
    const result = parseServiceResponse(
      FinanceDocumentListSchema,
      await invoke(() =>
        services.financeDocuments.list({
          ...query,
          principal,
          requestId: request.id,
        }),
      ),
    );
    return (privateNoStore(reply), reply.send(result));
  });

  app.get('/api/v1/finance/documents/:id', async (request, reply) => {
    const principal = await requirePrivatePrincipal(request, services);
    const { id } = parseRequest(DocumentParamsSchema, request.params);
    const result = parseServiceResponse(
      FinanceDocumentDetailSchema,
      await invoke(() =>
        services.financeDocuments.get({
          documentId: id,
          principal,
          requestId: request.id,
        }),
      ),
    );
    return (privateNoStore(reply), reply.send(result));
  });

  app.get('/api/v1/finance/documents/:id/original', async (request, reply) => {
    const principal = await requirePrivatePrincipal(request, services);
    const { id } = parseRequest(DocumentParamsSchema, request.params);
    const original = await invoke(() =>
      services.financeDocuments.downloadOriginal({
        documentId: id,
        principal,
        requestId: request.id,
      }),
    );
    const name = safeAttachmentName(original.displayName);
    reply.header('cache-control', 'no-store, private');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-type', original.mimeType);
    reply.header('content-length', String(original.byteSize));
    reply.header(
      'content-disposition',
      `attachment; filename="finance-document"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    return reply.send(Readable.from(original.body));
  });

  app.post(
    '/api/v1/finance/documents/:id/retry',
    { onRequest: (request) => prepareAuthenticatedMutation(request, services) },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const { id } = parseRequest(DocumentParamsSchema, request.params);
      const result = parseServiceResponse(
        FinanceDocumentDetailSchema,
        await invoke(() =>
          services.financeDocuments.retry({
            documentId: id,
            idempotencyKey,
            principal,
            requestId: request.id,
          }),
        ),
      );
      return (privateNoStore(reply), reply.code(202).send(result));
    },
  );

  app.get('/api/v1/finance/documents/:id/review', async (request, reply) => {
    const principal = await requirePrivatePrincipal(request, services);
    const { id } = parseRequest(DocumentParamsSchema, request.params);
    const result = parseServiceResponse(
      FinanceDocumentReviewDraftSchema,
      await invoke(() =>
        services.financeDocuments.getReview({
          documentId: id,
          principal,
          requestId: request.id,
        }),
      ),
    );
    return (privateNoStore(reply), reply.send(result));
  });

  app.patch(
    '/api/v1/finance/documents/:id/review',
    { onRequest: (request) => prepareAuthenticatedMutation(request, services) },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const { id } = parseRequest(DocumentParamsSchema, request.params);
      const body = parseRequest(FinanceDocumentReviewPatchSchema, request.body);
      const result = parseServiceResponse(
        FinanceDocumentReviewDraftSchema,
        await invoke(() =>
          services.financeDocuments.updateReview({
            documentId: id,
            expectedExtractionRevision: body.expectedExtractionRevision,
            envelope: body.envelope,
            idempotencyKey,
            principal,
            requestId: request.id,
          }),
        ),
      );
      return (privateNoStore(reply), reply.send(result));
    },
  );

  app.post(
    '/api/v1/finance/documents/:id/review/commit',
    { onRequest: (request) => prepareAuthenticatedMutation(request, services) },
    async (request) => {
      takePreparedMutation(request);
      parseRequest(DocumentParamsSchema, request.params);
      parseRequest(FinanceDocumentReviewCommitSchema, request.body);
      return requireEmdoConfirmation(
        'Ask EMDO to confirm this reviewed document before committing it.',
      );
    },
  );

  app.get('/api/v1/finance/documents/:id/matches', async (request, reply) => {
    const principal = await requirePrivatePrincipal(request, services);
    const { id } = parseRequest(DocumentParamsSchema, request.params);
    const result = parseServiceResponse(
      FinanceDocumentMatchListSchema,
      await invoke(() =>
        services.financeDocuments.listMatches({
          documentId: id,
          principal,
          requestId: request.id,
        }),
      ),
    );
    return (privateNoStore(reply), reply.send(result));
  });

  app.post(
    '/api/v1/finance/matches/:id/decision',
    { onRequest: (request) => prepareAuthenticatedMutation(request, services) },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const { id } = parseRequest(MatchParamsSchema, request.params);
      const body = parseRequest(
        FinanceDocumentMatchDecisionSchema,
        request.body,
      );
      if (body.decision === 'accept') {
        return requireEmdoConfirmation(
          'Ask EMDO to confirm this suggested finance match before accepting it.',
        );
      }
      const result = parseServiceResponse(
        FinanceDocumentMatchListSchema,
        await invoke(() =>
          services.financeDocuments.decideMatch({
            matchId: id,
            decision: body.decision,
            reviewToken: body.reviewToken,
            idempotencyKey,
            principal,
            requestId: request.id,
          }),
        ),
      );
      return (privateNoStore(reply), reply.send(result));
    },
  );

  app.get('/api/v1/finance/evidence/:id', async (request, reply) => {
    const principal = await requirePrivatePrincipal(request, services);
    const { id } = parseRequest(EvidenceParamsSchema, request.params);
    const result = parseServiceResponse(
      FinanceDocumentEvidenceListSchema,
      await invoke(() =>
        services.financeDocuments.getEvidence({
          evidenceId: id,
          principal,
          requestId: request.id,
        }),
      ),
    );
    return (privateNoStore(reply), reply.send(result));
  });

  app.delete(
    '/api/v1/finance/documents/:id',
    { onRequest: (request) => prepareAuthenticatedMutation(request, services) },
    async (request) => {
      takePreparedMutation(request);
      parseRequest(DocumentParamsSchema, request.params);
      return requireEmdoConfirmation(
        'Ask EMDO to confirm this finance document deletion.',
      );
    },
  );
};
