import { logger } from '@stacks/api-toolkit';
import {
  PythLazerClient,
  type Format,
  type JsonOrBinaryResponse,
  type ParsedPayload,
  type PriceFeedProperty,
} from '@pythnetwork/pyth-lazer-sdk';
import { LRUCache } from 'lru-cache';
import { ENV } from '../env.ts';

/**
 * Pyth Lazer price feed id for BTC/USD. Feed ids are stable identifiers assigned
 * by Lazer; see {@link https://pyth-lazer.dourolabs.app}.
 */
export const BTC_USD_FEED_ID = 1;

/** Callback invoked for each parsed price update received from the stream. */
export type PriceUpdateHandler = (pair: string, payload: ParsedPayload) => void;

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

/**
 * Feed properties to request. `price`/`exponent`/`confidence` drive the
 * relayer's deviation logic; the signed `evm` payload (requested via
 * {@link DEFAULT_FORMATS}) is what gets submitted on-chain.
 */
const DEFAULT_PROPERTIES: PriceFeedProperty[] = [
  'price',
  'exponent',
  'confidence',
  'publisherCount',
];

/** Signature format consumed by the Stacks `pyth-lazer-oracle-v1` contract. */
const DEFAULT_FORMATS: Format[] = ['evm'];

/**
 * Connects to the Pyth Lazer websocket service and maintains subscriptions to a
 * dynamic set of price feed pairs (BTC/USD by default). Monitored pairs are held
 * in an LRU cache; when a pair is evicted its subscription is torn down.
 * Received updates are surfaced via the optional
 * {@link PriceMonitorConfig.onPriceUpdate} handler; the downstream relaying
 * logic is wired up in a later step.
 */
export class PriceMonitor {
  private pythClient?: PythLazerClient;
  /** Monitored pairs keyed by symbol. Eviction unsubscribes from the stream. */
  private readonly cache: LRUCache<string, MonitoredPair>;
  /** Reverse index from subscription id to symbol, for routing incoming messages. */
  private readonly subscriptions = new Map<number, string>();
  private nextSubscriptionId = 1;

  private readonly onPriceUpdate?: PriceUpdateHandler;

  constructor() {
    this.cache = new LRUCache<string, MonitoredPair>({
      max: ENV.PRICE_MONITOR_CACHE_MAX,
      dispose: (entry, symbol) => this.disposePair(entry, symbol),
    });
  }

  /** Establishes the connection pool and subscribes to all cached pairs. */
  async start(): Promise<void> {
    if (this.pythClient) {
      logger.warn('[PriceMonitor] already started; ignoring start()');
      return;
    }

    logger.info(
      { channel: ENV.PRICE_MONITOR_PYTH_LAZER_CHANNEL },
      '[PriceMonitor] connecting to Pyth Lazer'
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

    // Subscribe any pairs that were queued before the client connected.
    for (const entry of this.cache.values()) {
      if (!entry.subscribed) this.subscribeToPair(entry);
    }
  }

  /** Tears down the connection pool. Safe to call when not started. */
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
   * @param pair - Pyth Lazer symbol, e.g. `BTC/USD`.
   * @returns The cached monitored-pair entry.
   */
  requestPriceUpdate(pair: string): MonitoredPair {
    const existing = this.cache.get(pair);
    if (existing) return existing;

    const entry: MonitoredPair = {
      symbol: pair,
      subscriptionId: this.nextSubscriptionId++,
      subscribed: false,
    };
    this.subscriptions.set(entry.subscriptionId, pair);
    this.cache.set(pair, entry);

    // Subscribe immediately if connected; otherwise `start()` will pick it up.
    if (this.pythClient) this.subscribeToPair(entry);

    return entry;
  }

  /** Returns the cached entry for a pair, if currently monitored. */
  getPair(pair: string): MonitoredPair | undefined {
    return this.cache.peek(pair);
  }

  private subscribeToPair(entry: MonitoredPair): void {
    if (!this.pythClient) {
      throw new Error('[PriceMonitor] cannot subscribe before start()');
    }
    this.pythClient.subscribe({
      type: 'subscribe',
      subscriptionId: entry.subscriptionId,
      symbols: [entry.symbol],
      properties: DEFAULT_PROPERTIES,
      formats: DEFAULT_FORMATS,
      // Binary delivery yields the raw signed `evm` payload (for on-chain
      // submission); `parsed` additionally includes human-readable prices.
      deliveryFormat: 'binary',
      parsed: true,
      channel: ENV.PRICE_MONITOR_PYTH_LAZER_CHANNEL,
    });
    entry.subscribed = true;
    logger.info(
      { subscriptionId: entry.subscriptionId, pair: entry.symbol },
      '[PriceMonitor] subscribed to price feed'
    );
  }

  /** LRU dispose hook: unsubscribe and drop the reverse index when evicted. */
  private disposePair(entry: MonitoredPair, symbol: string): void {
    this.subscriptions.delete(entry.subscriptionId);
    if (this.pythClient && entry.subscribed) {
      this.pythClient.unsubscribe(entry.subscriptionId);
    }
    logger.info(
      { subscriptionId: entry.subscriptionId, pair: symbol },
      '[PriceMonitor] evicted pair and unsubscribed'
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
    if (!symbol) return; // update for a pair we no longer track

    // `get` (not `peek`) so active pairs stay fresh in the LRU.
    const entry = this.cache.get(symbol);
    if (entry) entry.lastUpdate = parsed;

    // TODO(next step): deviation/heartbeat triggers + on-chain submission using
    // the signed `evm` payload in `event.value.evm`.
    this.onPriceUpdate?.(symbol, parsed);
  };
}
