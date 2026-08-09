"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ethers, Interface } from "ethers";
import { set as fbSet, ref as fbRef } from "firebase/database";
import { useWeb3 } from "@/context/Web3Context";
import { useFirebaseAuth } from "@/context/FirebaseAuthContext";
import {
  getMailboxContractWrite,
  getFCCVerifierContractWrite,
  MAILBOX_ADDRESS,
  MAILBOX_ABI,
  FCC_VERIFIER_ADDRESS,
  FCC_VERIFIER_ABI,
} from "@/lib/contracts";
import { realtimeDb } from "@/lib/firebase";
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

/** Maximum number of comma-separated receivers allowed in one Group Knock. */
const MAX_RECEIVERS = 3;

type SendStatus =
  | { stage: "idle" }
  | {
      stage: "requesting";
      current: number;
      total: number;
      receiver: string;
    }
  | {
      stage: "waiting-proof";
      current: number;
      total: number;
      receiver: string;
      requestHash: string;
    }
  | {
      stage: "submitting";
      current: number;
      total: number;
      receiver: string;
    }
  | { stage: "done"; txHash: string };

interface SendRequestFormProps {
  /** Called after the on-chain request is successfully mined. */
  onMessageSent?: () => void;
}

export default function SendRequestForm({ onMessageSent }: SendRequestFormProps) {
  const { signer, address, chainId } = useWeb3();
  const { user } = useFirebaseAuth();
  const [receiversString, setReceiversString] = useState("");
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

    if (!MAILBOX_ADDRESS || MAILBOX_ADDRESS === "0x" + "0".repeat(40)) {
      setErrorIfMounted("Mailbox contract address is not configured.");
      return;
    }

    if (!FCC_VERIFIER_ADDRESS || FCC_VERIFIER_ADDRESS === "0x" + "0".repeat(40)) {
      setErrorIfMounted("FCC verifier contract address is not configured.");
      return;
    }

    const proxyUrl = process.env.NEXT_PUBLIC_FCC_PROXY_URL?.trim();
    if (!proxyUrl) {
      setErrorIfMounted(
        "FCC proxy URL is not configured. Set NEXT_PUBLIC_FCC_PROXY_URL in frontend/.env.local (e.g. http://localhost:7702/action for local dev)."
      );
      return;
    }

    // Parse the comma-separated receiver list: trim, drop empties, and
    // case-insensitively de-duplicate while preserving entry order. Enforce the
    // max-receiver cap and validate each remaining address.
    const rawReceivers = receiversString
      .split(",")
      .map((addr) => addr.trim())
      .filter((addr) => addr.length > 0);

    if (rawReceivers.length === 0) {
      setErrorIfMounted("Please enter at least one Flare wallet address.");
      return;
    }

    const seen = new Set<string>();
    const receiversArray = rawReceivers.filter((addr) => {
      const key = addr.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (receiversArray.length > MAX_RECEIVERS) {
      setErrorIfMounted(
        `You can knock at most ${MAX_RECEIVERS} addresses at once.`
      );
      return;
    }

    const invalidAddress = receiversArray.find(
      (addr) => !ethers.isAddress(addr),
    );
    if (invalidAddress) {
      setErrorIfMounted(`Invalid Flare wallet address: ${invalidAddress}`);
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

      // Shared contract instances — created once, reused for each receiver.
      const verifier = getFCCVerifierContractWrite(signer);
      const mailbox = getMailboxContractWrite(signer);
      const verifierIface = new Interface(FCC_VERIFIER_ABI);
      const mailboxIface = new Interface(MAILBOX_ABI);

      const total = receiversArray.length;
      const requestIds: string[] = [];
      let lastTxHash = "";

      // Loop through each receiver sequentially: request a TEE proof, wait for
      // the proof, submit it to the mailbox, and wait for THAT transaction to
      // mine before starting the next receiver. The requestId emitted in each
      // `RequestSent` event is collected for the group mapping.
      for (let i = 0; i < receiversArray.length; i++) {
        const receiverAddr = ethers.getAddress(receiversArray[i]);
        const current = i + 1;
        console.log(
          `[SendRequestForm] sending knock ${current}/${total} to ${receiverAddr}`
        );

        // Each receiver needs its own originalMessage because the receiver
        // address is part of the attested payload.
        const originalMessage = ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "string", "uint256", "uint256", "address"],
          [
            address,
            receiverAddr,
            encodedPreview,
            deadline,
            BigInt(COSTON2_CHAIN_ID),
            MAILBOX_ADDRESS,
          ]
        );
        console.log(
          `[SendRequestForm] encoded originalMessage for ${receiverAddr}:`,
          originalMessage
        );

        console.log("[SendRequestForm] calling verifier.requestVerification...");
        setStatusIfMounted({
          stage: "requesting",
          current,
          total,
          receiver: receiverAddr,
        });
        const requestTx = await verifier.requestVerification(
          receiverAddr,
          encodedPreview,
          deadline,
          MAILBOX_ADDRESS,
          { value: 0 }
        );
        console.log(
          "[SendRequestForm] MetaMask signed requestVerification tx:",
          requestTx.hash
        );

        console.log("[SendRequestForm] waiting for requestVerification to mine...");
        const requestReceipt = await requestTx.wait();
        if (!requestReceipt) {
          throw new Error("Verification request transaction did not mine.");
        }
        console.log(
          "[SendRequestForm] requestVerification mined in block:",
          requestReceipt.blockNumber
        );

        const verificationLog = requestReceipt.logs
          .map((log: ethers.Log) => {
            try {
              return verifierIface.parseLog(log);
            } catch {
              return null;
            }
          })
          .find(
            (parsed: ethers.LogDescription | null) =>
              parsed?.name === "VerificationRequested"
          );

        if (!verificationLog) {
          throw new Error(
            "Could not find VerificationRequested event in the transaction receipt."
          );
        }
        const requestHash = verificationLog.args.requestHash as string;
        console.log(
          `[SendRequestForm] extracted requestHash for ${receiverAddr}:`,
          requestHash
        );
        setStatusIfMounted({
          stage: "waiting-proof",
          current,
          total,
          receiver: receiverAddr,
          requestHash,
        });

        console.log("[SendRequestForm] fetching TEE proof from proxy...");
        const proof = await fetchProof(
          proxyUrl,
          originalMessage,
          requestHash,
          abortController.signal
        );
        console.log("[SendRequestForm] proof received:", {
          isVerifiedHuman: proof.isVerifiedHuman,
          isOldEnoughWallet: proof.isOldEnoughWallet,
        });

        console.log("[SendRequestForm] calling mailbox.sendRequestWithProof...");
        setStatusIfMounted({
          stage: "submitting",
          current,
          total,
          receiver: receiverAddr,
        });

        // Normalize argument types to exactly match the contract ABI:
        // address, string, bool, bool, uint256, bytes32, bytes
        const normalizedReceiver = receiverAddr;
        const normalizedDeadline = BigInt(deadline);
        const normalizedRequestHash =
          requestHash.length === 66 && requestHash.startsWith("0x")
            ? requestHash
            : ethers.zeroPadValue(requestHash, 32);
        const normalizedSignature =
          typeof proof.signature === "string" && proof.signature.startsWith("0x")
            ? proof.signature
            : ethers.hexlify(proof.signature);

        console.log(
          "[SendRequestForm] exact _receiver passed to sendRequestWithProof:",
          normalizedReceiver
        );
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
          console.log(
            "[SendRequestForm] MetaMask signed sendRequestWithProof tx:",
            submitTx.hash
          );
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
        console.log(
          "[SendRequestForm] sendRequestWithProof MINED:",
          submitReceipt.hash
        );

        // Extract the on-chain requestId from the `RequestSent` event so we can
        // group multiple knocks together.
        const sentLog = submitReceipt.logs
          .map((log: ethers.Log) => {
            try {
              return mailboxIface.parseLog(log);
            } catch {
              return null;
            }
          })
          .find(
            (parsed: ethers.LogDescription | null) =>
              parsed?.name === "RequestSent"
          );
        if (!sentLog) {
          throw new Error(
            "Could not find RequestSent event in the transaction receipt."
          );
        }
        const requestId = (sentLog.args.requestId as bigint).toString();
        requestIds.push(requestId);
        lastTxHash = submitReceipt.hash;
        console.log(
          `[SendRequestForm] knock ${current}/${total} requestId=${requestId} tx=${submitReceipt.hash}`
        );

        // Firebase sync is non-critical per-receiver: it must not abort the
        // group send. A failure here only means the inbox notification may lag.
        try {
          await publishChatRequest({ txHash: submitReceipt.hash });
          console.log(
            `[SendRequestForm] publishChatRequest succeeded for ${requestId}`
          );
        } catch (publishErr: any) {
          console.error(
            `[SendRequestForm] publishChatRequest failed for ${requestId}:`,
            publishErr
          );
        }
      }

      // As soon as every on-chain sendRequestWithProof has mined, flip the
      // success guard. This is checked first in the render so no later error
      // or status update can hide the success message.
      setIsSuccessIfMounted(true);
      console.log("[SendRequestForm] isSuccess set to TRUE");

      // If more than one receiver was knocked, persist a group mapping so the
      // sidebar can render the multi-party chat as a single Group Chat card.
      // The mapping is written to groups/{uid}/{groupId} from the client; the
      // database rules allow each user to write only their own subtree.
      if (requestIds.length > 1 && user?.uid) {
        const groupId = "group_" + Date.now();
        const createdAt = Date.now();
        if (realtimeDb) {
          try {
            await fbSet(fbRef(realtimeDb, `groups/${user.uid}/${groupId}`), {
              requestIds,
              createdAt,
            });
            console.log(
              "[SendRequestForm] saved group mapping",
              groupId,
              requestIds
            );
          } catch (groupErr: any) {
            // Non-fatal: the individual knocks are already on-chain.
            console.error(
              "[SendRequestForm] failed to save group mapping:",
              groupErr
            );
            setErrorIfMounted(
              `Knocks are on-chain, but the group mapping failed to save: ${
                groupErr.message ?? "Unknown error"
              }.`
            );
          }
        }
      }

      // Final bookkeeping: persist the last transaction hash and mark the
      // status done for any downstream progress UI.
      try {
        setTxHashIfMounted(lastTxHash);
        setStatusIfMounted({ stage: "done", txHash: lastTxHash });
        console.log("[SendRequestForm] status set to done");
      } catch (stateErr) {
        console.error("[SendRequestForm] Failed to set final state:", stateErr);
        throw stateErr;
      }

      // Notify the parent dashboard so the inbox can refresh right away.
      try {
        onMessageSent?.();
        console.log("[SendRequestForm] onMessageSent callback invoked");
      } catch (callbackErr) {
        console.error("[SendRequestForm] onMessageSent callback failed:", callbackErr);
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

  // Absolute first branch of the render: once success is set, nothing else
  // in this component is allowed to override it.
  if (isSuccess) {
    return (
      <div className="bg-[#393E46] text-[#DFD0B8] p-6 rounded-xl border border-[#DFD0B8]/10">
        ✅ Message sent successfully!{" "}
        <Link href="/inbox" className="underline">
          Go to Inbox
        </Link>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mx-auto max-w-xl"
    >
      <h2 className="mb-8 text-3xl font-bold tracking-tight text-[#DFD0B8]">
        Send a Knock
      </h2>

      <div className="mb-6">
        <label
          htmlFor="receivers"
          className="mb-2 block text-sm font-semibold text-[#DFD0B8]"
        >
          Receiver address(es)
          <span className="ml-2 text-xs font-normal text-[#948979]">
            (up to {MAX_RECEIVERS}, comma-separated for a Group Knock)
          </span>
        </label>
        <textarea
          id="receivers"
          value={receiversString}
          onChange={(e) => setReceiversString(e.target.value)}
          placeholder={`Up to ${MAX_RECEIVERS} comma-separated Flare addresses, e.g. 0xA1…, 0xB2…, 0xC3…`}
          rows={2}
          disabled={!isConnected || isSending}
          className="w-full resize-none rounded-xl border border-[#948979]/50 bg-[#222831] px-4 py-3.5 text-sm text-[#DFD0B8] transition-all duration-200 placeholder:text-[#948979]/60 focus:border-[#DFD0B8] focus:outline-none focus:ring-1 focus:ring-[#DFD0B8]/50 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      <div className="mb-6">
        <label
          htmlFor="preview"
          className="mb-2 block text-sm font-semibold text-[#DFD0B8]"
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
          className="w-full resize-none rounded-xl border border-[#948979]/50 bg-[#222831] px-4 py-3.5 text-sm leading-relaxed text-[#DFD0B8] transition-all duration-200 placeholder:text-[#948979]/60 focus:border-[#DFD0B8] focus:outline-none focus:ring-1 focus:ring-[#DFD0B8]/50 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <p className="mt-2 text-xs text-[#948979]">
          Stored as a hex-encoded string on-chain. Real E2E encryption is
          recommended for production.
        </p>
      </div>

      <div className="mb-8 rounded-xl border border-[#DFD0B8]/10 bg-[#222831] px-5 py-4 text-sm">
        <p className="font-bold text-[#DFD0B8]">Privacy-preserving verification</p>
        <p className="mt-1 text-[#948979]">
          Your wallet age and humanity are checked inside the Flare TEE. The
          resulting proof is submitted to the mailbox — no self-reported boxes
          needed.
        </p>
      </div>

      <button
        type="submit"
        disabled={!isConnected || isSending || isWrongNetwork || !MAILBOX_ADDRESS}
        className="w-full rounded-2xl bg-gradient-to-b from-[#DFD0B8] to-[#c9b89a] px-6 py-4 text-base font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[#DFD0B8]/25 disabled:cursor-not-allowed disabled:bg-[#948979] disabled:text-[#222831] disabled:opacity-60 disabled:shadow-none disabled:from-[#948979] disabled:to-[#948979]"
      >
        {isSending ? progressLabel(status) : "Send Knock"}
      </button>

      {!MAILBOX_ADDRESS && (
        <p className="mt-3 text-sm text-rose-400">
          Mailbox contract address is not configured.
        </p>
      )}

      {status.stage !== "idle" && status.stage !== "done" && (
        <p className="mt-4 text-sm text-[#948979]">
          {progressDetail(status)}
        </p>
      )}

      {error && (
        <div className="mt-5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-5 py-4 text-sm text-rose-300">
          {error}
        </div>
      )}
    </form>
  );
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function progressLabel(status: SendStatus): string {
  switch (status.stage) {
    case "requesting":
      return `Requesting TEE verification (${status.current}/${status.total})…`;
    case "waiting-proof":
      return `Waiting for TEE signature (${status.current}/${status.total})…`;
    case "submitting":
      return `Submitting proof (${status.current}/${status.total})…`;
    default:
      return "Sending Knock…";
  }
}

function progressDetail(status: SendStatus): string {
  switch (status.stage) {
    case "requesting":
      return `Knock ${status.current}/${status.total} → ${shortenAddress(
        status.receiver
      )}: posting the private verification job to the Flare TEE network.`;
    case "waiting-proof":
      return `Knock ${status.current}/${status.total} → ${shortenAddress(
        status.receiver
      )}: polling proxy for signed proof (request hash ${status.requestHash}).`;
    case "submitting":
      return `Knock ${status.current}/${status.total} → ${shortenAddress(
        status.receiver
      )}: signed proof received — writing the chat request to the mailbox.`;
    default:
      return "";
  }
}
