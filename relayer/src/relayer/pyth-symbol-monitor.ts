import { logger } from '@stacks/api-toolkit';
import {
  PythLazerClient,
  type Channel,
  type JsonOrBinaryResponse,
  type ParsedPayload,
} from '@pythnetwork/pyth-lazer-sdk';
import { LRUCache } from 'lru-cache';

/**
 * Maximum number of feeds we monitor at once. The on-chain
 * `pyth-lazer-oracle-v1.verify-and-update-price-feeds` decodes a single signed message into a
 * `(list 16 ...)` of feeds, so there is no point subscribing to more pairs than we can submit in
 * one transaction.
 */
const MAX_PRICE_FEEDS = 16;

/**
 * All monitored feeds share a single Lazer subscription so they arrive together in one signed
 * message (submittable in one tx). This is its fixed id.
 */
const SUBSCRIPTION_ID = 1;

/**
 * Default price feed symbols to subscribe to. New pairs will be added to the subscription on
 * demand.
 */
const DEFAULT_SYMBOLS = ['Crypto.BTC/USD', 'Crypto.STX/USD', 'Crypto.USDC/USD'];

/**
 * Invoked for each binary update on the subscription, carrying the signed `evm` payload (for
 * on-chain submission) and the parsed prices (for the relaying heuristic).
 */
export type PythPricePayloadHandler = (evm: Buffer, parsed: ParsedPayload) => void;

/**
 * Parses a Pyth Lazer channel string into a Channel enum value.
 * @param channel - The channel string.
 * @returns The Channel enum value.
 */
function parsePythLazerChannel(channel: string): Channel {
  switch (channel) {
    case 'fixed_rate_50ms':
      return 'fixed_rate@50ms';
    case 'fixed_rate_200ms':
      return 'fixed_rate@200ms';
    case 'fixed_rate_1000ms':
      return 'fixed_rate@1000ms';
    case 'real_time':
      return 'real_time';
    default:
      throw new Error(`Invalid Pyth Lazer channel: ${channel}`);
  }
}

/**
 * Connects to the Pyth Lazer websocket service and maintains a single subscription covering up to
 * {@link MAX_PRICE_FEEDS} price pairs. The monitored set is held in an LRU cache; adding a pair (or
 * evicting the least-recently-used one when full) refreshes the subscription so it always reflects
 * the current set under one {@link SUBSCRIPTION_ID}. All feeds therefore arrive in one signed
 * message that can be relayed to a contract in a single transaction.
 */
export class PythSymbolMonitor {
  private pythClient?: PythLazerClient;
  private readonly channel: Channel;
  private readonly apiKey: string;
  private readonly numConnections: number;
  /** Whether the single subscription is currently active on the stream. */
  private subscribed = false;
  /** Most recent parsed payload (all feeds) seen on the subscription, if any. */
  private latestPayload?: ParsedPayload;
  /** Monitored symbols, capped at {@link MAX_PRICE_FEEDS}. The value is unused. */
  private readonly symbolCache: LRUCache<string, boolean>;
  /** Optional consumer of each update (e.g. the relaying heuristic). */
  private onPayload?: PythPricePayloadHandler;

  constructor(opts: { channel: string; apiKey: string; numConnections: number }) {
    this.channel = parsePythLazerChannel(opts.channel);
    this.apiKey = opts.apiKey;
    this.numConnections = opts.numConnections;
    this.symbolCache = new LRUCache<string, boolean>({
      max: MAX_PRICE_FEEDS,
      dispose: (_value, symbol) => {
        // Eviction only logs; `refreshSubscription` (run by the mutator after
        // the cache settles) rebuilds the subscription from the surviving keys.
        logger.debug(`${this.constructor.name} evicting symbol ${symbol} from cache`);
      },
    });
    // Seed the default symbols. The subscription is created lazily in `start()`.
    for (const symbol of DEFAULT_SYMBOLS) {
      this.requestPriceUpdate(symbol);
    }
  }

  /**
   * Establishes the connection pool and subscribes to the full monitored set.
   * @param onPayload - The handler for the price payload.
   */
  async start(onPayload?: PythPricePayloadHandler): Promise<void> {
    if (this.pythClient) {
      logger.debug(`${this.constructor.name} already started; skipping start()`);
      return;
    }
    if (onPayload) this.onPayload = onPayload;
    logger.info(`${this.constructor.name} connecting to Pyth Lazer channel ${this.channel}`);
    this.pythClient = await PythLazerClient.create({
      token: this.apiKey,
      webSocketPoolConfig: {
        numConnections: this.numConnections,
        urls: [
          'wss://pyth-lazer-0.dourolabs.app/v1/stream',
          'wss://pyth-lazer-1.dourolabs.app/v1/stream',
          'wss://pyth-lazer-2.dourolabs.app/v1/stream',
        ],
        onWebSocketError: error => {
          logger.error({ error }, `${this.constructor.name} websocket connection error`);
        },
        onWebSocketPoolError: error => {
          logger.error(error, `${this.constructor.name} websocket pool error`);
        },
      },
    });
    this.pythClient.addMessageListener(this.handleMessage);
    this.pythClient.addAllConnectionsDownListener(() => {
      logger.error(`${this.constructor.name} all Pyth Lazer connections are down`);
    });
    this.pythClient.addConnectionRestoredListener(() => {
      logger.info(`${this.constructor.name} Pyth Lazer connection restored`);
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
    logger.info(`${this.constructor.name} stopped`);
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
      logger.info(`${this.constructor.name} no symbols to monitor; subscription cleared`);
      return;
    }
    this.pythClient.subscribe({
      type: 'subscribe',
      subscriptionId: SUBSCRIPTION_ID,
      symbols,
      properties: [
        'price',
        'exponent',
        'publisherCount',
        'confidence',
        'bestBidPrice',
        'bestAskPrice',
        'emaPrice',
        'emaConfidence',
      ],
      formats: ['evm'],
      deliveryFormat: 'binary',
      parsed: true,
      channel: this.channel,
    });
    this.subscribed = true;
    logger.info(
      { subscriptionId: SUBSCRIPTION_ID, symbols },
      `${this.constructor.name} subscribed to ${symbols.length} feed(s)`
    );
  }

  private readonly handleMessage = (event: JsonOrBinaryResponse): void => {
    if (event.type !== 'binary') {
      // JSON control/error responses (subscription acks, etc.).
      logger.debug({ value: event.value }, `${this.constructor.name} received json message`);
      return;
    }

    if (event.value.subscriptionId !== SUBSCRIPTION_ID) {
      logger.debug(
        `${this.constructor.name} received message for unknown subscription ${event.value.subscriptionId}, unsubscribing`
      );
      this.pythClient?.unsubscribe(event.value.subscriptionId);
      return;
    }

    const { parsed, evm } = event.value;
    if (!parsed) return;
    this.latestPayload = parsed;

    // Hand the signed `evm` payload + parsed prices to the relaying heuristic.
    if (evm) this.onPayload?.(evm, parsed);
    logger.trace(event.value, `${this.constructor.name} received price update`);
  };
}
