"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useWeb3 } from "@/context/Web3Context";
import { useFirebaseAuth } from "@/context/FirebaseAuthContext";
import { getMailboxContractWrite } from "@/lib/contracts";
import { decodePreview } from "@/lib/encodePreview";
import { setNickname, subscribeNicknames } from "@/lib/firebaseContacts";
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

export default function InboxList({ refreshKey }: InboxListProps) {
  const router = useRouter();
  const { signer, address } = useWeb3();
  const { user } = useFirebaseAuth();
  const [mode, setMode] = useState<Mode>("pending");

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

        const [ids, rawRequests]: [bigint[], any[]] = await Promise.all([
          signerContract.getPendingRequestIds(address, offsetToUse, PAGE_SIZE),
          signerContract.getPendingRequests(address, offsetToUse, PAGE_SIZE),
        ]);

        const pending: ChatRequest[] = ids.map((id, i) =>
          mapRequest(id, rawRequests[i]),
        );

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
        const [ids, rawRequests]: [bigint[], any[]] =
          await contract.getRequestsByReceiver(address, offsetToUse, PAGE_SIZE);

        const mapped: ChatRequest[] = ids.map((id, i) =>
          mapRequest(id, rawRequests[i]),
        );

        setReceiverRequests((prev) =>
          reset ? mapped : [...prev, ...mapped],
        );
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
    if (!address || !signer) {
      setRequests([]);
      setReceiverRequests([]);
      setOffset(0);
      setReceiverOffset(0);
      setHasMore(true);
      setReceiverHasMore(true);
      return;
    }

    void loadRequests(true);
    void loadReceiverRequests(true);
  }, [address, signer, refreshKey, loadRequests, loadReceiverRequests]);

  const chats = useMemo(
    () => receiverRequests.filter((r) => r.accepted),
    [receiverRequests],
  );

  const history = useMemo(
    () =>
      receiverRequests.filter(
        (r) => !r.accepted && Date.now() / 1000 > r.expirationTime,
      ),
    [receiverRequests],
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

  const emptyCopy: Record<Mode, { icon: string; title: string; body: string }> = {
    pending: {
      icon: "🚪",
      title: "Your door is quiet",
      body: "No pending chat requests right now. Send a knock to start a private conversation.",
    },
    chats: {
      icon: "💬",
      title: "No conversations yet",
      body: "Accept a knock to start chatting. Your active conversations will appear here.",
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
        <div className="relative overflow-hidden rounded-3xl border border-[#DFD0B8]/10 bg-[#222831] p-14 text-center shadow-xl shadow-black/20">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#DFD0B8]/25 to-transparent"
          />
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-[#393E46] text-4xl shadow-inner ring-1 ring-[#DFD0B8]/10">
            {emptyCopy[mode].icon}
          </div>
          <h3 className="mb-2 text-xl font-bold tracking-tight text-[#DFD0B8]">
            {emptyCopy[mode].title}
          </h3>
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-[#948979]">
            {emptyCopy[mode].body}
          </p>
        </div>
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
                  <p className="truncate text-sm font-bold text-[#DFD0B8]">
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