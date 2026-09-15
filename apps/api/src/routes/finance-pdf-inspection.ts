import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FinancePdfInspectionSchema,
  UploadFinanceBookEvidenceSchema,
  UuidSchema,
  workspaceContextFromLegacyPrincipal,
} from '@emdo/contracts';
import { extractFinancePdfReport } from '@emdo/integrations/finance-documents';
import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  requirePrincipal,
} from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';

export function registerFinancePdfInspectionRoutes(
  app: FastifyInstance,
  services: ApiServices,
) {
  app.get(
    '/api/v2/finance/books/:bookId/evidence/:recordId/pdf-inspection',
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
      const { page } = parseRequest(
        z.strictObject({
          page: z.coerce.number().int().min(1).max(25).default(1),
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
      const original = parseServiceResponse(
        UploadFinanceBookEvidenceSchema,
        await repository.downloadBookEvidence(context, bookId, recordId),
      );
      if (original.format !== 'pdf')
        throw new ApiProblem({
          status: 400,
          code: 'finance-evidence-not-pdf',
          title: 'PDF required',
          detail: 'Select a PDF original for source inspection.',
        });
      const bytes = Buffer.from(original.sourceBase64, 'base64');
      if (
        bytes.length > 2097152 ||
        bytes.toString('base64') !== original.sourceBase64
      )
        throw serviceContractProblem();
      const sourceDigest = createHash('sha256').update(bytes).digest('hex');
      const controller = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableFinished) controller.abort();
      };
      reply.raw.on('close', onClose);
      try {
        const extraction = await extractFinancePdfReport(bytes, {
          signal: controller.signal,
          limits: { maxBytes: 2097152 },
        });
        const current = await requirePrincipal(request, services);
        if (
          current.userId !== principal.userId ||
          current.householdId !== principal.householdId ||
          current.sessionId !== principal.sessionId
        )
          throw new ApiProblem({
            status: 403,
            code: 'finance-inspection-access-changed',
            title: 'Access changed',
            detail:
              'Reload the current workspace before reviewing this document.',
          });
        // Parsing may take seconds. Recheck book permission and immutable original
        // before exposing the result; no stale extraction is cached across readers.
        const rechecked = parseServiceResponse(
          UploadFinanceBookEvidenceSchema,
          await repository.downloadBookEvidence(context, bookId, recordId),
        );
        if (
          rechecked.format !== 'pdf' ||
          rechecked.sourceBase64 !== original.sourceBase64 ||
          rechecked.filename !== original.filename
        )
          throw serviceContractProblem();
        if (controller.signal.aborted)
          throw new ApiProblem({
            status: 408,
            code: 'finance-inspection-aborted',
            title: 'Inspection interrupted',
            detail: 'Retry the document inspection.',
          });
        const parsed = extraction.status === 'unavailable' ? null : extraction;
        const selected = parsed?.pages.find((item) => item.page === page);
        if (parsed && !selected)
          throw new ApiProblem({
            status: 404,
            code: 'finance-pdf-page-not-found',
            title: 'Page not found',
            detail: 'This PDF does not contain the selected page.',
          });
        return reply.send(
          parseServiceResponse(FinancePdfInspectionSchema, {
            bookId,
            evidenceId: recordId,
            filename: original.filename,
            sourceDigest,
            status: extraction.status,
            reason:
              extraction.status === 'unavailable' ? extraction.reason : null,
            totalPages: parsed?.totalPages ?? null,
            pages:
              parsed?.pages.map(
                ({
                  page,
                  width,
                  height,
                  rotation,
                  textStatus,
                  text,
                  spans,
                }) => ({
                  page,
                  width,
                  height,
                  rotation,
                  textStatus,
                  textLength: text.length,
                  spanCount: spans.length,
                }),
              ) ?? [],
            selectedPage: selected
              ? {
                  width: selected.width,
                  height: selected.height,
                  rotation: selected.rotation,
                  viewportTransform: selected.viewportTransform,
                  textStatus: selected.textStatus,
                  page: selected.page,
                  text: selected.text,
                  spans: selected.spans.map((span) => ({
                    ...span,
                    textLength: span.text.length,
                    truncated: false,
                  })),
                }
              : null,
            issues: parsed?.issues ?? [],
          }),
        );
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );
}
