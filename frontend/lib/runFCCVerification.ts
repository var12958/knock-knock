/**
 * @notice Run the full Flare Confidential Compute verification flow for an
 * onboarding user and return the TEE-signed proof.
 * @dev This mirrors the send-side FCC flow in SendRequestForm but without an
 * actual chat receiver. It posts a self-to-self verification request so the
 * TEE can attest to the wallet's humanity and age.
 */

import { ethers, Interface } from "ethers";
import {
  getMailboxContractWrite,
  getFCCVerifierContractWrite,
  MAILBOX_ADDRESS,
  FCC_VERIFIER_ADDRESS,
  FCC_VERIFIER_ABI,
} from "./contracts";
import { COSTON2_CHAIN_ID } from "./chain";

const PROOF_DEADLINE_SECONDS = 10 * 60;
const PROOF_POLL_INTERVAL_MS = 3_000;
const PROOF_POLL_MAX_ATTEMPTS = 40;

interface VerificationProof {
  isVerifiedHuman: boolean;
  isOldEnoughWallet: boolean;
  signature: string;
}

export interface FCCVerificationResult extends VerificationProof {
  txHash: string;
}

/**
 * Request a TEE proof that the connected wallet is human and old enough.
 * @param signer Ethers signer from MetaMask.
 * @param sender Sender wallet address (must match signer).
 */
export async function runFCCVerification(
  signer: ethers.JsonRpcSigner,
  sender: string,
): Promise<FCCVerificationResult> {
  console.log("[FCC] Starting verification for sender:", sender);

  if (!MAILBOX_ADDRESS || MAILBOX_ADDRESS === "0x" + "0".repeat(40)) {
    throw new Error("Mailbox contract address is not configured.");
  }
  if (!FCC_VERIFIER_ADDRESS || FCC_VERIFIER_ADDRESS === "0x" + "0".repeat(40)) {
    throw new Error("FCC verifier contract address is not configured.");
  }
  console.log("[FCC] Mailbox:", MAILBOX_ADDRESS);
  console.log("[FCC] Verifier:", FCC_VERIFIER_ADDRESS);

  const proxyUrl = process.env.NEXT_PUBLIC_FCC_PROXY_URL?.trim();
  console.log("[FCC] NEXT_PUBLIC_FCC_PROXY_URL:", proxyUrl ?? "(not set)");
  if (!proxyUrl) {
    throw new Error(
      "FCC proxy URL is not configured. Set NEXT_PUBLIC_FCC_PROXY_URL in .env.local.",
    );
  }

  const provider = signer.provider;
  if (!provider) {
    throw new Error("Wallet provider is not available.");
  }

  console.log("[FCC] Fetching latest block for deadline...");
  const latestBlock = await provider.getBlock("latest");
  if (!latestBlock) {
    throw new Error("Unable to fetch the latest block.");
  }
  console.log("[FCC] Latest block timestamp:", latestBlock.timestamp);

  const deadline = BigInt(
    Math.floor(Number(latestBlock.timestamp)) + PROOF_DEADLINE_SECONDS,
  );

  // Use the sender as both sender and receiver for the onboarding proof.
  // The preview is an empty, valid hex string.
  const encodedPreview = "0x";

  const originalMessage = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "string", "uint256", "uint256", "address"],
    [
      sender,
      sender,
      encodedPreview,
      deadline,
      BigInt(COSTON2_CHAIN_ID),
      MAILBOX_ADDRESS,
    ],
  );
  console.log("[FCC] Encoded originalMessage:", originalMessage);

  console.log("[FCC] Calling verifier.requestVerification on-chain...");
  const verifier = getFCCVerifierContractWrite(signer);
  const requestTx = await verifier.requestVerification(
    sender,
    encodedPreview,
    deadline,
    MAILBOX_ADDRESS,
    { value: 0 },
  );
  console.log("[FCC] requestVerification tx hash:", requestTx.hash);

  console.log("[FCC] Waiting for requestVerification transaction to mine...");
  const requestReceipt = await requestTx.wait();
  if (!requestReceipt) {
    throw new Error("Verification request transaction did not mine.");
  }
  console.log("[FCC] requestVerification mined in block:", requestReceipt.blockNumber);

  const iface = new Interface(FCC_VERIFIER_ABI);
  const verificationLog = requestReceipt.logs
    .map((log: ethers.Log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find(
      (parsed: ethers.LogDescription | null) =>
        parsed?.name === "VerificationRequested",
    );

  if (!verificationLog) {
    throw new Error(
      "Could not find VerificationRequested event in the transaction receipt.",
    );
  }

  const requestHash = verificationLog.args.requestHash as string;
  console.log("[FCC] VerificationRequested requestHash:", requestHash);

  console.log("[FCC] Fetching TEE proof from proxy:", proxyUrl);
  const proof = await fetchProof(proxyUrl, originalMessage, requestHash);
  console.log("[FCC] Proof received:", {
    isVerifiedHuman: proof.isVerifiedHuman,
    isOldEnoughWallet: proof.isOldEnoughWallet,
    signature: proof.signature.slice(0, 42) + "...",
  });

  // Submit the proof to the mailbox so the result is independently
  // verifiable on-chain. The transaction hash is what Firebase rules
  // require as a non-forgeable verification record.
  console.log("[FCC] Submitting proof to mailbox.sendRequestWithProof...");
  const mailbox = getMailboxContractWrite(signer);
  const submitTx = await mailbox.sendRequestWithProof(
    sender,
    encodedPreview,
    proof.isVerifiedHuman,
    proof.isOldEnoughWallet,
    deadline,
    requestHash,
    proof.signature,
  );
  console.log("[FCC] sendRequestWithProof tx hash:", submitTx.hash);

  console.log("[FCC] Waiting for sendRequestWithProof transaction to mine...");
  await submitTx.wait();
  console.log("[FCC] sendRequestWithProof mined");

  return {
    isVerifiedHuman: proof.isVerifiedHuman,
    isOldEnoughWallet: proof.isOldEnoughWallet,
    signature: proof.signature,
    txHash: submitTx.hash,
  };
}

async function fetchProof(
  proxyUrl: string,
  originalMessage: string,
  expectedRequestHash: string,
): Promise<VerificationProof> {
  const payload = {
    opType: "KNOCKKNOCK",
    opCommand: "VERIFY_SENDER",
    originalMessage,
  };

  for (let attempt = 0; attempt < PROOF_POLL_MAX_ATTEMPTS; attempt++) {
    console.log(
      `[FCC] Polling proxy attempt ${attempt + 1}/${PROOF_POLL_MAX_ATTEMPTS} to ${proxyUrl}`,
    );

    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    console.log("[FCC] Proxy response status:", response.status);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "(could not read body)");
      console.error("[FCC] Proxy error body:", errorText);
      throw new Error(`FCC proxy returned HTTP ${response.status}`);
    }

    const body = await response.json();
    console.log("[FCC] Proxy response body:", {
      status: body.status,
      error: body.error ?? null,
      data: body.data ? body.data.slice(0, 80) + "..." : null,
    });

    if (body.status === 0) {
      if (attempt === PROOF_POLL_MAX_ATTEMPTS - 1) {
        throw new Error(body.error ?? "Timed out waiting for the TEE signature.");
      }
      console.log(`[FCC] Proof not ready, sleeping ${PROOF_POLL_INTERVAL_MS}ms...`);
      await sleep(PROOF_POLL_INTERVAL_MS);
      continue;
    }

    if (body.status !== 1 || !body.data) {
      throw new Error(body.error ?? "FCC proxy returned an invalid proof.");
    }

    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bool", "bool", "bytes32", "bytes"],
      body.data,
    ) as unknown as [boolean, boolean, string, string];

    const [isVerifiedHuman, isOldEnoughWallet, returnedRequestHash, signature] =
      decoded;

    console.log("[FCC] Decoded proof:", {
      isVerifiedHuman,
      isOldEnoughWallet,
      returnedRequestHash,
      signature: signature.slice(0, 42) + "...",
    });

    if (
      returnedRequestHash.toLowerCase() !== expectedRequestHash.toLowerCase()
    ) {
      throw new Error("TEE proof request hash does not match the on-chain request.");
    }

    return { isVerifiedHuman, isOldEnoughWallet, signature };
  }

  throw new Error("Timed out waiting for the TEE signature.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
