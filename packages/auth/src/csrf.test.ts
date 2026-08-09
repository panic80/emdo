import { describe, expect, it } from 'vitest';

import { CsrfProtector } from './csrf.js';

describe('CsrfProtector', () => {
  it('requires an exact origin and session-bound double-submit token', () => {
    const protector = new CsrfProtector({
      secret: Buffer.alloc(32, 7),
      trustedOrigins: ['https://emdo.example'],
    });
    const token = protector.issue('session-a');

    expect(
      protector.verify({
        sessionId: 'session-a',
        origin: 'https://emdo.example',
        cookieToken: token,
        headerToken: token,
      }),
    ).toBe(true);
    expect(
      protector.verify({
        sessionId: 'session-b',
        origin: 'https://emdo.example',
        cookieToken: token,
        headerToken: token,
      }),
    ).toBe(false);
    expect(
      protector.verify({
        sessionId: 'session-a',
        origin: 'https://emdo.example.evil.test',
        cookieToken: token,
        headerToken: token,
      }),
    ).toBe(false);
  });
});
