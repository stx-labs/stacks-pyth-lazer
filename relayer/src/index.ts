import { logger, registerShutdownConfig } from '@stacks/api-toolkit';
import { buildApiServer } from './api/init.js';
import { ENV } from './env.ts';

/**
 * Initializes background services. Only for `default` and `writeonly` run modes.
 * @param db - PgStore
 */
async function initBackgroundServices() {
  logger.info('Initializing background services...');

  // const jobQueue = new JobQueue({ db, network: ENV.NETWORK as StacksNetworkName });
  // registerShutdownConfig({
  //   name: 'Job Queue',
  //   forceKillable: true,
  //   handler: async () => {
  //     await jobQueue.stop();
  //   },
  // });
}

/**
 * Initializes API service. Only for `default` and `readonly` run modes.
 */
async function initApiService() {
  logger.info('Initializing API service...');
  const apiServer = await buildApiServer();
  registerShutdownConfig({
    name: 'API Server',
    forceKillable: true,
    handler: async () => {
      await apiServer.close();
    },
  });
  await apiServer.listen({ host: ENV.API_HOST, port: ENV.API_PORT });
}

async function initApp() {
  logger.info(`Initializing in ${ENV.RUN_MODE} run mode...`);
  if (['default', 'writeonly'].includes(ENV.RUN_MODE)) {
    await initBackgroundServices();
  }
  if (['default', 'readonly'].includes(ENV.RUN_MODE)) {
    await initApiService();
  }
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
