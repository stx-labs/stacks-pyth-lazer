import Fastify, { type FastifyPluginAsync } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import FastifyCors from '@fastify/cors';
import { Server } from 'http';
import { PINO_LOGGER_CONFIG } from '@stacks/api-toolkit';
import { PairsRoutes } from './routes/pairs.js';
import type { PriceMonitor } from '../pyth/price-monitor.js';

/** Configuration for the API service. */
export interface ApiConfig {
  /** Price monitor instance. */
  priceMonitor: PriceMonitor;
}

export const Api: FastifyPluginAsync<ApiConfig, Server, TypeBoxTypeProvider> = async (
  fastify,
  config
) => {
  await fastify.register(PairsRoutes, config);
};

export async function buildApiServer(config: ApiConfig) {
  const fastify = Fastify({
    trustProxy: true,
    logger: PINO_LOGGER_CONFIG,
  }).withTypeProvider<TypeBoxTypeProvider>();

  await fastify.register(FastifyCors);
  await fastify.register(Api, { ...config, prefix: '/relayer/v1' });
  await fastify.register(Api, { ...config, prefix: '/relayer' });

  return fastify;
}
