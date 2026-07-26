/**
 * @notice Input/output types for the KnockKnock FCC verification handler.
 */

/** Private input supplied to the TEE verification job. */
export interface VerifySenderRequest {
  /** Address of the sender wallet (private input). */
  sender: string;
  /** Intended receiver of the chat request. */
  receiver: string;
  /** Off-chain-encrypted preview message. */
  encryptedPreview: string;
  /** Unix timestamp after which the proof expires. */
  deadline: bigint;
  /** Chain ID the proof is bound to. */
  chainId: bigint;
  /** Mailbox contract address the proof is bound to. */
  mailbox: string;
}

/** Public output returned by the TEE verification job. */
export interface VerifySenderResponse {
  /** Whether the identity API considers the wallet human enough. */
  isVerifiedHuman: boolean;
  /** Whether the wallet's first transaction is older than the threshold. */
  isOldEnoughWallet: boolean;
  /** Hash binding this proof to the receiver and preview. */
  requestHash: string;
  /**
   * ECDSA signature over
   *   keccak256(chainId || mailbox || sender || isVerifiedHuman || isOldEnoughWallet || requestHash).
   */
  signature: string;
}

/** Shape of the legacy identity API response. */
export interface IdentityScoreResponse {
  score?: number;
  human?: boolean;
}

/** Shape of a Human Passport score API response. */
export interface PassportScoreResponse {
  score?: number | string;
  items?: Array<{ score?: number | string }>;
  evidence?: {
    threshold?: number | string;
    rawScore?: number | string;
  };
  error?: string;
}
