import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Server } from 'http';
import type { FastifyPluginCallback } from 'fastify';
import type { ApiConfig } from '../init.js';
import {
  PriceUpdateBodySchema,
  PriceUpdateResponseSchema,
  ErrorResponseSchema,
} from '../schemas.js';

export const PairsRoutes: FastifyPluginCallback<ApiConfig, Server, TypeBoxTypeProvider> = (
  fastify,
  config,
  done
) => {
  fastify.post(
    '/price-update',
    {
      schema: {
        body: PriceUpdateBodySchema,
        response: {
          200: PriceUpdateResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { symbol } = request.body;

      // Add to the monitored set (validated against the Lazer catalog).
      const accepted = config.pythSymbolMonitor.requestPriceUpdate(symbol);
      if (!accepted) {
        return reply.status(400).send({
          error: 'unknown_symbol',
          message: `Unknown or unsupported Pyth Lazer symbol: ${symbol}`,
        });
      }

      // On-demand trigger: force the next eligible update to be relayed on-chain,
      // regardless of the deviation threshold.
      config.planner.requestImmediateUpdate();

      return reply.status(200).send({ message: 'Price update requested', symbol });
    }
  );
  done();
};
