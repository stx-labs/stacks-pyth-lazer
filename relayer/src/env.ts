import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import envSchema from 'env-schema';

const schema = Type.Object({
  /** Specifies which Stacks network this API is indexing */
  NETWORK: Type.Enum({ mainnet: 'mainnet', testnet: 'testnet' }, { default: 'mainnet' }),

  /** Hosname of the Token Metadata API server */
  API_HOST: Type.String({ default: '0.0.0.0' }),
  /** Port in which to serve the API */
  API_PORT: Type.Number({ default: 3000, minimum: 0, maximum: 65535 }),

  /** Pyth API key */
  PYTH_API_KEY: Type.String(),

  /** Number of redundant websocket connections in the pool. Defaults to 4. */
  PRICE_MONITOR_NUM_CONNECTIONS: Type.Integer({ default: 4, minimum: 1 }),
  /** Pyth Lazer channel to subscribe to. Defaults to `fixed_rate_200ms`. */
  PRICE_MONITOR_PYTH_LAZER_CHANNEL: Type.Enum(
    {
      real_time: 'real_time',
      fixed_rate_50ms: 'fixed_rate_50ms',
      fixed_rate_200ms: 'fixed_rate_200ms',
      fixed_rate_1000ms: 'fixed_rate_1000ms',
    },
    { default: 'fixed_rate_200ms' }
  ),

  /** Stacks node RPC host */
  STACKS_NODE_RPC_HOST: Type.String(),
  /** Stacks node RPC port */
  STACKS_NODE_RPC_PORT: Type.Number({ minimum: 0, maximum: 65535 }),
  /**
   * Principal that deployed the Pyth Lazer contracts. The storage and governance
   * contract ids are derived from it (`<deployer>.pyth-lazer-storage`, etc.).
   */
  STACKS_PYTH_DEPLOYER: Type.String(),

  /**
   * Push a feed when its price moves at least this many basis points from the
   * value last written on-chain (100 bps = 1%). Defaults to 50 (0.5%).
   */
  RELAYER_DEVIATION_BPS: Type.Integer({ default: 50, minimum: 1 }),
  /**
   * Force a push at least this often (ms) even if prices are flat. Must be
   * shorter than governance's stale-price threshold. Defaults to 30s.
   */
  RELAYER_HEARTBEAT_MS: Type.Integer({ default: 30_000, minimum: 1 }),
  /**
   * Minimum spacing between submissions (ms). No point submitting faster than
   * Stacks block production (~5s, Nakamoto). Defaults to 5s.
   */
  RELAYER_MIN_SUBMIT_INTERVAL_MS: Type.Integer({ default: 5_000, minimum: 0 }),
});
type Env = Static<typeof schema>;

export const ENV = envSchema<Env>({
  schema: schema,
  dotenv: true,
});
