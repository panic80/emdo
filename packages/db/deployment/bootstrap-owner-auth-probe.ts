import { Pool } from 'pg';

import { createEmdoBetterAuth } from '../../auth/src/better-auth.js';
import { createPostgresBetterAuthOrganizationClaimBridge } from '../src/better-auth-claim-transaction.js';

/**
 * Deployment-test-only proof that the bootstrap credential is consumable by
 * EMDO's real Better Auth email/password boundary. This file is deliberately
 * outside the package root export.
 */
export const signInBootstrapOwner = async (input: {
  readonly connectionString: string;
  readonly email: string;
  readonly password: string;
}) => {
  const pool = new Pool({
    allowExitOnIdle: true,
    application_name: 'emdo-owner-bootstrap-auth-probe',
    connectionString: input.connectionString,
    max: 1,
  });
  try {
    const organizationClaimBridge =
      await createPostgresBetterAuthOrganizationClaimBridge(pool);
    const auth = createEmdoBetterAuth({
      appName: 'EMDO bootstrap integration probe',
      baseURL: 'https://bootstrap.emdo.test',
      googleIdentity: {
        clientId: 'bootstrap-integration-client',
        clientSecret: 'bootstrap-integration-client-secret',
      },
      organizationClaimBridge,
      secret: 'bootstrap-integration-secret-is-at-least-32-bytes',
      sendInvitationEmail: async () => undefined,
      sendPasswordResetEmail: async () => undefined,
      sendVerificationEmail: async () => undefined,
      trustedOrigins: ['https://bootstrap.emdo.test'],
    });

    return await auth.api.signInEmail({
      body: {
        email: input.email,
        password: input.password,
        rememberMe: false,
      },
    });
  } finally {
    await pool.end();
  }
};
