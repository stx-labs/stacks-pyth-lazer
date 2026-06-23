import { logger, registerShutdownConfig } from '@stacks/api-toolkit';
import { buildApiServer } from './api/init.js';
import { ENV } from './env.js';
import { PythPriceMonitor } from './relayer/pyth-price-monitor.ts';
import { PriceUpdatePlanner } from './relayer/price-update-planner.ts';
import { LoggingSubmitter } from './relayer/submitter.js';
import { StacksPriceReader } from './stacks/price-reader.js';
import type { ApiConfig } from './api/init.js';

/**
 * Initializes background services.
 * @param config - API configuration.
 */
async function initBackgroundServices(config: ApiConfig) {
  logger.info('Initializing background services...');

  // The relaying heuristic consumes each streamed update and decides whether to
  // submit it on-chain (via a stub submitter for now).
  const planner = new PriceUpdatePlanner({
    reader: new StacksPriceReader(),
    submitter: new LoggingSubmitter(),
  });
  await planner.validateHeartbeat();

  registerShutdownConfig({
    name: 'Pyth Price Monitor',
    forceKillable: true,
    handler: async () => {
      await config.priceMonitor.stop();
    },
  });
  await config.priceMonitor.start((evm, parsed) => planner.handlePriceMonitorPayload(evm, parsed));
}

/**
 * Initializes API service.
 * @param config - API configuration.
 */
async function initApiService(config: ApiConfig) {
  logger.info('Initializing API service...');
  const apiServer = await buildApiServer(config);
  registerShutdownConfig({
    name: 'API Server',
    forceKillable: true,
    handler: async () => {
      await apiServer.close();
    },
  });
  await apiServer.listen({ host: ENV.API_HOST, port: ENV.API_PORT });
}

/**
 * Initializes the application.
 */
async function initApp() {
  const config: ApiConfig = {
    priceMonitor: new PythPriceMonitor(),
  };
  await initBackgroundServices(config);
  await initApiService(config);
}

registerShutdownConfig();
initApp()
  .then(() => {
    logger.info('App initialized');
  })
  .catch(error => {
    logger.error(error, 'App failed to start');
    process.exit(1);
  });
