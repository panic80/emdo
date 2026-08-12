import { expect, it } from 'vitest';

import type { ProviderWriteCapabilityId } from '@emdo/contracts';

import type { TrustedProviderWriteAuthorityResolver } from './registry.js';

type AuthorityResolutionInput = Parameters<
  TrustedProviderWriteAuthorityResolver['resolve']
>[0];

const assertResolverCapabilityBoundary = (
  input: Omit<AuthorityResolutionInput, 'capabilityId'>,
  providerWriteCapabilityId: ProviderWriteCapabilityId,
  arbitraryString: string,
): void => {
  const valid: AuthorityResolutionInput = {
    ...input,
    capabilityId: providerWriteCapabilityId,
  };

  const invalid: AuthorityResolutionInput = {
    ...input,
    // @ts-expect-error Trusted authority resolution accepts only descriptor-validated provider-write IDs.
    capabilityId: arbitraryString,
  };

  void valid;
  void invalid;
};

void assertResolverCapabilityBoundary;

it('keeps the trusted authority resolver behind the provider-write ID boundary', () => {
  expect(true).toBe(true);
});
