import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Server } from "http";
import type { FastifyPluginCallback } from "fastify";

export const PairsRoutes: FastifyPluginCallback<
  Record<never, never>,
  Server,
  TypeBoxTypeProvider
> = (fastify, _options, done) => {
  fastify.get('/pairs', async (_request, reply) => {
    return reply.status(200).send({
      pairs: [],
    });
  });
  done();
};