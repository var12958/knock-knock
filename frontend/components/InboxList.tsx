"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWeb3 } from "@/context/Web3Context";
import { getMailboxContractWrite, getMailboxContractRead } from "@/lib/contracts";
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

interface InboxListProps {
  /** Increment to force a fresh fetch of pending requests. */
  refreshKey?: number;
}

const PAGE_SIZE = 20;
/** Max request IDs scanned per "Load more" pass when building history. */
const HISTORY_SCAN_WINDOW = 64;

export default function InboxList({ refreshKey }: InboxListProps) {
  const router = useRouter();
  const { signer, address } = useWeb3();
  const [mode, setMode] = useState<"pending" | "history">("pending");

  // Pending inbox state
  const [requests, setRequests] = useState<ChatRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  // History state. We build history by scanning the public `requests(id)`
  // mapping from newest to oldest and keeping entries where the connected
  // wallet is the receiver. This works against the currently deployed
  // contract (which has `requests()` + `nextRequestId()` but not a dedicated
  // history getter), so no redeploy is required.
  const [historyRequests, setHistoryRequests] = useState<ChatRequest[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(true);
  // Cursor = next request ID to inspect (descending). null = start from the
  // latest. Kept in a ref so loadHistory stays referentially stable.
  const historyCursorRef = useRef<number | null>(null);

  const loadRequests = useCallback(
    async (reset = false, currentOffset = offset) => {
      if (!address || !signer) return;

      const offsetToUse = reset ? 0 : currentOffset;
      if (reset) {
        setRequests([]);
        setOffset(0);
        setHasMore(true);
      }

      setLoading(true);
      setError(null);

      try {
        // Both getters enforce msg.sender == _receiver, so we must use a
        // signer-connected contract even though these are view calls.
        const signerContract = getMailboxContractWrite(signer);

        const signerAddress = await signer.getAddress();
        console.log(
          "[InboxList] querying pending inbox - address param:",
          address,
          "signer address (msg.sender):",
          signerAddress
        );

        // Fetch IDs and full structs in two calls instead of N+1 mapping reads.
        const [ids, rawRequests]: [bigint[], any[]] = await Promise.all([
          signerContract.getPendingRequestIds(address, offsetToUse, PAGE_SIZE),
          signerContract.getPendingRequests(address, offsetToUse, PAGE_SIZE),
        ]);

        console.log(
          "[InboxList] raw pending request ids:",
          ids.map((id) => id.toString())
        );
        console.log("[InboxList] raw pending request structs:", rawRequests);

        const pending: ChatRequest[] = ids.map((id, i) => {
          const req = rawRequests[i];
          return {
            requestId: id.toString(),
            sender: req.sender,
            receiver: req.receiver,
            encryptedPreviewMessage: req.encryptedPreviewMessage,
            isVerifiedHuman: req.isVerifiedHuman,
            isOldEnoughWallet: req.isOldEnoughWallet,
            accepted: req.accepted,
            isRevealed: req.isRevealed,
            expirationTime: Number(req.expirationTime),
          };
        });

        setRequests((prev) => (reset ? pending : [...prev, ...pending]));
        setHasMore(ids.length === PAGE_SIZE);
        if (!reset) {
          setOffset((prev) => prev + ids.length);
        }
      } catch (err: any) {
        console.error("[InboxList] Failed to load inbox:", err);
        setError(err.reason ?? err.message ?? "Could not load pending requests");
      } finally {
        setLoading(false);
      }
    },
    [address, signer]
  );

  /**
   * Read the total number of requests ever created. Prefers `nextRequestId`
   * (the monotonic counter) and falls back to `getTotalRequestCount`. Both are
   * view functions present on the deployed contract.
   */
  async function getTotalRequestCount(contract: any): Promise<number> {
    try {
      if (typeof contract.nextRequestId === "function") {
        return Number(await contract.nextRequestId());
      }
    } catch (err: any) {
      console.warn("[InboxList] nextRequestId unavailable, falling back:", err?.reason ?? err?.message);
    }
    try {
      if (typeof contract.getTotalRequestCount === "function") {
        return Number(await contract.getTotalRequestCount());
      }
    } catch (err: any) {
      console.warn("[InboxList] getTotalRequestCount unavailable:", err?.reason ?? err?.message);
    }
    throw new Error("Could not determine the total request count from the mailbox contract.");
  }

  const loadHistory = useCallback(
    async (reset = false) => {
      if (!address) return;

      if (reset) {
        setHistoryRequests([]);
        historyCursorRef.current = null;
        setHistoryHasMore(true);
      }

      setHistoryLoading(true);
      setError(null);

      try {
        // `requests(id)` is a plain public mapping getter with no msg.sender
        // check, so a read-only contract is enough (and avoids wallet prompts).
        const contract = getMailboxContractRead();

        let cursor: number =
          historyCursorRef.current ?? (await getTotalRequestCount(contract));

        const collected: ChatRequest[] = [];
        let scanned = 0;
        const target = address.toLowerCase();

        while (
          collected.length < PAGE_SIZE &&
          cursor > 0 &&
          scanned < HISTORY_SCAN_WINDOW
        ) {
          // Scan a window of IDs in parallel (newest first) for speed.
          const windowSize = Math.min(HISTORY_SCAN_WINDOW - scanned, cursor);
          const ids = Array.from({ length: windowSize }, (_, i) => cursor - 1 - i);
          const structs = await Promise.all(
            ids.map((id) => contract.requests(BigInt(id)))
          );
          scanned += windowSize;
          cursor -= windowSize;

          for (let i = 0; i < ids.length; i++) {
            const req = structs[i];
            if (!req || req.receiver?.toLowerCase() !== target) continue;
            collected.push({
              requestId: ids[i].toString(),
              sender: req.sender,
              receiver: req.receiver,
              encryptedPreviewMessage: req.encryptedPreviewMessage,
              isVerifiedHuman: req.isVerifiedHuman,
              isOldEnoughWallet: req.isOldEnoughWallet,
              accepted: req.accepted,
              isRevealed: req.isRevealed,
              expirationTime: Number(req.expirationTime),
            });
            if (collected.length >= PAGE_SIZE) break;
          }
        }

        // Newest-first: prepend nothing, just append in the order scanned.
        setHistoryRequests((prev) => (reset ? collected : [...prev, ...collected]));
        historyCursorRef.current = cursor;
        setHistoryHasMore(cursor > 0 && collected.length >= PAGE_SIZE);
      } catch (err: any) {
        console.error("[InboxList] Failed to load history:", err);
        setError(err.reason ?? err.message ?? "Could not load request history");
        setHistoryHasMore(false);
      } finally {
        setHistoryLoading(false);
      }
    },
    [address]
  );

  useEffect(() => {
    if (!address || !signer) {
      setRequests([]);
      setHistoryRequests([]);
      setOffset(0);
      historyCursorRef.current = null;
      setHasMore(true);
      setHistoryHasMore(true);
      return;
    }

    if (mode === "pending") {
      loadRequests(true);
    } else {
      loadHistory(true);
    }
  }, [address, signer, refreshKey, mode, loadRequests, loadHistory]);

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
      <div className="relative overflow-hidden rounded-3xl border border-[#DFD0B8]/10 bg-[#222831] p-14 text-center shadow-xl shadow-black/20">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#DFD0B8]/25 to-transparent"
        />
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-[#393E46] text-4xl shadow-inner ring-1 ring-[#DFD0B8]/10">
          🦊
        </div>
        <h3 className="mb-2 text-xl font-bold tracking-tight text-[#DFD0B8]">
          Your inbox is locked
        </h3>
        <p className="mx-auto max-w-sm text-sm leading-relaxed text-[#948979]">
          Connect your MetaMask wallet to view pending chat requests and accept
          private knocks on Flare.
        </p>
      </div>
    );
  }

  const isHistory = mode === "history";
  const displayRequests = isHistory ? historyRequests : requests;
  const isLoading = isHistory ? historyLoading : loading;
  const hasMoreItems = isHistory ? historyHasMore : hasMore;
  const loadMore = isHistory ? () => loadHistory(false) : () => loadRequests(false, offset);
  const refresh = isHistory ? () => loadHistory(true) : () => loadRequests(true);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <h2 className="text-3xl font-bold tracking-tight text-[#DFD0B8]">
            {isHistory ? "History" : "Your Inbox"}
          </h2>
          <div className="flex rounded-xl border border-[#DFD0B8]/10 bg-[#222831] p-1">
            <button
              onClick={() => setMode("pending")}
              className={`rounded-lg px-3 py-1 text-sm font-semibold transition ${
                mode === "pending"
                  ? "bg-[#DFD0B8] text-[#222831]"
                  : "text-[#948979] hover:text-[#DFD0B8]"
              }`}
            >
              Pending
            </button>
            <button
              onClick={() => setMode("history")}
              className={`rounded-lg px-3 py-1 text-sm font-semibold transition ${
                mode === "history"
                  ? "bg-[#DFD0B8] text-[#222831]"
                  : "text-[#948979] hover:text-[#DFD0B8]"
              }`}
            >
              History
            </button>
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="rounded-2xl border border-[#DFD0B8]/10 bg-[#222831] px-5 py-2.5 text-sm font-semibold text-[#DFD0B8] transition-all duration-300 hover:border-[#DFD0B8]/30 hover:bg-[#222831]/80 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="mb-5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-5 py-4 text-sm text-rose-300">
          {error}
        </div>
      )}

      {displayRequests.length === 0 && !isLoading ? (
        <div className="relative overflow-hidden rounded-3xl border border-[#DFD0B8]/10 bg-[#222831] p-14 text-center shadow-xl shadow-black/20">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#DFD0B8]/25 to-transparent"
          />
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-[#393E46] text-4xl shadow-inner ring-1 ring-[#DFD0B8]/10">
            {isHistory ? "📜" : "🚪"}
          </div>
          <h3 className="mb-2 text-xl font-bold tracking-tight text-[#DFD0B8]">
            {isHistory ? "No history yet" : "Your door is quiet"}
          </h3>
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-[#948979]">
            {isHistory
              ? "Accepted knocks will appear here once you start chatting."
              : "No pending chat requests right now. Send a knock to start a private conversation."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {displayRequests.map((req) => {
            const isExpired = Date.now() / 1000 > req.expirationTime;
            const status = req.accepted
              ? "Accepted"
              : isExpired
              ? "Expired"
              : "Pending";

            return (
              <div
                key={`${mode}-${req.requestId}-${req.sender}-${req.expirationTime}`}
                className="rounded-2xl border border-[#DFD0B8]/10 bg-[#393E46] p-6 shadow-xl shadow-black/20 transition-all duration-300 hover:-translate-y-1 hover:border-[#DFD0B8]/20 hover:shadow-2xl hover:shadow-black/30"
              >
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {req.requestId !== "-" && (
                      <span className="rounded-lg border border-[#DFD0B8]/10 bg-[#222831] px-2.5 py-1 text-xs font-bold text-[#DFD0B8]">
                        #{req.requestId}
                      </span>
                    )}
                    <span
                      className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${
                        req.accepted
                          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                          : isExpired
                          ? "border-amber-500/20 bg-amber-500/10 text-amber-300"
                          : "border-[#DFD0B8]/20 bg-[#222831] text-[#DFD0B8]"
                      }`}
                    >
                      {status}
                    </span>
                    <ProofBadge
                      label="Verified Human"
                      active={req.isVerifiedHuman}
                    />
                    <ProofBadge
                      label="Old Wallet"
                      active={req.isOldEnoughWallet}
                    />
                  </div>
                  <span className="text-xs text-[#948979]">
                    {req.accepted
                      ? `Accepted ${new Date(
                          req.expirationTime * 1000
                        ).toLocaleString()}`
                      : `Expires ${new Date(
                          req.expirationTime * 1000
                        ).toLocaleString()}`}
                  </span>
                </div>

                <div className="mb-5 flex items-start gap-4 rounded-xl border border-[#948979]/20 bg-[#222831] p-5">
                  <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full border border-[#DFD0B8]/10 bg-[#393E46] text-xl">
                    ❓
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-[#948979]">Preview</p>
                    <p className="mt-1 break-words text-base text-[#DFD0B8]">
                      {decodePreview(req.encryptedPreviewMessage)}
                    </p>
                    {req.isRevealed ? (
                      <p className="mt-2 text-xs text-[#948979]">
                        Sender: {req.sender}
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-[#948979]">
                        Sender address is hidden to protect privacy.
                      </p>
                    )}
                  </div>
                </div>

                {isHistory ? (
                  <div className="flex gap-3">
                    {req.accepted && !isExpired && (
                      <button
                        onClick={() => router.push(`/chat/${req.requestId}`)}
                        className="flex-1 rounded-2xl bg-[#DFD0B8] px-5 py-3 text-sm font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#DFD0B8]/90 hover:shadow-[#DFD0B8]/25"
                      >
                        Open Chat
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleAccept(req.requestId)}
                      disabled={actionId === req.requestId}
                      className="flex-1 rounded-2xl bg-[#DFD0B8] px-5 py-3 text-sm font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#DFD0B8]/90 hover:shadow-[#DFD0B8]/25 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {actionId === req.requestId ? "Working..." : "Accept"}
                    </button>
                    <button
                      onClick={() => handleReject(req.requestId)}
                      disabled={actionId === req.requestId}
                      className="flex-1 rounded-2xl bg-[#948979] px-5 py-3 text-sm font-bold text-[#222831] shadow-lg shadow-black/20 transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#948979]/80 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {actionId === req.requestId ? "Working..." : "Reject"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {hasMoreItems && (
            <button
              onClick={loadMore}
              disabled={isLoading}
              className="mt-2 rounded-2xl border border-[#DFD0B8]/10 bg-[#222831] px-5 py-3 text-sm font-semibold text-[#DFD0B8] transition-all duration-300 hover:border-[#DFD0B8]/30 hover:bg-[#222831]/80 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? "Loading..." : "Load more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}