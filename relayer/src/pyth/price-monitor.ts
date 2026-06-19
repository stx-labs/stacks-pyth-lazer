import { logger } from '@stacks/api-toolkit';
import {
  PythLazerClient,
  type JsonOrBinaryResponse,
  type ParsedPayload,
} from '@pythnetwork/pyth-lazer-sdk';
import { LRUCache } from 'lru-cache';
import { ENV } from '../env.ts';

/** An entry tracked in the LRU cache, one per monitored pair. */
export interface MonitoredPair {
  /** Pyth Lazer symbol, e.g. `BTC/USD`. */
  symbol: string;
  /** Lazer subscription id assigned to this pair. */
  subscriptionId: number;
  /** Whether an active websocket subscription exists for this pair. */
  subscribed: boolean;
  /** Most recent parsed payload seen for this pair, if any. */
  lastUpdate?: ParsedPayload;
}

/** Default symbols to subscribe to. */
const DEFAULT_SYMBOLS = ['Crypto.BTC/USD', 'Crypto.STX/USD', 'Crypto.USDC/USD'];

/**
 * Connects to the Pyth Lazer websocket service and maintains subscriptions to a dynamic set of
 * price feed pairs (BTC/USD by default). Monitored pairs are held in an LRU cache; when a pair is
 * evicted its subscription is torn down.
 */
export class PriceMonitor {
  private pythClient?: PythLazerClient;
  /** Monitored pairs keyed by symbol. Eviction unsubscribes from the stream. */
  private readonly symbolCache: LRUCache<string, MonitoredPair>;
  /** Reverse index from subscription id to symbol, for routing incoming messages. */
  private readonly subscriptions = new Map<number, string>();
  /** Next subscription id to assign. */
  private nextSubscriptionId = 1;

  constructor() {
    this.symbolCache = new LRUCache<string, MonitoredPair>({
      max: ENV.PRICE_MONITOR_CACHE_MAX,
      dispose: (entry, symbol) => this.disposeSymbol(entry, symbol),
    });
    // Add the default symbols to the cache. The subscriptions will be created lazily when the
    // client is started.
    for (const symbol of DEFAULT_SYMBOLS) {
      this.subscribeToSymbol(symbol);
    }
  }

  /**
   * Establishes the connection pool and subscribes to all default symbols.
   */
  async start(): Promise<void> {
    if (this.pythClient) {
      logger.debug('[PriceMonitor] already started; skipping start()');
      return;
    }

    logger.info(
      `[PriceMonitor] connecting to Pyth Lazer channel ${ENV.PRICE_MONITOR_PYTH_LAZER_CHANNEL}`
    );
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

    // Resume subscriptions to all symbols in the cache.
    for (const symbol of this.symbolCache.keys()) {
      this.subscribeToSymbol(symbol);
    }
  }

  /**
   * Tears down the connection pool. Safe to call when not started.
   */
  async stop(): Promise<void> {
    if (!this.pythClient) return;
    this.pythClient.shutdown();
    this.pythClient = undefined;
    logger.info('[PriceMonitor] stopped');
  }

  /**
   * Requests live updates for a pair on behalf of an external caller. Adds the
   * pair to the LRU cache and subscribes to its feed; if the pair is already
   * monitored this simply refreshes its recency in the cache.
   * @param symbol - Pyth Lazer symbol, e.g. `BTC/USD`.
   * @returns The cached monitored-pair entry.
   */
  requestPriceUpdate(symbol: string): void {
    this.subscribeToSymbol(symbol);
  }

  /**
   * Subscribes to a symbol and adds it to the cache. This is an idempotent operation; if the symbol
   * is already subscribed, this does nothing.
   * @param symbol - Pyth Lazer symbol, e.g. `Crypto.STX/USD`.
   */
  private subscribeToSymbol(symbol: string): void {
    let entry = this.symbolCache.get(symbol);
    if (!entry) {
      const subscriptionId = this.nextSubscriptionId++;
      const newEntry: MonitoredPair = {
        symbol,
        subscriptionId,
        subscribed: false,
      };
      this.symbolCache.set(symbol, newEntry);
      this.subscriptions.set(subscriptionId, symbol);
      entry = newEntry;
    }
    if (this.pythClient) {
      this.pythClient.subscribe({
        type: 'subscribe',
        subscriptionId: entry.subscriptionId,
        symbols: [symbol],
        properties: ['price', 'exponent', 'confidence', 'publisherCount'],
        formats: ['evm'],
        // Binary delivery yields the raw signed `evm` payload (for on-chain
        // submission); `parsed` additionally includes human-readable prices.
        deliveryFormat: 'binary',
        parsed: true,
        channel: ENV.PRICE_MONITOR_PYTH_LAZER_CHANNEL,
      });
      entry.subscribed = true;
      logger.info(
        { subscriptionId: entry.subscriptionId, symbol },
        `[PriceMonitor] subscribed to price feed for symbol ${symbol}`
      );
    }
  }

  /**
   * LRU dispose hook: unsubscribe from the symbol when evicted.
   * @param entry - The cached entry for the symbol.
   * @param symbol - The symbol to unsubscribe from.
   */
  private disposeSymbol(entry: MonitoredPair, symbol: string): void {
    if (this.pythClient) {
      this.pythClient.unsubscribe(entry.subscriptionId);
    }
    this.subscriptions.delete(entry.subscriptionId);
    logger.info(
      { subscriptionId: entry.subscriptionId, symbol },
      `[PriceMonitor] evicted symbol ${symbol} and unsubscribed`
    );
  }

  private readonly handleMessage = (event: JsonOrBinaryResponse): void => {
    if (event.type !== 'binary') {
      // JSON control/error responses (subscription acks, etc.).
      logger.debug({ value: event.value }, '[PriceMonitor] received json message');
      return;
    }

    const { parsed } = event.value;
    if (!parsed) return;

    const symbol = this.subscriptions.get(event.value.subscriptionId);
    if (!symbol) return; // update for a symbol we no longer track

    const entry = this.symbolCache.get(symbol);
    if (entry) entry.lastUpdate = parsed;

    // TODO(next step): deviation/heartbeat triggers + on-chain submission using
    // the signed `evm` payload in `event.value.evm`.
    // this.onPriceUpdate?.(symbol, parsed);
  };
}
