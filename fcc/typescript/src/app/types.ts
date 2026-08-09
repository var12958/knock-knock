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

/**
 * Private input supplied to the TEE Twitter verification job. ABI-encoded as
 * `["address", "string"]` and passed as the originalMessage.
 */
export interface TwitterVerificationRequest {
  /** Sender wallet address (private input, used as the FDC request salt). */
  address: string;
  /** Twitter handle to verify, without the leading @. */
  twitterHandle: string;
}

/** Public output returned by the TEE Twitter verification job. */
export interface TwitterVerificationResponse {
  /** Whether the FDC attestation confirmed the handle is a verified account. */
  isTwitterVerified: boolean;
  /** The handle that was attested, echoed back for binding. */
  twitterHandle: string;
  /** FDC request hash / attestation id for auditability. */
  attestationId: string;
}

/**
 * Private input supplied to the TEE behavioral Sybil-detection job.
 * ABI-encoded as `["address"]` and passed as the originalMessage.
 */
export interface MlBehaviorRequest {
  /** Wallet address whose on-chain behavior will be analyzed. */
  targetAddress: string;
}

/**
 * Public output returned by the TEE behavioral Sybil-detection job.
 * Probabilities are returned as basis points (0–10000) so the response can be
 * ABI-encoded for Solidity consumption without floating-point types.
 */
export interface MlBehaviorResponse {
  /** Probability the wallet is human, in basis points (0–10000). */
  humanProbability: number;
  /** Probability the wallet is a bot, in basis points (0–10000). */
  botProbability: number;
  /** Top three human-readable factors driving the prediction. */
  explanation: string[];
  /** Model version string for auditability. */
  modelVersion: string;
  /** Wallet address the attestation was computed for. */
  targetAddress: string;
  /** Address of the TEE signer that produced the attestation. */
  signerAddress: string;
  /** Unix timestamp (seconds) when the attestation was produced. */
  timestamp: number;
  /**
   * ECDSA signature over
   *   keccak256(opType || opCommand || humanProbability || botProbability || targetAddress || signerAddress || modelVersion || timestamp || explanationHash).
   */
  signature: string;
}

/**
 * FDC Web2Json attestation request body.
 * @dev Mirrors the Flare Data Connector `Web2Json` request schema. The
 *      `data.jmespathExpression` field is the JMESPath rule that extracts the
 *      `verified` boolean (or follower count) from the Twitter API response.
 */
export interface FdcWeb2JsonRequest {
  /** Attestation type, e.g. "Web2Json" (encoded to bytes32 by the verifier). */
  attestationType: string;
  /** Data source id for the FDC, e.g. "twitter". */
  sourceId: string;
  /** Monotonic request id, 0 for single-shot attestations. */
  requestId: number;
  /** Web2 fetch parameters. */
  data: {
    /** Full Twitter v2 URL (or mock endpoint) to fetch. */
    url: string;
    /** JSON-encoded request headers (e.g. the bearer token). */
    headers: string;
    /** JSON-encoded POST parameters, empty for GET. */
    postParameters: string;
    /** JSON-encoded request body, empty for GET. */
    body: string;
    /** Expected response type for ABI decoding. */
    responseType: string;
    /** HTTP method, "GET" or "POST". */
    httpMethod: string;
    /** JMESPath expression selecting the field to attest. */
    jmespathExpression: string;
  };
}

/** Status payload returned by the FDC verifier while polling. */
export interface FdcAttestationStatus {
  status: "WAITING" | "PENDING" | "DONE" | "REJECTED" | string;
  response?: {
    encodedData?: string;
    abiEncodedRequest?: string;
    merkleProof?: unknown;
  };
  error?: string;
  message?: string;
}
