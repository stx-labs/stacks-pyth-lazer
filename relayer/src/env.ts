import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import envSchema from 'env-schema';

const schema = Type.Object({
  /**
   * Run mode for this service. Allows you to control how the Token Metadata Service runs, typically
   * in an auto-scaled environment. Available values are:
   * * `default`: Runs background jobs and the REST API server (this is the default)
   * * `writeonly`: Runs only background jobs
   * * `readonly`: Runs only the REST API server
   */
  RUN_MODE: Type.Enum(
    { default: 'default', readonly: 'readonly', writeonly: 'writeonly' },
    { default: 'default' }
  ),
  /** Specifies which Stacks network this API is indexing */
  NETWORK: Type.Enum({ mainnet: 'mainnet', testnet: 'testnet' }, { default: 'mainnet' }),

  /** Hosname of the Token Metadata API server */
  API_HOST: Type.String({ default: '0.0.0.0' }),
  /** Port in which to serve the API */
  API_PORT: Type.Number({ default: 3000, minimum: 0, maximum: 65535 }),

  /** Pyth API key */
  PYTH_API_KEY: Type.String(),

  /** Maximum number of price feed pairs to keep in the in-memory LRU cache */
  PRICE_MONITOR_CACHE_MAX: Type.Integer({ default: 256, minimum: 1 }),
  /** Number of redundant websocket connections in the pool. Defaults to 4. */
  PRICE_MONITOR_NUM_CONNECTIONS: Type.Integer({ default: 4, minimum: 1 }),
  /** Pyth Lazer channel to subscribe to. Defaults to `fixed_rate_200ms`. */
  PRICE_MONITOR_PYTH_LAZER_CHANNEL: Type.Enum(
    {
      real_time: 'real_time',
      fixed_rate_50ms: 'fixed_rate@50ms',
      fixed_rate_200ms: 'fixed_rate@200ms',
      fixed_rate_1000ms: 'fixed_rate@1000ms',
    },
    { default: 'fixed_rate_200ms' }
  ),

  /** Stacks node RPC host */
  STACKS_NODE_RPC_HOST: Type.String(),
  /** Stacks node RPC port */
  STACKS_NODE_RPC_PORT: Type.Number({ minimum: 0, maximum: 65535 }),
});
type Env = Static<typeof schema>;

export const ENV = envSchema<Env>({
  schema: schema,
  dotenv: true,
});
