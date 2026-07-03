import { Type } from '@sinclair/typebox';

/**
 * A Pyth Lazer crypto symbol, e.g. `Crypto.BTC/USD`. We only relay crypto pairs, so the symbol must
 * carry the `Crypto.` asset-class prefix — the schema rejects anything else with a 400 before it
 * reaches the monitor.
 */
export const CryptoSymbolSchema = Type.String({
  pattern: '^Crypto\\.[A-Za-z0-9]+/[A-Za-z0-9]+$',
  description: 'Pyth Lazer crypto symbol, e.g. "Crypto.BTC/USD"',
  examples: ['Crypto.BTC/USD'],
});

export const PriceUpdateBodySchema = Type.Object({ symbol: CryptoSymbolSchema });

export const PriceUpdateResponseSchema = Type.Object({
  message: Type.String(),
  symbol: CryptoSymbolSchema,
});

/** Shape covering both handler errors and Fastify's schema-validation errors. */
export const ErrorResponseSchema = Type.Object({
  error: Type.String(),
  message: Type.Optional(Type.String()),
});
