import {
  PostgresFinanceDocumentRepository,
  PostgresFinanceSpecialistRecordRepository,
} from '@emdo/db/api';

import { AuthenticatedPrincipalSchema } from '../schemas.js';
import type { AuthenticatedPrincipal } from '../services/contracts.js';
import type { FinanceImportGateway } from '../services/contracts.js';
import { financeGuardedActionCapabilityFingerprint } from '../agents/capability-runtime.js';
import type { TrustedFinanceSpecialistServices } from '../agents/specialist-capability-adapters.js';
import { createRequestScopedFinanceSpecialistServices } from './finance-agent-services.js';
import type { ProductionFinanceDocumentGateway } from './finance-document-services.js';
import { createProductionFinanceSpecialistDocumentPort } from './finance-specialist-document-port.js';
import type { FinanceSpecialistEmbeddingQueryPort } from './finance-specialist-document-port.js';

type FinancePool = ConstructorParameters<
  typeof PostgresFinanceSpecialistRecordRepository
>[0];

export interface ProductionFinanceSpecialistComposition {
  checkReady(): Promise<boolean>;
  createForPrincipal(
    principal: AuthenticatedPrincipal,
  ): TrustedFinanceSpecialistServices;
}

/**
 * Finite Finance specialist persistence composition. It owns no model,
 * provider, storage, SQL, or credentials and exposes only the seven registered
 * Finance capability services.
 */
export const createProductionFinanceSpecialistComposition = (input: {
  readonly pool: FinancePool;
  readonly imports: Pick<FinanceImportGateway, 'commit'> & {
    checkReady(): Promise<boolean>;
  };
  /** Same encrypted-document composition used by the HTTP read surface. */
  readonly documentGateway?: Pick<
    ProductionFinanceDocumentGateway,
    'checkReady' | 'createGuardedActionPort'
  >;
  readonly now?: () => Date;
  readonly embeddingQuery?: FinanceSpecialistEmbeddingQueryPort;
}): ProductionFinanceSpecialistComposition => {
  if (typeof input?.pool?.connect !== 'function') {
    throw new Error('api-finance-specialist-composition-unavailable');
  }
  if (
    typeof input.imports?.commit !== 'function' ||
    typeof input.imports.checkReady !== 'function'
  ) {
    throw new Error('api-finance-specialist-composition-unavailable');
  }
  if (
    input.documentGateway !== undefined &&
    (typeof input.documentGateway.checkReady !== 'function' ||
      typeof input.documentGateway.createGuardedActionPort !== 'function')
  ) {
    throw new Error('api-finance-specialist-composition-unavailable');
  }
  const records = new PostgresFinanceSpecialistRecordRepository(input.pool);
  const documents = new PostgresFinanceDocumentRepository(input.pool);
  const now = input.now ?? (() => new Date());
  if (typeof now !== 'function') {
    throw new Error('api-finance-specialist-composition-unavailable');
  }

  return Object.freeze({
    async checkReady(): Promise<boolean> {
      try {
        const [recordsReady, documentsReady, importsReady, gatewayReady] =
          await Promise.all([
            records.checkInfrastructureReady(),
            documents.checkInfrastructureReady(),
            input.imports.checkReady(),
            input.documentGateway?.checkReady() ?? Promise.resolve(false),
          ]);
        return (
          recordsReady === true &&
          documentsReady === true &&
          importsReady === true &&
          gatewayReady === true
        );
      } catch {
        return false;
      }
    },
    createForPrincipal(principalInput: AuthenticatedPrincipal) {
      const principal = AuthenticatedPrincipalSchema.safeParse(principalInput);
      if (!principal.success || principal.data.privateSpaceId === undefined) {
        throw new Error('api-finance-specialist-composition-unavailable');
      }
      const fixedPrincipal = Object.freeze(principal.data);
      const documentPort = createProductionFinanceSpecialistDocumentPort({
        owner: fixedPrincipal,
        repository: documents,
        ...(input.embeddingQuery === undefined
          ? {}
          : { embeddingQuery: input.embeddingQuery }),
      });
      return createRequestScopedFinanceSpecialistServices({
        principal: fixedPrincipal,
        dependencies: {
          records,
          documents: documentPort,
          imports: input.imports,
          ...(input.documentGateway === undefined
            ? {}
            : {
                guardedDocumentActions:
                  input.documentGateway.createGuardedActionPort(fixedPrincipal),
              }),
          guardedActionCapabilityFingerprints: {
            recordsWrite: financeGuardedActionCapabilityFingerprint(
              'finance.records.write',
            ),
            statementImport: financeGuardedActionCapabilityFingerprint(
              'finance.statement.import',
            ),
          },
          now,
        },
      });
    },
  });
};
