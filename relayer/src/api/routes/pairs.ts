import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { Server } from 'http';
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
      config.priceMonitor.requestPriceUpdate(request.body.symbol);
      return reply.status(200).send({
        message: 'Price update received',
      });
    }
  );
  done();
};
