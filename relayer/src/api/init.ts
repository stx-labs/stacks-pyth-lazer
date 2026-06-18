import Fastify, { type FastifyPluginAsync } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import FastifyCors from '@fastify/cors';
import { Server } from 'http';
import { PINO_LOGGER_CONFIG } from '@stacks/api-toolkit';
import { PairsRoutes } from './routes/pairs.ts';

export const Api: FastifyPluginAsync<Record<never, never>, Server, TypeBoxTypeProvider> = async (
  fastify,
  _options
) => {
  await fastify.register(PairsRoutes);
};

export async function buildApiServer() {
  const fastify = Fastify({
    trustProxy: true,
    logger: PINO_LOGGER_CONFIG,
  }).withTypeProvider<TypeBoxTypeProvider>();

  await fastify.register(FastifyCors);
  await fastify.register(Api, { prefix: '/relayer/v1' });
  await fastify.register(Api, { prefix: '/relayer' });

  return fastify;
}
