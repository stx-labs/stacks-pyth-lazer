import { logger } from '@stacks/api-toolkit';
import {
  PythLazerClient,
  type Channel,
  type JsonOrBinaryResponse,
  type ParsedPayload,
} from '@pythnetwork/pyth-lazer-sdk';
import { LRUCache } from 'lru-cache';
import { ENV } from '../env.ts';
import { parsePythLazerChannel } from './helpers.ts';

/**
 * Maximum number of feeds we monitor at once. The on-chain
 * `pyth-lazer-oracle-v1.verify-and-update-price-feeds` decodes a single signed
 * message into a `(list 16 ...)` of feeds, so there is no point subscribing to
 * more pairs than we can submit in one transaction.
 */
const MAX_PRICE_FEEDS = 16;

/**
 * All monitored feeds share a single Lazer subscription so they arrive together
 * in one signed message (submittable in one tx). This is its fixed id.
 */
const SUBSCRIPTION_ID = 1;

/** Default symbols to subscribe to. */
const DEFAULT_SYMBOLS = ['Crypto.BTC/USD', 'Crypto.STX/USD', 'Crypto.USDC/USD'];

/**
 * Connects to the Pyth Lazer websocket service and maintains a single
 * subscription covering up to {@link MAX_PRICE_FEEDS} price pairs. The monitored
 * set is held in an LRU cache; adding a pair (or evicting the least-recently-used
 * one when full) refreshes the subscription so it always reflects the current
 * set under one {@link SUBSCRIPTION_ID}. All feeds therefore arrive in one signed
 * message that can be relayed to the contract in a single transaction.
 */
export class PriceMonitor {
  private pythClient?: PythLazerClient;
  private readonly channel: Channel;
  /** Whether the single subscription is currently active on the stream. */
  private subscribed = false;
  /** Most recent parsed payload (all feeds) seen on the subscription, if any. */
  private latestPayload?: ParsedPayload;
  /** Monitored symbols, capped at {@link MAX_PRICE_FEEDS}. The value is unused. */
  private readonly symbolCache: LRUCache<string, boolean>;

  constructor() {
    this.channel = parsePythLazerChannel(ENV.PRICE_MONITOR_PYTH_LAZER_CHANNEL);
    this.symbolCache = new LRUCache<string, boolean>({
      max: MAX_PRICE_FEEDS,
      dispose: (_value, symbol) => {
        // Eviction only logs; `refreshSubscription` (run by the mutator after
        // the cache settles) rebuilds the subscription from the surviving keys.
        logger.debug(`[PriceMonitor] evicting symbol ${symbol} from cache`);
      },
    });
    // Seed the default symbols. The subscription is created lazily in `start()`.
    for (const symbol of DEFAULT_SYMBOLS) {
      this.requestPriceUpdate(symbol);
    }
  }

  /**
   * Establishes the connection pool and subscribes to the full monitored set.
   */
  async start(): Promise<void> {
    if (this.pythClient) {
      logger.debug('[PriceMonitor] already started; skipping start()');
      return;
    }

    logger.info(`[PriceMonitor] connecting to Pyth Lazer channel ${this.channel}`);
    this.pythClient = await PythLazerClient.create({
      token: ENV.PYTH_API_KEY,
      webSocketPoolConfig: {
        numConnections: ENV.PRICE_MONITOR_NUM_CONNECTIONS,
        urls: [
          'wss://pyth-lazer-0.dourolabs.app/v1/stream',
          'wss://pyth-lazer-1.dourolabs.app/v1/stream',
          'wss://pyth-lazer-2.dourolabs.app/v1/stream',
        ],
        onWebSocketError: error => {
          logger.error({ error }, '[PriceMonitor] websocket connection error');
        },
        onWebSocketPoolError: error => {
          logger.error(error, '[PriceMonitor] websocket pool error');
        },
      },
    });
    this.pythClient.addMessageListener(this.handleMessage);
    this.pythClient.addAllConnectionsDownListener(() => {
      logger.error('[PriceMonitor] all Pyth Lazer connections are down');
    });
    this.pythClient.addConnectionRestoredListener(() => {
      logger.info('[PriceMonitor] Pyth Lazer connection restored');
    });

    // Subscribe to every symbol queued before the client connected.
    this.refreshSubscription();
  }

  /** The most recent parsed payload (all feeds) seen on the subscription, if any. */
  get lastPayload(): ParsedPayload | undefined {
    return this.latestPayload;
  }

  /**
   * Tears down the connection pool. Safe to call when not started.
   */
  async stop(): Promise<void> {
    if (!this.pythClient) return;
    this.pythClient.shutdown();
    this.pythClient = undefined;
    this.subscribed = false;
    logger.info('[PriceMonitor] stopped');
  }

  /**
   * Requests live updates for a pair on behalf of an external caller. Adds the
   * pair to the LRU cache (evicting the least-recently-used pair if at capacity)
   * and refreshes the subscription. If the pair is already monitored this only
   * bumps its recency in the cache and leaves the subscription unchanged.
   * @param symbol - Pyth Lazer symbol, e.g. `Crypto.BTC/USD`.
   */
  requestPriceUpdate(symbol: string): void {
    if (this.symbolCache.get(symbol)) return; // already monitored; bumps recency
    this.symbolCache.set(symbol, true);
    this.refreshSubscription();
  }

  /**
   * Replaces the single subscription with one covering the full current symbol
   * set, so all monitored feeds arrive together in one signed message. No-op
   * until the client is connected (`start()` calls this once it is).
   */
  private refreshSubscription(): void {
    if (!this.pythClient) return;

    if (this.subscribed) {
      this.pythClient.unsubscribe(SUBSCRIPTION_ID);
      this.subscribed = false;
    }

    const symbols = [...this.symbolCache.keys()];
    if (symbols.length === 0) {
      logger.info('[PriceMonitor] no symbols to monitor; subscription cleared');
      return;
    }

    this.pythClient.subscribe({
      type: 'subscribe',
      subscriptionId: SUBSCRIPTION_ID,
      symbols,
      // Only the fields `pyth-lazer-oracle-v1` requires to store a feed
      // (price + exponent + publisher-count); anything else just bloats the
      // signed payload. A feed missing any of these is skipped on-chain.
      properties: ['price', 'exponent', 'publisherCount'],
      formats: ['evm'],
      // Binary delivery yields the raw signed `evm` payload (for on-chain
      // submission); `parsed` additionally includes human-readable prices.
      deliveryFormat: 'binary',
      parsed: true,
      channel: this.channel,
    });
    this.subscribed = true;
    logger.info(
      { subscriptionId: SUBSCRIPTION_ID, symbols },
      `[PriceMonitor] subscribed to ${symbols.length} feed(s)`
    );
  }

  private readonly handleMessage = (event: JsonOrBinaryResponse): void => {
    if (event.type !== 'binary') {
      // JSON control/error responses (subscription acks, etc.).
      logger.debug({ value: event.value }, '[PriceMonitor] received json message');
      return;
    }

    if (event.value.subscriptionId !== SUBSCRIPTION_ID) {
      logger.debug(
        `[PriceMonitor] received message for unknown subscription ${event.value.subscriptionId}, unsubscribing`
      );
      this.pythClient?.unsubscribe(event.value.subscriptionId);
      return;
    }

    const { parsed } = event.value;
    if (!parsed) return;
    this.latestPayload = parsed;

    // TODO(next step): deviation/heartbeat triggers + on-chain submission using
    // the signed `evm` payload in `event.value.evm`.
    logger.debug(event.value, '[PriceMonitor] received price update');
  };
}
