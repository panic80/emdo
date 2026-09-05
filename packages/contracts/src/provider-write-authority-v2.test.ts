import { describe, expect, it } from 'vitest';

import {
  EffectiveAuthorizationScopeFingerprintSchema,
  ProviderWriteAuthorityBindingSchema,
  ProviderWriteOperationScopeSchema,
  TrustedProviderWriteAuthorityResolutionSchema,
  type CapabilityInvocationContext,
  type ProviderWriteCapabilityContext,
} from './index.js';

const ids = {
  request: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f501',
  session: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f502',
  household: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f503',
  user: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f504',
  privateSpace: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f505',
  run: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f506',
  currentSpaceGrant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f507',
} as const;

const fingerprint = EffectiveAuthorizationScopeFingerprintSchema.parse(
  'f'.repeat(64),
);

const authority = {
  kind: 'google-calendar-grant-v2',
  householdId: ids.household,
  privateSpaceId: ids.privateSpace,
  authorizationScopeFingerprint: fingerprint,
  providerGrantReference: 'google-grant-reference-v2',
  authorizationEpoch: 7,
} as const;

const operationScope = {
  requestId: ids.request,
  sessionId: ids.session,
  householdId: ids.household,
  userId: ids.user,
  spaceAccessGrantId: ids.currentSpaceGrant,
  authorizationScopeFingerprint: fingerprint,
} as const;

const assertInvocationIdentityIsRequired = (abortSignal: AbortSignal): void => {
  const valid: CapabilityInvocationContext = {
    requestId: ids.request,
    runId: ids.run,
    sessionId: ids.session,
    householdId: ids.household,
    userId: ids.user,
    agentId: 'scheduler',
    locale: 'en-CA',
    spaceAccessGrantId: operationScope.spaceAccessGrantId,
    abortSignal,
  };

  // @ts-expect-error Trusted capability invocation must carry the current session.
  const missingSession: CapabilityInvocationContext = {
    requestId: ids.request,
    runId: ids.run,
    householdId: ids.household,
    userId: ids.user,
    agentId: 'scheduler',
    spaceAccessGrantId: operationScope.spaceAccessGrantId,
    abortSignal,
  };
  // @ts-expect-error Trusted capability invocation must carry the current household.
  const missingHousehold: CapabilityInvocationContext = {
    requestId: ids.request,
    runId: ids.run,
    sessionId: ids.session,
    userId: ids.user,
    agentId: 'scheduler',
    spaceAccessGrantId: operationScope.spaceAccessGrantId,
    abortSignal,
  };

  void valid;
  void missingSession;
  void missingHousehold;
};

void assertInvocationIdentityIsRequired;

const assertProviderWriteContextCarriesFreshScope = (
  context: ProviderWriteCapabilityContext,
): void => {
  const fingerprint: typeof context.providerWriteOperationScope.authorizationScopeFingerprint =
    context.providerWritePermit.approvalBinding.authorityBinding
      .authorizationScopeFingerprint;
  void fingerprint;
};

void assertProviderWriteContextCarriesFreshScope;

describe('provider-write authority v2 contracts', () => {
  it('keeps rotating request/grant lineage outside the immutable authority', () => {
    const parsed = ProviderWriteAuthorityBindingSchema.parse(authority);

    expect(parsed).toEqual(authority);
    expect(parsed).not.toHaveProperty('spaceAccessGrantId');
    expect(() =>
      ProviderWriteAuthorityBindingSchema.parse({
        ...authority,
        spaceAccessGrantId: operationScope.spaceAccessGrantId,
      }),
    ).toThrow();
    expect(() =>
      ProviderWriteAuthorityBindingSchema.parse({
        ...authority,
        kind: 'google-calendar-grant-v1',
      }),
    ).toThrow();
  });

  it('binds a current operation sidecar to the same stable authority fingerprint', () => {
    const parsed = TrustedProviderWriteAuthorityResolutionSchema.parse({
      authorityBinding: authority,
      operationScope,
    });

    expect(parsed.operationScope).toEqual(operationScope);
    expect(Object.isFrozen(parsed.operationScope)).toBe(true);
    expect(() =>
      TrustedProviderWriteAuthorityResolutionSchema.parse({
        authorityBinding: authority,
        operationScope: {
          ...operationScope,
          authorizationScopeFingerprint: 'e'.repeat(64),
        },
      }),
    ).toThrow(/scope/i);
    expect(() =>
      ProviderWriteOperationScopeSchema.parse({
        ...operationScope,
        originSpaceAccessGrantId: 'must-not-cross-this-boundary',
      }),
    ).toThrow();
  });
});
