"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ethers, Interface } from "ethers";
import { useWeb3 } from "@/context/Web3Context";
import {
  getMailboxContractWrite,
  getFCCVerifierContractWrite,
  MAILBOX_ADDRESS,
  FCC_VERIFIER_ADDRESS,
  FCC_VERIFIER_ABI,
} from "@/lib/contracts";
import { encodePreview } from "@/lib/encodePreview";
import { publishChatRequest } from "@/lib/firebaseFunctions";
import { COSTON2_CHAIN_ID } from "@/lib/chain";

/** Max raw UTF-8 bytes the contract accepts before hex encoding. */
const MAX_PREVIEW_BYTES = 511;

/** How far in the future the TEE proof expires (10 minutes). */
const PROOF_DEADLINE_SECONDS = 10 * 60;

/** How long to wait between polls when the proxy is asynchronous. */
const PROOF_POLL_INTERVAL_MS = 3_000;

/** Give up on proof polling after this many attempts. */
const PROOF_POLL_MAX_ATTEMPTS = 40;

type SendStatus =
  | { stage: "idle" }
  | { stage: "requesting" }
  | { stage: "waiting-proof"; requestHash: string }
  | { stage: "submitting" }
  | { stage: "done"; txHash: string };

interface SendRequestFormProps {
  /** Called after the on-chain request is successfully mined. */
  onMessageSent?: () => void;
}

export default function SendRequestForm({ onMessageSent }: SendRequestFormProps) {
  const { signer, address, chainId } = useWeb3();
  const [receiver, setReceiver] = useState("");
  const [preview, setPreview] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SendStatus>({ stage: "idle" });

  const isMountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, []);

  function setStatusIfMounted(next: SendStatus) {
    if (isMountedRef.current) setStatus(next);
  }

  function setErrorIfMounted(next: string | null) {
    if (isMountedRef.current) setError(next);
  }

  function setTxHashIfMounted(next: string | null) {
    if (isMountedRef.current) setTxHash(next);
  }

  function setIsSendingIfMounted(next: boolean) {
    if (isMountedRef.current) setIsSending(next);
  }

  function setIsSuccessIfMounted(next: boolean) {
    if (isMountedRef.current) setIsSuccess(next);
  }

  const isConnected = Boolean(signer && address);
  const isWrongNetwork = chainId !== null && chainId !== COSTON2_CHAIN_ID;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    console.log("[SendRequestForm] handleSubmit started");

    setErrorIfMounted(null);
    setTxHashIfMounted(null);
    setIsSuccessIfMounted(false);
    setStatusIfMounted({ stage: "idle" });

    if (!signer || !address) {
      console.log("[SendRequestForm] no signer/address");
      setErrorIfMounted("Please connect your wallet first.");
      return;
    }

    if (isWrongNetwork) {
      console.log("[SendRequestForm] wrong network", chainId);
      setErrorIfMounted("Please switch to the Flare Coston2 network.");
      return;
    }

    if (!MAILBOX_ADDRESS || MAILBOX_ADDRESS === "0x" + "0".repeat(40)) {
      setErrorIfMounted("Mailbox contract address is not configured.");
      return;
    }

    if (!FCC_VERIFIER_ADDRESS || FCC_VERIFIER_ADDRESS === "0x" + "0".repeat(40)) {
      setErrorIfMounted("FCC verifier contract address is not configured.");
      return;
    }

    if (!ethers.isAddress(receiver)) {
      setErrorIfMounted("Please enter a valid Flare wallet address.");
      return;
    }

    if (!preview.trim()) {
      setErrorIfMounted("Preview message cannot be empty.");
      return;
    }

    if (ethers.toUtf8Bytes(preview).length > MAX_PREVIEW_BYTES) {
      setErrorIfMounted(
        `Preview message is too long (max ${MAX_PREVIEW_BYTES} bytes).`
      );
      return;
    }

    const proxyUrl = process.env.NEXT_PUBLIC_FCC_PROXY_URL?.trim();
    if (!proxyUrl) {
      setErrorIfMounted(
        "FCC proxy URL is not configured. Set NEXT_PUBLIC_FCC_PROXY_URL in frontend/.env.local (e.g. http://localhost:7702/action for local dev)."
      );
      return;
    }

    setIsSendingIfMounted(true);
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const provider = signer.provider;
      if (!provider) {
        throw new Error("Wallet provider is not available.");
      }

      console.log("[SendRequestForm] fetching latest block...");
      const latestBlock = await provider.getBlock("latest");
      if (!latestBlock) {
        throw new Error("Unable to fetch the latest block.");
      }
      const deadline = BigInt(
        Math.floor(Number(latestBlock.timestamp)) + PROOF_DEADLINE_SECONDS
      );
      const encodedPreview = encodePreview(preview);

      const originalMessage = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "string", "uint256", "uint256", "address"],
        [address, receiver, encodedPreview, deadline, BigInt(COSTON2_CHAIN_ID), MAILBOX_ADDRESS]
      );
      console.log("[SendRequestForm] encoded originalMessage:", originalMessage);

      console.log("[SendRequestForm] calling verifier.requestVerification...");
      setStatusIfMounted({ stage: "requesting" });
      const verifier = getFCCVerifierContractWrite(signer);
      const requestTx = await verifier.requestVerification(
        receiver,
        encodedPreview,
        deadline,
        MAILBOX_ADDRESS,
        { value: 0 }
      );
      console.log("[SendRequestForm] MetaMask signed requestVerification tx:", requestTx.hash);

      console.log("[SendRequestForm] waiting for requestVerification to mine...");
      const requestReceipt = await requestTx.wait();
      if (!requestReceipt) {
        throw new Error("Verification request transaction did not mine.");
      }
      console.log("[SendRequestForm] requestVerification mined in block:", requestReceipt.blockNumber);

      const iface = new Interface(FCC_VERIFIER_ABI);
      const verificationLog = requestReceipt.logs
        .map((log: ethers.Log) => {
          try {
            return iface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: ethers.LogDescription | null) => parsed?.name === "VerificationRequested");

      if (!verificationLog) {
        throw new Error("Could not find VerificationRequested event in the transaction receipt.");
      }
      const requestHash = verificationLog.args.requestHash as string;
      console.log("[SendRequestForm] extracted requestHash:", requestHash);
      setStatusIfMounted({ stage: "waiting-proof", requestHash });

      console.log("[SendRequestForm] fetching TEE proof from proxy...");
      const proof = await fetchProof(proxyUrl, originalMessage, requestHash, abortController.signal);
      console.log("[SendRequestForm] proof received:", {
        isVerifiedHuman: proof.isVerifiedHuman,
        isOldEnoughWallet: proof.isOldEnoughWallet,
      });

      console.log("[SendRequestForm] calling mailbox.sendRequestWithProof...");
      setStatusIfMounted({ stage: "submitting" });
      const mailbox = getMailboxContractWrite(signer);

      // Normalize argument types to exactly match the contract ABI:
      // address, string, bool, bool, uint256, bytes32, bytes
      const normalizedReceiver = ethers.getAddress(receiver);
      const normalizedDeadline = BigInt(deadline);
      const normalizedRequestHash =
        requestHash.length === 66 && requestHash.startsWith("0x")
          ? requestHash
          : ethers.zeroPadValue(requestHash, 32);
      const normalizedSignature =
        typeof proof.signature === "string" && proof.signature.startsWith("0x")
          ? proof.signature
          : ethers.hexlify(proof.signature);

      console.log("[DEBUG] Args:", {
        receiver: normalizedReceiver,
        encodedPreview,
        isVerifiedHuman: Boolean(proof.isVerifiedHuman),
        isOldEnoughWallet: Boolean(proof.isOldEnoughWallet),
        deadline: normalizedDeadline,
        requestHash: normalizedRequestHash,
        signature: normalizedSignature,
      });

      let submitTx;
      try {
        submitTx = await mailbox.sendRequestWithProof(
          normalizedReceiver,
          encodedPreview,
          Boolean(proof.isVerifiedHuman),
          Boolean(proof.isOldEnoughWallet),
          normalizedDeadline,
          normalizedRequestHash,
          normalizedSignature
        );
        console.log("[SendRequestForm] MetaMask signed sendRequestWithProof tx:", submitTx.hash);
      } catch (sendErr: any) {
        console.error("[DEBUG] sendRequestWithProof FAILED:", sendErr);
        console.error("[DEBUG] sendRequestWithProof FAILED code:", sendErr?.code);
        console.error("[DEBUG] sendRequestWithProof FAILED reason:", sendErr?.reason);
        console.error("[DEBUG] sendRequestWithProof FAILED action:", sendErr?.action);
        console.error("[DEBUG] sendRequestWithProof FAILED transaction:", sendErr?.transaction);
        throw sendErr;
      }

      console.log("[SendRequestForm] waiting for sendRequestWithProof to mine...");
      const submitReceipt = await submitTx.wait();
      if (!submitReceipt || submitReceipt.status !== 1) {
        throw new Error("Mailbox transaction failed on-chain.");
      }
      console.log("[SendRequestForm] sendRequestWithProof MINED:", submitReceipt.hash);

      // Set success state immediately after mining. Wrapped in try/catch so
      // any React state error is surfaced and cannot be silently swallowed.
      try {
        setTxHashIfMounted(submitReceipt.hash);
        setStatusIfMounted({ stage: "done", txHash: submitReceipt.hash });
        setIsSuccessIfMounted(true);
        console.log("[SendRequestForm] isSuccess set to TRUE");
      } catch (stateErr) {
        console.error("[SendRequestForm] Failed to set success state:", stateErr);
        throw stateErr;
      }

      // Notify the parent dashboard so the inbox can refresh right away.
      try {
        onMessageSent?.();
        console.log("[SendRequestForm] onMessageSent callback invoked");
      } catch (callbackErr) {
        console.error("[SendRequestForm] onMessageSent callback failed:", callbackErr);
      }

      // Firebase sync is non-critical: it must not reset success state.
      try {
        await publishChatRequest({ txHash: submitReceipt.hash });
        console.log("[SendRequestForm] publishChatRequest succeeded");
      } catch (publishErr: any) {
        console.error("[SendRequestForm] publishChatRequest failed:", publishErr);
        setErrorIfMounted(
          `Request is on-chain, but Firebase sync failed: ${publishErr.message ?? "Unknown error"}. ` +
            "The receiver may need to finish onboarding before chat access works."
        );
      }
    } catch (err: any) {
      console.error("[SendRequestForm] transaction failed:", err);
      setErrorIfMounted(err.reason ?? err.message ?? "Transaction failed");
    } finally {
      setIsSendingIfMounted(false);
      abortControllerRef.current = null;
      console.log("[SendRequestForm] handleSubmit finished");
    }
  }

  /**
   * Fetch a TEE-signed proof from the configured proxy.
   */
  async function fetchProof(
    proxyUrl: string,
    originalMessage: string,
    expectedRequestHash: string,
    signal?: AbortSignal
  ): Promise<{
    isVerifiedHuman: boolean;
    isOldEnoughWallet: boolean;
    signature: string;
  }> {
    const payload = {
      opType: "KNOCKKNOCK",
      opCommand: "VERIFY_SENDER",
      originalMessage,
    };

    function throwIfAborted(): void {
      if (signal?.aborted) {
        throw new Error("Verification cancelled.");
      }
    }

    for (let attempt = 0; attempt < PROOF_POLL_MAX_ATTEMPTS; attempt++) {
      throwIfAborted();
      console.log(`[SendRequestForm] polling proxy attempt ${attempt + 1}/${PROOF_POLL_MAX_ATTEMPTS}`);
      const response = await fetch(proxyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        throw new Error(`FCC proxy returned HTTP ${response.status}`);
      }

      const body = await response.json();

      if (body.status === 0) {
        if (attempt === PROOF_POLL_MAX_ATTEMPTS - 1) {
          throw new Error(body.error ?? "Timed out waiting for the TEE signature.");
        }
        await sleep(PROOF_POLL_INTERVAL_MS);
        continue;
      }

      if (body.status !== 1 || !body.data) {
        throw new Error(body.error ?? "FCC proxy returned an invalid proof.");
      }

      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["bool", "bool", "bytes32", "bytes"],
        body.data
      ) as unknown as [boolean, boolean, string, string];

      const [isVerifiedHuman, isOldEnoughWallet, returnedRequestHash, signature] = decoded;

      if (returnedRequestHash.toLowerCase() !== expectedRequestHash.toLowerCase()) {
        throw new Error("TEE proof request hash does not match the on-chain request.");
      }

      return { isVerifiedHuman, isOldEnoughWallet, signature };
    }

    throw new Error("Timed out waiting for the TEE signature.");
  }

  if (isSuccess) {
    console.log("Rendering success screen");
    return (
      <div style={{ padding: '20px', border: '1px solid green', color: 'green' }}>
        Message sent successfully!{" "}
        <Link href="/inbox">Go to Inbox</Link>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
    >
      <h2 className="mb-6 text-2xl font-bold text-slate-800">Send a Knock 👋</h2>

      <div className="mb-5">
        <label
          htmlFor="receiver"
          className="mb-2 block text-sm font-medium text-slate-700"
        >
          Receiver address
        </label>
        <input
          id="receiver"
          type="text"
          value={receiver}
          onChange={(e) => setReceiver(e.target.value)}
          placeholder="0x..."
          disabled={!isConnected || isSending}
          className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
        />
      </div>

      <div className="mb-5">
        <label
          htmlFor="preview"
          className="mb-2 block text-sm font-medium text-slate-700"
        >
          Encrypted preview message
        </label>
        <textarea
          id="preview"
          value={preview}
          onChange={(e) => setPreview(e.target.value)}
          placeholder="A short message only the receiver will see..."
          rows={3}
          disabled={!isConnected || isSending}
          className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
        />
        <p className="mt-1 text-xs text-slate-500">
          Stored as a hex-encoded string on-chain. Real E2E encryption is
          recommended for production.
        </p>
      </div>

      <div className="mb-6 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800">
        <p className="font-semibold">Privacy-preserving verification</p>
        <p className="mt-1">
          Your wallet age and humanity are checked inside the Flare TEE. The
          resulting proof is submitted to the mailbox — no self-reported boxes
          needed.
        </p>
      </div>

      <button
        type="submit"
        disabled={!isConnected || isSending || isWrongNetwork || !MAILBOX_ADDRESS}
        className="w-full rounded-lg bg-brand-600 px-5 py-3 font-semibold text-white shadow transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {isSending ? progressLabel(status) : "Send Knock"}
      </button>

      {!MAILBOX_ADDRESS && (
        <p className="mt-3 text-sm text-red-600">
          Mailbox contract address is not configured.
        </p>
      )}

      {status.stage !== "idle" && status.stage !== "done" && (
        <p className="mt-3 text-sm text-slate-600">
          {progressDetail(status)}
        </p>
      )}

      {error && (
        <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </form>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progressLabel(status: SendStatus): string {
  switch (status.stage) {
    case "requesting":
      return "Requesting TEE verification…";
    case "waiting-proof":
      return "Waiting for TEE signature…";
    case "submitting":
      return "Submitting proof…";
    default:
      return "Sending Knock…";
  }
}

function progressDetail(status: SendStatus): string {
  switch (status.stage) {
    case "requesting":
      return "Transaction 1/2: posting the private verification job to the Flare TEE network.";
    case "waiting-proof":
      return `Transaction 2/2 pending. Polling proxy for signed proof (request hash ${status.requestHash}).`;
    case "submitting":
      return "Signed proof received — writing the chat request to the mailbox.";
    default:
      return "";
  }
}
