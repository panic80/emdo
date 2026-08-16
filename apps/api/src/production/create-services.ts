import { assembleProductionApiServices } from './assemble-services.js';

export type { ProductionApiServiceBindings } from './unavailable-services.js';

/**
 * Bundled default composition. Until the durable request-current space grant
 * resolver and the other authority stores are configured, the process remains
 * live but explicitly unready and every affected route fails closed. The
 * executable always uses this built-in graph and accepts no caller-selected
 * factory, module, service binding, or in-memory substitute.
 */
export const createProductionApiServices = async (
  environment: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof assembleProductionApiServices> =>
  assembleProductionApiServices(environment);

export const createApiServices = createProductionApiServices;
