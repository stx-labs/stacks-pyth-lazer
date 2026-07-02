import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { Server } from 'http';
import type { FastifyPluginCallback } from 'fastify';
import type { ApiConfig } from '../init.js';

export const PairsRoutes: FastifyPluginCallback<
  ApiConfig,
  Server,
  TypeBoxTypeProvider
> = (fastify, config, done) => {
  fastify.post(
    '/price-update',
    {
      schema: {
        body: Type.Object({
          symbol: Type.String(),
        }),
      },
    },
    async (request, reply) => {
      // TODO: Improve this endpoint depending on partner API design
      const accepted = config.pythSymbolMonitor.requestPriceUpdate(request.body.symbol);
      if (!accepted) {
        return reply.status(400).send({
          error: `Unknown or unsupported Pyth Lazer symbol: ${request.body.symbol}`,
        });
      }
      return reply.status(200).send({
        message: 'Price update requested',
      });
    }
  );
  done();
};
