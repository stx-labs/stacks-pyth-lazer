import { logger, registerShutdownConfig } from '@stacks/api-toolkit';
import { buildApiServer } from './api/init.js';
import { ENV } from './env.js';
import { PythSymbolMonitor } from './relayer/pyth-symbol-monitor.ts';
import { PriceUpdatePlanner } from './relayer/price-update-planner.ts';
import { PriceUpdateTransactionSubmitter } from './relayer/price-update-transaction-submitter.ts';
import { StacksPriceReader } from './stacks/price-reader.js';
import type { ApiConfig } from './api/init.js';

/**
 * Initializes background services.
 * @param config - API configuration.
 */
async function initBackgroundServices(config: ApiConfig) {
  logger.info('Initializing background services...');

  const nodeRpcBaseUrl = `http://${ENV.STACKS_NODE_RPC_HOST}:${ENV.STACKS_NODE_RPC_PORT}`;

  const reader = new StacksPriceReader({
    sender: ENV.PYTH_DEPLOYER_STACKS_ADDRESS,
    rpcBaseUrl: nodeRpcBaseUrl,
  });

  const submitter = new PriceUpdateTransactionSubmitter({
    senderKey: ENV.TX_SUBMITTER_PRIVATE_KEY,
    network: ENV.NETWORK,
    deployer: ENV.PYTH_DEPLOYER_STACKS_ADDRESS,
    txFeeMicroStx: ENV.TX_SUBMITTER_FEE_USTX,
    rpcBaseUrl: nodeRpcBaseUrl,
  });

  const planner = new PriceUpdatePlanner({
    reader,
    submitter,
    heartbeatMs: ENV.PRICE_UPDATE_HEARTBEAT_MS,
    minSubmitIntervalMs: ENV.PRICE_UPDATE_MIN_SUBMIT_INTERVAL_MS,
    deviationBps: ENV.PRICE_UPDATE_DEVIATION_BPS,
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
    priceMonitor: new PythSymbolMonitor(),
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
