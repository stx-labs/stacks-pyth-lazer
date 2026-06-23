import { logger } from '@stacks/api-toolkit';
import {
  Cl,
  broadcastTransaction,
  fetchNonce,
  getAddressFromPrivateKey,
  makeContractCall,
  type TxBroadcastResult,
} from '@stacks/transactions';

/** Contracts (all under the same deployer) and the write entry point. */
const ORACLE_CONTRACT_NAME = 'pyth-lazer-oracle-v1';
const DECODER_CONTRACT_NAME = 'pyth-lazer-decoder-v1';
const UPDATE_FUNCTION_NAME = 'verify-and-update-price-feeds';

/**
 * Broadcast rejection reasons that mean our locally-tracked nonce is stale; on
 * these we drop it and refetch from chain before the next attempt.
 */
const NONCE_REJECTION_REASONS = new Set<string>([
  'BadNonce',
  'ConflictingNonceInMempool',
  'TooMuchChaining',
]);

/** Outcome of attempting to submit a signed update on-chain. */
export interface SubmitResult {
  /** Whether the update was accepted (broadcast) successfully. */
  ok: boolean;
  /** Transaction id, when broadcast succeeded. */
  txId?: string;
  /** Failure detail, when `ok` is false. */
  error?: string;
}

/**
 * Builds, signs, and broadcasts the `verify-and-update-price-feeds` contract call with the signed
 * `evm` payload and the blessed decoder. The planner serializes calls (one in-flight at a time), so
 * this tracks the sender nonce locally and only refetches it from chain on first use or after a
 * nonce-related rejection — the node's confirmed nonce would lag behind our still-unconfirmed
 * submissions.
 */
export class PriceUpdateTransactionSubmitter {
  private readonly senderKey;
  private readonly network: 'mainnet' | 'testnet';
  private readonly deployer: string;
  private readonly rpcBaseUrl: string;
  private readonly senderAddress: string;
  private readonly txFeeMicroStx?: number;
  /** Next nonce to use; `undefined` forces a refetch from chain. */
  private nonce?: bigint;

  constructor(options: {
    senderKey: string;
    network: 'mainnet' | 'testnet';
    deployer: string;
    rpcBaseUrl: string;
    txFeeMicroStx?: number;
  }) {
    this.senderKey = options.senderKey;
    this.network = options.network;
    this.deployer = options.deployer;
    this.rpcBaseUrl = options.rpcBaseUrl;
    this.txFeeMicroStx = options.txFeeMicroStx;
    this.senderAddress = getAddressFromPrivateKey(this.senderKey, this.network);
  }

  async submit(evm: Buffer): Promise<SubmitResult> {
    try {
      const nonce = await this.nextNonce();
      const transaction = await makeContractCall({
        contractAddress: this.deployer,
        contractName: ORACLE_CONTRACT_NAME,
        functionName: UPDATE_FUNCTION_NAME,
        functionArgs: [Cl.buffer(evm), Cl.contractPrincipal(this.deployer, DECODER_CONTRACT_NAME)],
        senderKey: this.senderKey,
        network: this.network,
        client: { baseUrl: this.rpcBaseUrl },
        nonce,
        ...(this.txFeeMicroStx != null ? { fee: this.txFeeMicroStx } : {}),
        // The oracle transfers the governance fee from tx-sender, so post
        // conditions can't be enumerated up front — allow them.
        postConditionMode: 'allow',
      });

      const result = await broadcastTransaction({
        transaction,
        network: this.network,
        client: { baseUrl: this.rpcBaseUrl },
      });
      return this.handleBroadcastResult(result, nonce);
    } catch (error) {
      // Build/network failure: drop the cached nonce so the next attempt refetches.
      this.nonce = undefined;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(error, `${this.constructor.name} failed to build/broadcast update: ${message}`);
      return { ok: false, error: message };
    }
  }

  private handleBroadcastResult(result: TxBroadcastResult, usedNonce: bigint): SubmitResult {
    if (!('error' in result)) {
      // A mined tx consumes its nonce even if the contract later aborts, so
      // optimistically advance to chain the next submission.
      this.nonce = usedNonce + 1n;
      logger.info(
        { txId: result.txid, nonce: Number(usedNonce) },
        `${this.constructor.name} broadcast price update`
      );
      return { ok: true, txId: result.txid };
    }

    if (NONCE_REJECTION_REASONS.has(result.reason)) {
      this.nonce = undefined; // stale nonce; refetch next attempt
    }
    logger.error(
      { reason: result.reason, error: result.error, txId: result.txid },
      `${this.constructor.name} broadcast rejected: ${result.reason}`
    );
    return { ok: false, error: `${result.reason}: ${result.error}` };
  }

  private async nextNonce(): Promise<bigint> {
    if (this.nonce === undefined) {
      this.nonce = await fetchNonce({
        address: this.senderAddress,
        network: this.network,
        client: { baseUrl: this.rpcBaseUrl },
      });
    }
    return this.nonce;
  }
}
