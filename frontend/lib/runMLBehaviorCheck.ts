/**
 * @notice Client helper that asks the FCC proxy to run the TEE ML behavior
 *      check on a target wallet and returns a verified, human-readable score.
 * @dev Mirrors the flow in ChatRoom.tsx but is reusable from any UI surface.
 *      It encodes the address, polls the proxy, decodes the ABI response,
 *      verifies the TEE signature, and validates freshness.
 */

import { ethers } from "ethers";

export interface MLBehaviorScore {
  humanProbability: number;
  botProbability: number;
  explanation: string[];
  modelVersion: string;
  targetAddress: string;
  signerAddress: string;
  timestamp: number;
  signature: string;
}

interface ProxyResponse {
  status: number;
  data?: string;
  error?: string;
}

/**
 * Run the TEE ML behavior check against a single wallet address.
 *
 * @param proxyUrl Full URL of the FCC proxy action endpoint, e.g.
 *      `http://localhost:7702/action`.
 * @param targetAddress Wallet address to score.
 * @param expectedSigner Optional expected TEE signer address. If provided, the
 *      recovered signer must match it.
 * @param signal Optional AbortController signal so callers can cancel the call.
 */
export async function runMLBehaviorCheck(
  proxyUrl: string,
  targetAddress: string,
  expectedSigner?: string,
  signal?: AbortSignal,
): Promise<MLBehaviorScore> {
  if (!ethers.isAddress(targetAddress)) {
    throw new Error("Invalid target address for behavior check.");
  }

  const originalMessage = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address"],
    [targetAddress],
  );

  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      opType: "KNOCKKNOCK",
      opCommand: "CHECK_ML_BEHAVIOR",
      originalMessage,
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(could not read body)");
    throw new Error(`FCC proxy returned HTTP ${response.status}: ${errorText}`);
  }

  const body = (await response.json()) as ProxyResponse;
  if (body.status !== 1 || !body.data) {
    throw new Error(body.error ?? "FCC proxy returned an invalid ML result.");
  }

  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    [
      "uint256",
      "uint256",
      "string[]",
      "string",
      "address",
      "address",
      "uint256",
      "bytes",
    ],
    body.data,
  ) as unknown as [
    bigint,
    bigint,
    string[],
    string,
    string,
    string,
    bigint,
    string,
  ];

  const [humanBp, botBp, explanation, modelVersion, returnedTarget, signerAddress, timestamp, signature] =
    decoded;

  if (returnedTarget.toLowerCase() !== targetAddress.toLowerCase()) {
    throw new Error("TEE attestation does not match the requested address.");
  }
  if (Number(humanBp) + Number(botBp) !== 10_000) {
    throw new Error("TEE attestation returned inconsistent probabilities.");
  }

  const attestationAgeSeconds = Math.abs(
    Math.floor(Date.now() / 1000) - Number(timestamp),
  );
  if (attestationAgeSeconds > 300) {
    throw new Error("TEE attestation is stale.");
  }

  const explanationHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string[]"], [explanation]),
  );
  const signedHash = ethers.keccak256(
    ethers.solidityPacked(
      [
        "bytes32",
        "bytes32",
        "uint256",
        "uint256",
        "address",
        "address",
        "string",
        "uint256",
        "bytes32",
      ],
      [
        ethers.encodeBytes32String("KNOCKKNOCK"),
        ethers.encodeBytes32String("CHECK_ML_BEHAVIOR"),
        humanBp,
        botBp,
        returnedTarget,
        signerAddress,
        modelVersion,
        timestamp,
        explanationHash,
      ],
    ),
  );

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.recoverAddress(signedHash, signature);
  } catch {
    throw new Error("TEE signature could not be recovered.");
  }
  if (recoveredAddress.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error("TEE signature is invalid.");
  }
  if (
    expectedSigner &&
    recoveredAddress.toLowerCase() !== expectedSigner.toLowerCase()
  ) {
    throw new Error("TEE signature does not match the expected signer.");
  }

  return {
    humanProbability: Number(humanBp) / 100,
    botProbability: Number(botBp) / 100,
    explanation,
    modelVersion,
    targetAddress: returnedTarget,
    signerAddress,
    timestamp: Number(timestamp),
    signature,
  };
}

/**
 * Format an ML score as the concise badge text used in pending request cards.
 */
export function formatMLBadge(score: MLBehaviorScore | null): string {
  if (!score) return "";
  return `Human ${score.humanProbability.toFixed(0)}% | Bot ${score.botProbability.toFixed(0)}% — TEE Verified`;
}
