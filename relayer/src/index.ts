import { logger, registerShutdownConfig } from '@stacks/api-toolkit';
import { buildApiServer } from './api/init.js';
import { ENV } from './env.js';
import { PriceMonitor } from './pyth/price-monitor.js';
import type { ApiConfig } from './api/init.js';

/**
 * Initializes background services.
 * @param config - API configuration.
 */
async function initBackgroundServices(config: ApiConfig) {
  logger.info('Initializing background services...');

  registerShutdownConfig({
    name: 'Price Monitor',
    forceKillable: true,
    handler: async () => {
      await config.priceMonitor.stop();
    },
  });
  await config.priceMonitor.start();
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
    priceMonitor: new PriceMonitor(),
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
