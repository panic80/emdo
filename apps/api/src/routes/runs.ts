import { Readable } from 'node:stream';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  requirePrincipal,
  readHeader,
} from '../request-context.js';
import { RunEventSchema, RunParamsSchema } from '../schemas.js';
import type { ApiServices } from '../services/contracts.js';

const readCursor = (request: FastifyRequest): number => {
  const raw = readHeader(request, 'last-event-id', 32);
  if (raw === undefined) return 0;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) {
    throw new ApiProblem({
      status: 400,
      code: 'event-cursor-invalid',
      title: 'Invalid event cursor',
      detail: 'Last-Event-ID must be a non-negative event sequence.',
    });
  }
  const cursor = Number(raw);
  if (!Number.isSafeInteger(cursor)) {
    throw new ApiProblem({
      status: 400,
      code: 'event-cursor-invalid',
      title: 'Invalid event cursor',
      detail: 'Last-Event-ID is outside the supported range.',
    });
  }
  return cursor;
};

const serializeEvents = async function* (
  source: AsyncIterable<unknown>,
  runId: string,
  afterSequence: number,
) {
  let lastSequence = afterSequence;
  for await (const candidate of source) {
    const parsed = RunEventSchema.safeParse(candidate);
    if (
      !parsed.success ||
      parsed.data.runId !== runId ||
      parsed.data.sequence <= lastSequence
    ) {
      throw serviceContractProblem();
    }
    lastSequence = parsed.data.sequence;
    const payload = JSON.stringify(parsed.data);
    yield `id: ${parsed.data.sequence}\nevent: ${parsed.data.type}\ndata: ${payload}\n\n`;
  }
};

export const registerRunRoutes = (
  app: FastifyInstance,
  services: ApiServices,
): void => {
  app.get('/api/v1/runs/:id/events', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const { id: runId } = parseRequest(RunParamsSchema, request.params);
    const afterSequence = readCursor(request);
    const abortController = new AbortController();
    reply.raw.once('close', () => abortController.abort());
    const source = await services.runEvents.open({
      runId,
      afterSequence,
      principal,
      requestId: request.id,
      abortSignal: abortController.signal,
    });
    if (
      source === null ||
      typeof source !== 'object' ||
      !(Symbol.asyncIterator in source)
    ) {
      throw serviceContractProblem();
    }
    return reply
      .header('cache-control', 'no-store')
      .header('connection', 'keep-alive')
      .header('x-accel-buffering', 'no')
      .type('text/event-stream; charset=utf-8')
      .send(
        Readable.from(serializeEvents(source, runId, afterSequence), {
          signal: abortController.signal,
        }),
      );
  });
};
