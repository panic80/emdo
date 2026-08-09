import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const safeEqual = (left: string, right: string) => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

export class CsrfProtector {
  private readonly trustedOrigins: ReadonlySet<string>;
  private readonly secret: Uint8Array;

  constructor(options: {
    readonly secret: Uint8Array;
    readonly trustedOrigins: readonly string[];
  }) {
    if (options.secret.byteLength < 32)
      throw new Error('CSRF secret is too short');
    this.secret = Uint8Array.from(options.secret);
    this.trustedOrigins = new Set(
      options.trustedOrigins.map((origin) => {
        const url = new URL(origin);
        if (
          url.origin !== origin ||
          (url.protocol !== 'https:' && url.hostname !== 'localhost')
        ) {
          throw new Error('Trusted origins must be exact HTTPS origins');
        }
        return url.origin;
      }),
    );
  }

  issue(sessionId: string) {
    if (sessionId.length === 0) throw new Error('Session id is required');
    const nonce = randomBytes(24).toString('base64url');
    return `${nonce}.${this.signature(sessionId, nonce)}`;
  }

  verify(input: {
    readonly sessionId: string;
    readonly origin: string;
    readonly cookieToken: string;
    readonly headerToken: string;
  }) {
    if (
      input.sessionId.length === 0 ||
      input.cookieToken.length > 256 ||
      input.headerToken.length > 256
    ) {
      return false;
    }
    let origin: string;
    try {
      origin = new URL(input.origin).origin;
    } catch {
      return false;
    }
    if (origin !== input.origin || !this.trustedOrigins.has(origin))
      return false;
    if (!safeEqual(input.cookieToken, input.headerToken)) return false;
    const [nonce, signature, extra] = input.headerToken.split('.');
    if (nonce === undefined || signature === undefined || extra !== undefined)
      return false;
    if (!/^[A-Za-z0-9_-]{32}$/.test(nonce)) return false;
    return safeEqual(signature, this.signature(input.sessionId, nonce));
  }

  private signature(sessionId: string, nonce: string) {
    return createHmac('sha256', this.secret)
      .update(`${sessionId}.${nonce}`)
      .digest('base64url');
  }
}
