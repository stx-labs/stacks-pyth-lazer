import { logger } from '@stacks/api-toolkit';

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
 * Submits a signed Pyth Lazer `evm` payload to
 * `pyth-lazer-oracle-v1.verify-and-update-price-feeds` on Stacks. The real
 * implementation (transaction build, signing, nonce management, broadcast) is a
 * later step; the planner depends only on this interface so its decision logic
 * can be exercised without broadcasting.
 */
export interface PriceFeedSubmitter {
  submit(evm: Buffer): Promise<SubmitResult>;
}

/**
 * No-op submitter that logs instead of broadcasting. Lets the relaying heuristic
 * run end-to-end (decisions, baseline updates, cadence) before the on-chain
 * submitter exists.
 */
export class LoggingSubmitter implements PriceFeedSubmitter {
  async submit(evm: Buffer): Promise<SubmitResult> {
    logger.info(
      { bytes: evm.length },
      '[Submitter] would submit signed update (logging stub; no broadcast)'
    );
    return { ok: true };
  }
}
