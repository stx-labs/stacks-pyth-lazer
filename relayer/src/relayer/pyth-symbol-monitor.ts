import { logger } from '@stacks/api-toolkit';
import {
  PythLazerClient,
  type Channel,
  type JsonOrBinaryResponse,
  type ParsedPayload,
  type Response as LazerControlMessage,
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
  private readonly catalogRefreshMs: number;
  /** Whether the single subscription is currently active on the stream. */
  private subscribed = false;
  /** Most recent parsed payload (all feeds) seen on the subscription, if any. */
  private latestPayload?: ParsedPayload;
  /** Monitored symbols, capped at {@link MAX_PRICE_FEEDS}. The value is unused. */
  private readonly symbolCache: LRUCache<string, boolean>;
  /** Optional consumer of each update (e.g. the relaying heuristic). */
  private onPayload?: PythPricePayloadHandler;
  /**
   * Valid Lazer symbols (both `name` and `symbol` forms), loaded from the catalog at `start()`.
   * `undefined` means the catalog is unavailable, in which case validation fails open (accepts)
   * rather than blocking the relayer.
   */
  private validSymbols?: Set<string>;
  /** Periodic catalog-refresh timer. */
  private catalogTimer?: ReturnType<typeof setInterval>;

  constructor(opts: {
    channel: string;
    apiKey: string;
    numConnections: number;
    catalogRefreshMs: number;
  }) {
    this.channel = parsePythLazerChannel(opts.channel);
    this.apiKey = opts.apiKey;
    this.numConnections = opts.numConnections;
    this.catalogRefreshMs = opts.catalogRefreshMs;
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

    // Load the Pyth symbol catalog so `requestPriceUpdate` can validate new pairs, and keep it
    // fresh (feeds get added/removed over time).
    await this.loadSymbolCatalog();
    this.catalogTimer = setInterval(() => {
      void this.loadSymbolCatalog();
    }, this.catalogRefreshMs);
    this.catalogTimer.unref?.(); // don't keep the process alive for the refresh

    // Subscribe to every symbol queued before the client connected.
    this.refreshSubscription();
  }

  /**
   * Loads the Lazer symbol catalog into {@link validSymbols}. Fails open: on error the set is left
   * as-is so symbol validation never blocks the relayer.
   */
  private async loadSymbolCatalog(): Promise<void> {
    if (!this.pythClient) return;
    try {
      const catalog = await this.pythClient.getSymbols();
      // Accept either identifier form; we validate the literal string we subscribe with.
      this.validSymbols = new Set(catalog.flatMap(entry => [entry.name, entry.symbol]));
      logger.info(
        { count: this.validSymbols.size },
        `${this.constructor.name} loaded Pyth Lazer symbol catalog`
      );
    } catch (error) {
      logger.error(error, `${this.constructor.name} failed to load symbol catalog`);
    }
  }

  /** The most recent parsed payload (all feeds) seen on the subscription, if any. */
  get lastPayload(): ParsedPayload | undefined {
    return this.latestPayload;
  }

  /**
   * Tears down the connection pool. Safe to call when not started.
   */
  async stop(): Promise<void> {
    if (this.catalogTimer) {
      clearInterval(this.catalogTimer);
      this.catalogTimer = undefined;
    }
    if (!this.pythClient) return;
    this.pythClient.shutdown();
    this.pythClient = undefined;
    this.subscribed = false;
    logger.info(`${this.constructor.name} stopped`);
  }

  /**
   * Requests live updates for a pair on behalf of an external caller. Adds the pair to the LRU
   * cache (evicting the least-recently-used pair if at capacity) and refreshes the subscription. If
   * the pair is already monitored this only bumps its recency in the cache and leaves the
   * subscription unchanged.
   * @param symbol - Pyth Lazer symbol, e.g. `Crypto.BTC/USD`.
   * @returns `false` if the symbol is not in the Lazer catalog (rejected without
   *   touching the subscription); `true` if it is now monitored.
   */
  requestPriceUpdate(symbol: string): boolean {
    if (!this.isKnownSymbol(symbol)) {
      logger.warn(`${this.constructor.name} rejecting unknown symbol ${symbol}`);
      return false;
    }
    if (this.symbolCache.get(symbol)) return true; // already monitored; bumps recency
    this.symbolCache.set(symbol, true);
    this.refreshSubscription();
    return true;
  }

  /**
   * Whether a symbol is in the Lazer catalog. Fails open (accepts) when the catalog has not been
   * loaded yet — e.g. seeding defaults before `start()`.
   * @param symbol - Pyth Lazer symbol to check.
   */
  private isKnownSymbol(symbol: string): boolean {
    return this.validSymbols === undefined || this.validSymbols.has(symbol);
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
      // Backstop: never let one bad symbol fail the whole subscription. Lazer subscribes to the
      // valid feeds and reports the rest via `subscribedWithInvalidFeedIdsIgnored`, which we evict
      // in `handleMessage`.
      ignoreInvalidFeedIds: true,
      channel: this.channel,
    });
    this.subscribed = true;
    logger.info(
      { subscriptionId: SUBSCRIPTION_ID, symbols },
      `${this.constructor.name} subscribed to ${symbols.length} feed(s)`
    );
  }

  /**
   * Handles a JSON control message (subscription ack / error) from Lazer.
   * @param message - The parsed control response.
   */
  private handleControlMessage(message: LazerControlMessage): void {
    switch (message.type) {
      case 'subscribedWithInvalidFeedIdsIgnored': {
        // Lazer accepted the valid feeds and skipped these. Drop them so they
        // don't ride along in every future `refreshSubscription`.
        const { unknownSymbols, unknownIds } = message.ignoredInvalidFeedIds;
        logger.warn(
          { subscriptionId: message.subscriptionId, unknownSymbols, unknownIds },
          `${this.constructor.name} Lazer ignored invalid feeds; evicting them`
        );
        for (const symbol of unknownSymbols) this.symbolCache.delete(symbol);
        break;
      }
      case 'error':
        logger.error({ error: message.error }, `${this.constructor.name} Lazer stream error`);
        this.subscribed = false;
        break;
      case 'subscriptionError':
        logger.error(
          { subscriptionId: message.subscriptionId, error: message.error },
          `${this.constructor.name} Lazer subscription error`
        );
        if (message.subscriptionId === SUBSCRIPTION_ID) this.subscribed = false;
        break;
      case 'subscribed':
        logger.info(
          { subscriptionId: message.subscriptionId },
          `${this.constructor.name} Lazer subscription confirmed`
        );
        break;
      default:
        logger.debug({ value: message }, `${this.constructor.name} received json message`);
    }
  }

  private readonly handleMessage = (event: JsonOrBinaryResponse): void => {
    if (event.type !== 'binary') {
      this.handleControlMessage(event.value);
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
