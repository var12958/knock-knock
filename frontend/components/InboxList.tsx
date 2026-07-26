"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWeb3 } from "@/context/Web3Context";
import { getMailboxContractRead, getMailboxContractWrite } from "@/lib/contracts";
import { decodePreview } from "@/lib/encodePreview";
import ProofBadge from "./ProofBadge";

interface ChatRequest {
  requestId: string;
  sender: string;
  receiver: string;
  encryptedPreviewMessage: string;
  isVerifiedHuman: boolean;
  isOldEnoughWallet: boolean;
  accepted: boolean;
  isRevealed: boolean;
  expirationTime: number;
}

const PAGE_SIZE = 20;

export default function InboxList() {
  const router = useRouter();
  const { signer, address } = useWeb3();
  const [requests, setRequests] = useState<ChatRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const loadRequests = useCallback(
    async (reset = false) => {
      if (!address || !signer) return;

      const currentOffset = reset ? 0 : offset;
      if (reset) {
        setOffset(0);
        setHasMore(true);
      }

      setLoading(true);
      setError(null);

      try {
        // getPendingRequestIds enforces msg.sender == _receiver, so we must
        // use a signer-connected contract even though it is a view call.
        const readContract = getMailboxContractRead();
        const signerContract = getMailboxContractWrite(signer);
        const ids: bigint[] = await signerContract.getPendingRequestIds(
          address,
          currentOffset,
          PAGE_SIZE
        );

        const pending: ChatRequest[] = [];
        for (const id of ids) {
          const req = await readContract.requests(id);
          pending.push({
            requestId: id.toString(),
            sender: req.sender,
            receiver: req.receiver,
            encryptedPreviewMessage: req.encryptedPreviewMessage,
            isVerifiedHuman: req.isVerifiedHuman,
            isOldEnoughWallet: req.isOldEnoughWallet,
            accepted: req.accepted,
            isRevealed: req.isRevealed,
            expirationTime: Number(req.expirationTime),
          });
        }

        setRequests((prev) => (reset ? pending : [...prev, ...pending]));
        setHasMore(ids.length === PAGE_SIZE);
        if (!reset) {
          setOffset((prev) => prev + ids.length);
        }
      } catch (err: any) {
        console.error("Failed to load inbox:", err);
        setError(err.reason ?? err.message ?? "Could not load pending requests");
      } finally {
        setLoading(false);
      }
    },
    [address, signer, offset]
  );

  useEffect(() => {
    if (address && signer) {
      loadRequests(true);
    } else {
      setRequests([]);
      setOffset(0);
      setHasMore(true);
    }
  }, [address, signer, loadRequests]);

  const handleAccept = useCallback(
    async (requestId: string) => {
      if (!signer) return;
      setActionId(requestId);
      setError(null);

      try {
        const contract = getMailboxContractWrite(signer);
        const tx = await contract.acceptRequest(BigInt(requestId));
        await tx.wait();
        router.push(`/chat/${requestId}`);
        void loadRequests(true);
      } catch (err: any) {
        console.error("Accept failed:", err);
        setError(err.reason ?? err.message ?? "Accept transaction failed");
      } finally {
        setActionId(null);
      }
    },
    [signer, loadRequests, router]
  );

  const handleReject = useCallback(
    async (requestId: string) => {
      if (!signer) return;
      setActionId(requestId);
      setError(null);

      try {
        const contract = getMailboxContractWrite(signer);
        const tx = await contract.rejectRequest(BigInt(requestId));
        await tx.wait();
        await loadRequests(true);
      } catch (err: any) {
        console.error("Reject failed:", err);
        setError(err.reason ?? err.message ?? "Reject transaction failed");
      } finally {
        setActionId(null);
      }
    },
    [signer, loadRequests]
  );

  if (!address) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center shadow-sm">
        <p className="text-slate-600">Connect your MetaMask wallet to view your inbox.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800">Your Inbox 📬</h2>
        <button
          onClick={() => loadRequests(true)}
          disabled={loading}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {requests.length === 0 && !loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center shadow-sm">
          <p className="text-slate-600">No pending chat requests. Your door is quiet. 🚪</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {requests.map((req) => (
            <div
              key={req.requestId}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:shadow-md"
            >
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                    #{req.requestId}
                  </span>
                  <ProofBadge
                    label="Verified Human"
                    active={req.isVerifiedHuman}
                  />
                  <ProofBadge
                    label="Wallet &gt; 1 year"
                    active={req.isOldEnoughWallet}
                  />
                </div>
                <span className="text-xs text-slate-400">
                  Expires {new Date(req.expirationTime * 1000).toLocaleString()}
                </span>
              </div>

              <div className="mb-4 rounded-xl bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-500">Preview</p>
                <p className="mt-1 break-words text-slate-800">
                  {decodePreview(req.encryptedPreviewMessage)}
                </p>
              </div>

              <p className="mb-4 text-xs text-slate-400">
                Sender address is hidden to protect privacy.
              </p>

              <div className="flex gap-3">
                <button
                  onClick={() => handleAccept(req.requestId)}
                  disabled={actionId === req.requestId}
                  className="flex-1 rounded-lg bg-green-600 px-4 py-2.5 font-medium text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {actionId === req.requestId ? "Working..." : "Accept"}
                </button>
                <button
                  onClick={() => handleReject(req.requestId)}
                  disabled={actionId === req.requestId}
                  className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {actionId === req.requestId ? "Working..." : "Reject"}
                </button>
              </div>
            </div>
          ))}

          {hasMore && (
            <button
              onClick={() => loadRequests(false)}
              disabled={loading}
              className="mt-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              {loading ? "Loading..." : "Load more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
