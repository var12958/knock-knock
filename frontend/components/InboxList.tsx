"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useWeb3 } from "@/context/Web3Context";
import { useFirebaseAuth } from "@/context/FirebaseAuthContext";
import { getMailboxContractWrite } from "@/lib/contracts";
import { decodePreview } from "@/lib/encodePreview";
import { setNickname, subscribeNicknames } from "@/lib/firebaseContacts";
import { subscribeDeletedChats } from "@/lib/firebaseDeletedChats";
import ProofBadge from "./ProofBadge";
import {
  formatMLBadge,
  type MLBehaviorScore,
  runMLBehaviorCheck,
} from "@/lib/runMLBehaviorCheck";

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
  /** Which tab to open first. */
  initialMode?: Mode;
}

type Mode = "pending" | "chats" | "history";

const PAGE_SIZE = 20;

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Map a raw on-chain request struct + id into the component's ChatRequest. */
function mapRequest(id: bigint, req: any): ChatRequest {
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
}

export default function InboxList({ refreshKey, initialMode }: InboxListProps) {
  const router = useRouter();
  const { signer, address } = useWeb3();
  const { user } = useFirebaseAuth();
  const [mode, setMode] = useState<Mode>(initialMode ?? "pending");

  // Pending inbox state
  const [requests, setRequests] = useState<ChatRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  // Receiver requests state — single source for the Chats and History tabs.
  // `getRequestsByReceiver` returns every existing request for the connected
  // wallet (accepted + expired; rejected ones are already cleaned up). We split
  // it client-side: accepted → Chats, unaccepted+expired → History.
  const [receiverRequests, setReceiverRequests] = useState<ChatRequest[]>([]);
  const [receiverLoading, setReceiverLoading] = useState(false);
  const [receiverOffset, setReceiverOffset] = useState(0);
  const [receiverHasMore, setReceiverHasMore] = useState(true);

  // Per-user contact nicknames keyed by lowercase sender address.
  const [nicknames, setNicknames] = useState<Record<string, string>>({});

  // Per-user hidden-chat id set (mirrors the Sidebar's deletedChats list).
  const [deletedChats, setDeletedChats] = useState<Set<string>>(new Set());
  const deletedChatsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    deletedChatsRef.current = deletedChats;
  }, [deletedChats]);

  // TEE ML behavior check results keyed by request id.
  const [mlScores, setMlScores] = useState<Record<string, MLBehaviorScore | null>>({});
  const [mlLoadingIds, setMlLoadingIds] = useState<Set<string>>(new Set());
  const [mlErrors, setMlErrors] = useState<Record<string, string>>({});

  // Edit-nickname modal state.
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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
        // Both pending getters enforce msg.sender == _receiver, so we must use a
        // signer-connected contract even though these are view calls.
        const signerContract = getMailboxContractWrite(signer);

        console.log("[InboxList] loadRequests: query address=", address, "signer.address=", signer.address, "contract target=", signer.address?.toLowerCase() === address?.toLowerCase());
        console.log("[InboxList] calling getPendingRequests for address:", address, "offset:", offsetToUse, "pageSize:", PAGE_SIZE);
        const [ids, rawRequests]: [bigint[], any[]] = await Promise.all([
          signerContract.getPendingRequestIds(address, offsetToUse, PAGE_SIZE),
          signerContract.getPendingRequests(address, offsetToUse, PAGE_SIZE),
        ]);
        console.log("[InboxList] getPendingRequests raw result:", {
          address,
          offset: offsetToUse,
          ids: ids.map((id) => id.toString()),
          rawRequests,
        });
        console.log("[InboxList] raw result length: ids=", ids.length, "rawRequests=", rawRequests.length);

        const pending: ChatRequest[] = ids
          .map((id, i) => mapRequest(id, rawRequests[i]))
          .filter((r) => r.sender.toLowerCase() !== address.toLowerCase());
        console.log("[InboxList] mapped pending count (after self-filter):", pending.length, "first item:", pending[0] ?? "none");

        setRequests((prev) => {
          const existing = new Set(prev.map((r) => r.requestId));
          const fresh = reset
            ? pending
            : pending.filter((r) => !existing.has(r.requestId));
          return [...(reset ? [] : prev), ...fresh];
        });
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
    [address, signer],
  );

  // Fetch one page of all requests targeting the connected wallet. Populates
  // both the Chats and History tabs (filtered client-side via useMemo below).
  const loadReceiverRequests = useCallback(
    async (reset = false, currentOffset = receiverOffset) => {
      if (!address || !signer) return;

      const offsetToUse = reset ? 0 : currentOffset;
      if (reset) {
        setReceiverRequests([]);
        setReceiverOffset(0);
        setReceiverHasMore(true);
      }

      setReceiverLoading(true);
      setError(null);

      try {
        // `getRequestsByReceiver` enforces msg.sender == _receiver, so a
        // signer-connected contract is required (view calls do not prompt).
        const contract = getMailboxContractWrite(signer);

        console.log("[InboxList] loadReceiverRequests: query address=", address, "signer.address=", signer.address, "contract target=", signer.address?.toLowerCase() === address?.toLowerCase());
        console.log("[InboxList] calling getRequestsByReceiver for address:", address, "offset:", offsetToUse, "pageSize:", PAGE_SIZE);
        const [ids, rawRequests]: [bigint[], any[]] =
          await contract.getRequestsByReceiver(address, offsetToUse, PAGE_SIZE);
        console.log("[InboxList] getRequestsByReceiver raw result:", {
          address,
          offset: offsetToUse,
          ids: ids.map((id) => id.toString()),
          rawRequests,
        });
        console.log("[InboxList] raw result length: ids=", ids.length, "rawRequests=", rawRequests.length);

        const mapped: ChatRequest[] = ids
          .map((id, i) => mapRequest(id, rawRequests[i]))
          .filter(
            (r) =>
              r.sender.toLowerCase() !== address.toLowerCase() &&
              !deletedChatsRef.current.has(r.requestId),
          );
        console.log("[InboxList] mapped receiver count (after self-filter):", mapped.length, "accepted:", mapped.filter((r) => r.accepted).length, "first item:", mapped[0] ?? "none");

        setReceiverRequests((prev) => {
          const existing = new Set(prev.map((r) => r.requestId));
          const fresh = reset
            ? mapped
            : mapped.filter((r) => !existing.has(r.requestId));
          return [...(reset ? [] : prev), ...fresh];
        });
        setReceiverHasMore(ids.length === PAGE_SIZE);
        if (!reset) {
          setReceiverOffset((prev) => prev + ids.length);
        }
      } catch (err: any) {
        console.error("[InboxList] Failed to load chats/history:", err);
        setError(err.reason ?? err.message ?? "Could not load chats");
      } finally {
        setReceiverLoading(false);
      }
    },
    [address, signer],
  );

  // Load both lists on mount, on account change, and when a new request is sent.
  useEffect(() => {
    const signerAddress = signer?.address ?? null;
    console.log("[InboxList] effect triggered: address=", address, "signer.address=", signerAddress, "signer present=", signer ? "yes" : "no", "match=", address?.toLowerCase() === signerAddress?.toLowerCase());
    if (!address || !signer) {
      console.log("[InboxList] no address/signer; clearing lists");
      setRequests([]);
      setReceiverRequests([]);
      setOffset(0);
      setReceiverOffset(0);
      setHasMore(true);
      setReceiverHasMore(true);
      return;
    }

    // The signer and address must update atomically in Web3Context, but React
    // still re-runs this effect whenever either changes. Reset both lists and
    // pagination immediately so the user never sees another account's inbox while
    // the new account's data is loading.
    setRequests([]);
    setReceiverRequests([]);
    setOffset(0);
    setReceiverOffset(0);
    setHasMore(true);
    setReceiverHasMore(true);
    setError(null);

    void loadRequests(true);
    void loadReceiverRequests(true);
  }, [address, signer, refreshKey, loadRequests, loadReceiverRequests]);

  // Accepted chats: one entry per unique sender, keeping the newest requestId.
  // Exclude any request id the user has hidden from the Chats tab so the
  // Sidebar and InboxList stay consistent.
  const chats = useMemo(() => {
    const bySender = new Map<string, ChatRequest>();
    receiverRequests
      .filter((r) => r.accepted && !deletedChats.has(r.requestId))
      .forEach((req) => {
        const sender = req.sender.toLowerCase();
        const existing = bySender.get(sender);
        if (!existing || BigInt(req.requestId) > BigInt(existing.requestId)) {
          bySender.set(sender, req);
        }
      });
    return Array.from(bySender.values()).sort(
      (a, b) => b.expirationTime - a.expirationTime,
    );
  }, [receiverRequests, deletedChats]);

  // History contains only unaccepted, expired requests. Rejected requests are
  // cleaned up on-chain and will not be returned. Hidden chats are excluded
  // both when loading and here so real-time deletes are reflected immediately.
  const history = useMemo(
    () =>
      receiverRequests.filter(
        (r) =>
          !r.accepted &&
          Date.now() / 1000 > r.expirationTime &&
          !deletedChats.has(r.requestId),
      ),
    [receiverRequests, deletedChats],
  );

  // Subscribe to the user's entire private nickname address book in real time.
  // The write path is contacts/${uid}/${senderAddress} (see contactsRef); this
  // subscribes to the parent contacts/${uid} node and delivers a lowercase-keyed
  // map on first load and on every change, decoupled from chats loading.
  useEffect(() => {
    if (!user) return;
    let active = true;
    try {
      const unsubscribe = subscribeNicknames(user.uid, (fetched) => {
        if (!active) return;
        setNicknames(fetched);
      });
      return () => {
        active = false;
        unsubscribe();
      };
    } catch (err: any) {
      console.error("[InboxList] nickname subscription failed:", err);
    }
  }, [user]);

  // Subscribe to the user's hidden-chat id set in real time. This keeps the
  // Chats and History tabs in sync with the Sidebar's delete action.
  useEffect(() => {
    if (!user) return;
    let active = true;
    try {
      const unsubscribe = subscribeDeletedChats(user.uid, (fetched) => {
        if (!active) return;
        setDeletedChats(fetched);
      });
      return () => {
        active = false;
        unsubscribe();
      };
    } catch (err: any) {
      console.error("[InboxList] deletedChats subscription failed:", err);
    }
  }, [user]);

  const handleAccept = useCallback(
    async (requestId: string) => {
      if (!signer) return;
      setActionId(requestId);
      setError(null);

      try {
        const contract = getMailboxContractWrite(signer);
        const tx = await contract.acceptRequest(BigInt(requestId));
        await tx.wait();

        // Refresh both lists: the request leaves Pending and appears in Chats.
        await Promise.all([loadRequests(true), loadReceiverRequests(true)]);
        // Surface the new conversation in the Chats tab.
        setMode("chats");
      } catch (err: any) {
        console.error("Accept failed:", err);
        setError(err.reason ?? err.message ?? "Accept transaction failed");
      } finally {
        setActionId(null);
      }
    },
    [signer, loadRequests, loadReceiverRequests],
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
        await Promise.all([loadRequests(true), loadReceiverRequests(true)]);
      } catch (err: any) {
        console.error("Reject failed:", err);
        setError(err.reason ?? err.message ?? "Reject transaction failed");
      } finally {
        setActionId(null);
      }
    },
    [signer, loadRequests, loadReceiverRequests],
  );

  const handleCheckML = useCallback(
    async (request: ChatRequest) => {
      const proxyUrl = process.env.NEXT_PUBLIC_FCC_PROXY_URL?.trim();
      if (!proxyUrl) {
        setMlErrors((prev) => ({
          ...prev,
          [request.requestId]: "FCC proxy URL is not configured.",
        }));
        return;
      }

      setMlLoadingIds((prev) => new Set(prev).add(request.requestId));
      setMlErrors((prev) => {
        const next = { ...prev };
        delete next[request.requestId];
        return next;
      });

      try {
        const score = await runMLBehaviorCheck(proxyUrl, request.sender);
        setMlScores((prev) => ({ ...prev, [request.requestId]: score }));
      } catch (err: any) {
        console.error("[InboxList] ML check failed:", err);
        setMlErrors((prev) => ({
          ...prev,
          [request.requestId]:
            err.message ?? "Behavior check failed",
        }));
      } finally {
        setMlLoadingIds((prev) => {
          const next = new Set(prev);
          next.delete(request.requestId);
          return next;
        });
      }
    },
    [],
  );

  function openEditNickname(sender: string) {
    setEditing(sender);
    setEditValue(nicknames[sender.toLowerCase()] ?? "");
    setEditError(null);
  }

  async function handleSaveNickname() {
    if (!user || !editing) return;
    const trimmed = editValue.trim();
    setEditSaving(true);
    setEditError(null);

    try {
      await setNickname(user.uid, editing, trimmed);
      setNicknames((prev) => {
        const next = { ...prev };
        const key = editing.toLowerCase();
        if (trimmed) {
          next[key] = trimmed;
        } else {
          delete next[key];
        }
        return next;
      });
      setEditing(null);
    } catch (err: any) {
      console.error("[InboxList] save nickname failed:", err);
      setEditError(err.message ?? "Could not save nickname");
    } finally {
      setEditSaving(false);
    }
  }

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

  const isLoading = mode === "pending" ? loading : receiverLoading;
  const hasMoreItems = mode === "pending" ? hasMore : receiverHasMore;
  const loadMore =
    mode === "pending"
      ? () => loadRequests(false, offset)
      : () => loadReceiverRequests(false, receiverOffset);
  const refresh = () => {
    void loadRequests(true);
    void loadReceiverRequests(true);
  };

  const displayRequests =
    mode === "pending" ? requests : mode === "chats" ? chats : history;

  console.log("[InboxList] render summary: mode=", mode, "pending count=", requests.length, "chats count=", chats.length, "history count=", history.length, "receiverRequests total=", receiverRequests.length, "display count=", displayRequests.length, "loading=", isLoading);

  const emptyCopy: Record<Mode, { icon: string; title: string; body: string; cta?: string }> = {
    pending: {
      icon: "🚪",
      title: "Your door is quiet",
      body: "No pending knocks at the moment. Send one to start a private, encrypted conversation.",
      cta: "Send a knock",
    },
    chats: {
      icon: "💬",
      title: "No conversations yet",
      body: "Accept a knock to unlock a chat. Your active conversations will live here.",
      cta: "Send a knock",
    },
    history: {
      icon: "📜",
      title: "No history yet",
      body: "Expired requests will appear here once they roll in.",
    },
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-3xl font-bold tracking-tight text-[#DFD0B8]">
          Your Inbox
        </h2>
        <div className="flex items-center gap-3">
          <div className="flex rounded-xl border border-[#DFD0B8]/10 bg-[#222831] p-1">
            {(["pending", "chats", "history"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-lg px-3 py-1 text-sm font-semibold capitalize transition ${
                  mode === m
                    ? "bg-[#DFD0B8] text-[#222831]"
                    : "text-[#948979] hover:text-[#DFD0B8]"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            onClick={refresh}
            disabled={isLoading}
            className="rounded-2xl border border-[#DFD0B8]/10 bg-[#222831] px-5 py-2.5 text-sm font-semibold text-[#DFD0B8] transition-all duration-300 hover:border-[#DFD0B8]/30 hover:bg-[#222831]/80 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-5 py-4 text-sm text-rose-300">
          {error}
        </div>
      )}

      {displayRequests.length === 0 && !isLoading ? (
        <PremiumEmptyState
          icon={emptyCopy[mode].icon}
          title={emptyCopy[mode].title}
          body={emptyCopy[mode].body}
          cta={emptyCopy[mode].cta}
          onCta={() => router.push("/send")}
        />
      ) : mode === "chats" ? (
        <div className="flex flex-col gap-3">
          {chats.map((req) => {
            const nickname = nicknames[req.sender.toLowerCase()];
            const initial = nickname
              ? nickname[0].toUpperCase()
              : "💬";
            return (
              <div
                key={`chat-${req.requestId}-${req.sender}`}
                role="button"
                tabIndex={0}
                onClick={() => router.push(`/chat/${req.requestId}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    router.push(`/chat/${req.requestId}`);
                  }
                }}
                className="group flex cursor-pointer items-center gap-4 rounded-2xl border border-[#DFD0B8]/10 bg-[#393E46] p-4 text-left shadow-xl shadow-black/20 transition-all duration-300 hover:-translate-y-0.5 hover:border-[#DFD0B8]/25 hover:bg-[#31363F] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#DFD0B8]/50"
              >
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border border-[#DFD0B8]/10 bg-[#222831] text-lg font-bold text-[#DFD0B8]">
                  {initial}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1 truncate text-sm font-bold text-[#DFD0B8]">
                    {nickname ?? shortenAddress(req.sender)}
                  </p>
                  <p className="truncate text-xs text-[#948979]">
                    {nickname
                      ? shortenAddress(req.sender)
                      : `Chat #${req.requestId}`}
                  </p>
                </div>
                <span className="hidden text-[10px] font-medium text-[#948979] sm:inline">
                  Accepted
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openEditNickname(req.sender);
                  }}
                  aria-label="Edit nickname"
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-[#DFD0B8]/15 bg-[#222831] text-[#948979] transition-colors duration-200 hover:border-[#DFD0B8]/40 hover:text-[#DFD0B8]"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4"
                    aria-hidden
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
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
                          req.expirationTime * 1000,
                        ).toLocaleString()}`
                      : `Expires ${new Date(
                          req.expirationTime * 1000,
                        ).toLocaleString()}`}
                  </span>
                </div>

                <div className="mb-5 flex items-start gap-4 rounded-xl border border-[#948979]/20 bg-[#222831] p-5">
                  <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full border border-[#DFD0B8]/10 bg-[#393E46] text-xl">
                    ❓
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-[#948979]">
                      Preview
                    </p>
                    <p className="mt-1 break-words text-base text-[#DFD0B8]">
                      {decodePreview(req.encryptedPreviewMessage) ||
                        "No preview included with this knock"}
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

                {mode === "pending" ? (
                  <div className="flex flex-col gap-3">
                    {mlScores[req.requestId] && (
                      <div className="group relative flex items-center gap-2 rounded-xl border border-[#DFD0B8]/20 bg-[#222831] px-4 py-2">
                        <span className="text-sm">🛡️</span>
                        <span className="text-sm font-bold text-[#DFD0B8]">
                          {formatMLBadge(mlScores[req.requestId])}
                        </span>
                        <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-64 -translate-x-1/2 rounded-xl border border-[#DFD0B8]/10 bg-[#222831] p-3 text-xs text-[#DFD0B8] opacity-0 shadow-xl shadow-black/30 transition-opacity group-hover:opacity-100">
                          <p className="mb-2 font-bold text-[#DFD0B8]">
                            Model: {mlScores[req.requestId]!.modelVersion}
                          </p>
                          <ul className="list-disc space-y-1 pl-4 text-[#948979]">
                            {mlScores[req.requestId]!.explanation.map((factor, i) => (
                              <li key={i}>{factor}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}
                    {mlErrors[req.requestId] && !mlScores[req.requestId] && (
                      <p className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">
                        {mlErrors[req.requestId]}
                      </p>
                    )}
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
                      <button
                        type="button"
                        onClick={() => handleCheckML(req)}
                        disabled={
                          actionId === req.requestId ||
                          mlLoadingIds.has(req.requestId)
                        }
                        className="rounded-2xl border border-[#DFD0B8]/20 bg-[#222831] px-5 py-3 text-sm font-bold text-[#DFD0B8] shadow-lg shadow-black/20 transition-all duration-300 hover:-translate-y-0.5 hover:border-[#DFD0B8]/40 hover:bg-[#31363F] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {mlLoadingIds.has(req.requestId) ? (
                          <span className="flex items-center justify-center gap-2">
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#DFD0B8]/30 border-t-[#DFD0B8]" />
                            Checking...
                          </span>
                        ) : (
                          "CHECK"
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  // History: expired requests are read-only.
                  req.accepted && (
                    <div className="flex gap-3">
                      <button
                        onClick={() => router.push(`/chat/${req.requestId}`)}
                        className="flex-1 rounded-2xl bg-[#DFD0B8] px-5 py-3 text-sm font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#DFD0B8]/90 hover:shadow-[#DFD0B8]/25"
                      >
                        Open Chat
                      </button>
                    </div>
                  )
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

      {/* Edit nickname modal */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex animate-message-in items-center justify-center bg-black/50 px-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget && !editSaving) setEditing(null);
          }}
        >
          <div className="w-full max-w-sm rounded-3xl border border-[#DFD0B8]/15 bg-[#393E46] p-6 shadow-2xl shadow-black/40">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#222831] text-xl ring-1 ring-[#DFD0B8]/10">
                ✏️
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-[#DFD0B8]">
                  Edit nickname
                </h3>
                <p className="truncate text-xs text-[#948979]">
                  {shortenAddress(editing)}
                </p>
              </div>
            </div>

            <label
              htmlFor="nickname-input"
              className="mb-1.5 block text-xs font-medium text-[#948979]"
            >
              Nickname
            </label>
            <input
              id="nickname-input"
              type="text"
              autoFocus
              maxLength={40}
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value);
                setEditError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSaveNickname();
                else if (e.key === "Escape") setEditing(null);
              }}
              placeholder="e.g. Alice"
              className="w-full rounded-2xl border border-[#948979]/50 bg-[#222831] px-4 py-3 text-sm text-[#DFD0B8] transition-all duration-200 placeholder:text-[#948979]/60 focus:border-[#DFD0B8] focus:outline-none focus:ring-1 focus:ring-[#DFD0B8]/50"
            />
            {editError && (
              <p className="mt-2 text-xs text-rose-300">{editError}</p>
            )}

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setEditing(null)}
                disabled={editSaving}
                className="flex-1 rounded-2xl border border-[#948979]/40 bg-[#222831] px-4 py-3 text-sm font-semibold text-[#DFD0B8] transition-colors duration-200 hover:border-[#948979] hover:bg-[#31363F] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSaveNickname()}
                disabled={editSaving}
                className="flex-1 rounded-2xl bg-gradient-to-b from-[#DFD0B8] to-[#c9b89a] px-4 py-3 text-sm font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[#DFD0B8]/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {editSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PremiumEmptyState({
  icon,
  title,
  body,
  cta,
  onCta,
}: {
  icon: string;
  title: string;
  body: string;
  cta?: string;
  onCta?: () => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-3xl border border-[#DFD0B8]/10 bg-gradient-to-b from-[#222831] to-[#1c222a] p-14 text-center shadow-2xl shadow-black/25">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#DFD0B8]/30 to-transparent"
      />
      <div className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-[#DFD0B8]/5 blur-3xl" />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 flex flex-col items-center"
      >
        <div className="mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-b from-[#393E46] to-[#31363F] text-5xl shadow-inner ring-1 ring-[#DFD0B8]/10">
          {icon}
        </div>
        <h3 className="mb-2 text-2xl font-bold tracking-tight text-[#DFD0B8]">
          {title}
        </h3>
        <p className="mx-auto max-w-sm text-sm leading-relaxed text-[#948979]">
          {body}
        </p>
        {cta && onCta && (
          <button
            type="button"
            onClick={onCta}
            className="mt-8 rounded-2xl bg-[#DFD0B8] px-6 py-2.5 text-sm font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#DFD0B8]/90 hover:shadow-[#DFD0B8]/25"
          >
            {cta}
          </button>
        )}
      </motion.div>
    </div>
  );
}