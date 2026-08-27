import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ApiProblem } from './problem.js';

export const EDGE_PROXY_PROOF_HEADER = 'x-emdo-edge-proxy';

/** A base64url token carrying at least 256 bits of deployment-owned entropy. */
export const EdgeProxySecretSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

const ingressUnavailable = (): ApiProblem =>
  new ApiProblem({
    status: 503,
    code: 'authentication-ingress-unavailable',
    title: 'Authentication ingress unavailable',
    detail: 'The request could not be attributed safely.',
  });

const exactHeader = (
  request: FastifyRequest,
  name: string,
  maximumLength: number,
): string | undefined => {
  const value = request.headers[name];
  return typeof value === 'string' && value.length <= maximumLength
    ? value
    : undefined;
};

export const canonicalizeIpAddress = (value: string): string | undefined => {
  const version = isIP(value);
  if (version === 0) return undefined;
  try {
    const host = new URL(
      version === 6 ? `http://[${value}]/` : `http://${value}/`,
    ).hostname;
    return version === 6 ? host.slice(1, -1) : host;
  } catch {
    return undefined;
  }
};

export const isLoopbackIp = (value: string): boolean => {
  const lower = value.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('::ffff:127.') ||
    (isIP(value) === 4 && value.startsWith('127.'))
  );
};

const secretsMatch = (expected: string, provided: string): boolean => {
  const digest = (value: string) =>
    createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(provided));
};

/**
 * Resolve the only address that may cross into provider authentication.
 *
 * Production requires a Caddy-injected proof and one overwritten XFF value.
 * Direct construction is reserved for loopback-only tests and local tooling.
 */
export const resolveTrustedClientIp = (
  request: FastifyRequest,
  edgeProxySecret?: string,
  allowLoopbackApiIngress = false,
): string => {
  const socketIp = canonicalizeIpAddress(request.ip);
  if (socketIp === undefined) throw ingressUnavailable();

  if (
    isLoopbackIp(request.ip) &&
    (edgeProxySecret === undefined || allowLoopbackApiIngress)
  ) {
    return socketIp;
  }
  if (edgeProxySecret === undefined) throw ingressUnavailable();

  const proof = exactHeader(request, EDGE_PROXY_PROOF_HEADER, 128);
  const forwardedFor = exactHeader(request, 'x-forwarded-for', 64);
  if (
    proof === undefined ||
    !secretsMatch(edgeProxySecret, proof) ||
    forwardedFor === undefined ||
    forwardedFor.includes(',') ||
    request.headers.forwarded !== undefined ||
    request.headers['x-real-ip'] !== undefined
  ) {
    throw ingressUnavailable();
  }
  const clientIp = canonicalizeIpAddress(forwardedFor);
  if (clientIp === undefined) throw ingressUnavailable();
  return clientIp;
};
