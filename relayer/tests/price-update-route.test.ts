import { after, afterEach, before, describe, mock, test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { FastifyInstance } from 'fastify';
import { buildApiServer, type ApiConfig } from '../src/api/init.ts';

const URL = '/relayer/v1/price-update';

// Fakes for the two dependencies the route touches.
const requestPriceUpdate = mock.fn((_symbol: string): boolean => true);
const requestImmediateUpdate = mock.fn();

const config = {
  pythSymbolMonitor: { requestPriceUpdate },
  planner: { requestImmediateUpdate },
} as unknown as ApiConfig;

let app: FastifyInstance;

describe('POST /price-update', () => {
  // Build the server once — buildApiServer registers fastify-metrics, which
  // collects default metrics on the shared prom-client registry and would throw
  // if registered per-test.
  before(async () => {
    app = await buildApiServer(config);
  });
  after(async () => {
    await app.close();
  });

  afterEach(() => {
    requestPriceUpdate.mock.resetCalls();
    requestPriceUpdate.mock.mockImplementation(() => true);
    requestImmediateUpdate.mock.resetCalls();
  });

  test('accepts a known crypto symbol and forces an on-demand push', async () => {
    const res = await app.inject({ method: 'POST', url: URL, payload: { symbol: 'Crypto.BTC/USD' } });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { message: 'Price update requested', symbol: 'Crypto.BTC/USD' });
    assert.deepEqual(requestPriceUpdate.mock.calls[0]?.arguments, ['Crypto.BTC/USD']);
    assert.equal(requestImmediateUpdate.mock.callCount(), 1);
  });

  test('rejects a symbol the monitor does not recognize', async () => {
    requestPriceUpdate.mock.mockImplementation(() => false);

    const res = await app.inject({ method: 'POST', url: URL, payload: { symbol: 'Crypto.NOPE/USD' } });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'unknown_symbol');
    assert.equal(requestImmediateUpdate.mock.callCount(), 0, 'no push for an unknown symbol');
  });

  test('rejects a non-crypto symbol at the schema layer', async () => {
    const res = await app.inject({ method: 'POST', url: URL, payload: { symbol: 'Equity.AAPL/USD' } });

    assert.equal(res.statusCode, 400);
    assert.equal(requestPriceUpdate.mock.callCount(), 0, 'never reaches the handler');
  });

  test('rejects a symbol missing the Crypto. prefix', async () => {
    const res = await app.inject({ method: 'POST', url: URL, payload: { symbol: 'BTC/USD' } });

    assert.equal(res.statusCode, 400);
    assert.equal(requestPriceUpdate.mock.callCount(), 0);
  });

  test('rejects a malformed crypto symbol (no pair)', async () => {
    const res = await app.inject({ method: 'POST', url: URL, payload: { symbol: 'Crypto.BTCUSD' } });

    assert.equal(res.statusCode, 400);
    assert.equal(requestPriceUpdate.mock.callCount(), 0);
  });

  test('rejects a body missing the symbol field', async () => {
    const res = await app.inject({ method: 'POST', url: URL, payload: {} });

    assert.equal(res.statusCode, 400);
    assert.equal(requestPriceUpdate.mock.callCount(), 0);
  });
});
