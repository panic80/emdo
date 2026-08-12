import { describe, expect, it } from 'vitest';

import * as contracts from './index.js';
import type {
  ActionProposal,
  DeepReadonly,
  EffectiveAuthorizationScopeFingerprint,
  ProviderWriteApprovalBinding,
  ProviderWriteAuthorization,
} from './index.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;
type FingerprintRemainsABrandedPrimitive = Assert<
  Equal<
    DeepReadonly<EffectiveAuthorizationScopeFingerprint>,
    EffectiveAuthorizationScopeFingerprint
  >
>;
type ApprovalBindingPreservesFingerprintBrand = Assert<
  Equal<
    ProviderWriteApprovalBinding['authorityBinding']['authorizationScopeFingerprint'],
    EffectiveAuthorizationScopeFingerprint
  >
>;
type AuthorizationPreservesFingerprintBrand = Assert<
  Equal<
    ProviderWriteAuthorization['approvalBinding']['authorityBinding']['authorizationScopeFingerprint'],
    EffectiveAuthorizationScopeFingerprint
  >
>;
type ProposalFingerprintRejectsPlainStrings = Assert<
  Equal<
    string extends ActionProposal['authorizationScopeFingerprint']
      ? true
      : false,
    false
  >
>;
type ProposalFingerprintKeepsTheContractBrand = Assert<
  Equal<
    ActionProposal['authorizationScopeFingerprint'],
    EffectiveAuthorizationScopeFingerprint
  >
>;

const fingerprintTypeProof: FingerprintRemainsABrandedPrimitive = true;
const approvalBindingTypeProof: ApprovalBindingPreservesFingerprintBrand = true;
const authorizationTypeProof: AuthorizationPreservesFingerprintBrand = true;
const proposalPlainStringProof: ProposalFingerprintRejectsPlainStrings = true;
const proposalBrandProof: ProposalFingerprintKeepsTheContractBrand = true;

describe('EffectiveAuthorizationScopeFingerprintSchema', () => {
  it('exports a branded trust-boundary parser for lowercase SHA-256 values', () => {
    const schema = Reflect.get(
      contracts,
      'EffectiveAuthorizationScopeFingerprintSchema',
    ) as
      | {
          parse(input: unknown): string;
          safeParse(input: unknown): { readonly success: boolean };
        }
      | undefined;

    expect(schema).toBeDefined();
    expect(fingerprintTypeProof).toBe(true);
    expect(approvalBindingTypeProof).toBe(true);
    expect(authorizationTypeProof).toBe(true);
    expect(proposalPlainStringProof).toBe(true);
    expect(proposalBrandProof).toBe(true);
    expect(schema?.parse('a'.repeat(64))).toBe('a'.repeat(64));
    expect(schema?.safeParse('A'.repeat(64)).success).toBe(false);
    expect(schema?.safeParse('a'.repeat(63)).success).toBe(false);
    expect(schema?.safeParse(`${'a'.repeat(64)} `).success).toBe(false);
  });
});
