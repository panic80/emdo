import { describe, expect, it } from 'vitest';

import {
  createWorkerHealthResponder,
  loadWorkerHealthConfig,
} from './health.js';

describe('worker health server', () => {
  it('is live while the process runs and ready only after dependencies start', async () => {
    const responder = createWorkerHealthResponder();

    expect(responder.respond({ method: 'GET', url: '/healthz' })).toEqual({
      statusCode: 200,
      headers: expect.objectContaining({ 'cache-control': 'no-store' }),
      body: '{"status":"ok","providers":{"overall":"unknown","email":"unknown","push":"unknown","calendar":"unknown"}}',
    });
    expect(responder.respond({ method: 'GET', url: '/readyz' })).toMatchObject({
      statusCode: 503,
      body: '{"status":"not-ready"}',
    });

    responder.setProviderStatus({
      overall: 'degraded',
      email: 'unavailable',
      push: 'unavailable',
      calendar: 'unavailable',
      blockers: [
        'worker-email-adapter-unavailable',
        'worker-push-adapter-unavailable',
        'worker-calendar-broker-unavailable',
      ],
    });
    responder.setReady(true);
    expect(responder.respond({ method: 'GET', url: '/readyz' })).toMatchObject({
      statusCode: 200,
      body: '{"status":"ready","providers":{"overall":"degraded","email":"unavailable","push":"unavailable","calendar":"unavailable","blockers":["worker-email-adapter-unavailable","worker-push-adapter-unavailable","worker-calendar-broker-unavailable"]}}',
    });

    responder.setReady(false);
    expect(
      responder.respond({ method: 'GET', url: '/readyz' }).statusCode,
    ).toBe(503);
  });

  it('rejects non-GET and unknown routes without reflecting request data', async () => {
    const responder = createWorkerHealthResponder();
    const notFound = responder.respond({
      method: 'GET',
      url: '/secret?token=do-not-reflect',
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.body).not.toContain('do-not-reflect');

    const wrongMethod = responder.respond({
      method: 'POST',
      url: '/healthz',
    });
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.headers.allow).toBe('GET');
  });

  it('loads only bounded deployment host and port values', () => {
    expect(
      loadWorkerHealthConfig({ HEALTH_HOST: '0.0.0.0', HEALTH_PORT: '3001' }),
    ).toEqual({ host: '0.0.0.0', port: 3001 });
    expect(loadWorkerHealthConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3001,
    });

    for (const environment of [
      { HEALTH_HOST: 'localhost' },
      { HEALTH_PORT: '0' },
      { HEALTH_PORT: '3001.5' },
      { HEALTH_PORT: ' 3001' },
      { HEALTH_PORT: '65536' },
    ]) {
      expect(() => loadWorkerHealthConfig(environment)).toThrow(
        'Worker health configuration is invalid',
      );
    }
  });
});
