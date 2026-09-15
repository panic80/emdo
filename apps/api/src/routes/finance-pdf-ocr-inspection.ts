import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FinancePdfOcrInspectionSchema,
  UploadFinanceBookEvidenceSchema,
  UuidSchema,
  workspaceContextFromLegacyPrincipal,
} from '@emdo/contracts';
import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  requirePrincipal,
} from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';
export function registerFinancePdfOcrInspectionRoutes(
  app: FastifyInstance,
  services: ApiServices,
) {
  app.get(
    '/api/v2/finance/books/:bookId/evidence/:recordId/pdf-ocr-inspection',
    async (request, reply) => {
      reply.header('cache-control', 'no-store, private');
      const principal = await requirePrincipal(request, services);
      const context = workspaceContextFromLegacyPrincipal(
        principal,
        request.id,
      );
      const { bookId, recordId } = parseRequest(
        z.strictObject({ bookId: UuidSchema, recordId: UuidSchema }),
        request.params,
      );
      const selection = parseRequest(
        z.strictObject({
          standardizationRunId: UuidSchema,
          extractionRevision: z.coerce.number().int().positive().max(3),
        }),
        request.query,
      );
      const repository = services.financeV2;
      if (!repository || !(await repository.checkReady().catch(() => false)))
        throw new ApiProblem({
          status: 503,
          code: 'finance-v2-unavailable',
          title: 'Documents unavailable',
          detail: 'The accounting document service is not ready.',
        });
      const inspection = parseServiceResponse(
        FinancePdfOcrInspectionSchema,
        await repository.readPdfOcrInspection(
          context,
          bookId,
          recordId,
          selection,
        ),
      );
      const original = parseServiceResponse(
        UploadFinanceBookEvidenceSchema,
        await repository.downloadBookEvidence(context, bookId, recordId),
      );
      if (!('sourceBase64' in original) || original.format !== 'pdf')
        throw serviceContractProblem();
      const bytes = Buffer.from(original.sourceBase64, 'base64');
      if (
        bytes.length > 2097152 ||
        bytes.toString('base64') !== original.sourceBase64 ||
        inspection.evidenceId !== recordId ||
        inspection.standardizationRunId !== selection.standardizationRunId ||
        inspection.extractionRevision !== selection.extractionRevision ||
        createHash('sha256').update(bytes).digest('hex') !==
          inspection.sourceDigest
      )
        throw serviceContractProblem();
      return reply.send(inspection);
    },
  );
}
