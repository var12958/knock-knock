"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useWeb3 } from "@/context/Web3Context";
import { useFirebaseAuth } from "@/context/FirebaseAuthContext";
import { getMailboxContractRead, getMailboxContractWrite } from "@/lib/contracts";
import { decodePreview } from "@/lib/encodePreview";
import { getNicknames, setNickname } from "@/lib/firebaseContacts";

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

interface SidebarProps {
  /** Increment to force a fresh fetch of all requests. */
  refreshKey?: number;
}

/** How many `requests(id)` reads to fire in parallel per batch. */
const FETCH_CHUNK = 64;

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

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

/** Parse a `/chat/[requestId]` path into its id (for active-row highlighting). */
function parseChatId(pathname: string): string | null {
  const match = pathname.match(/^\/chat\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function Sidebar({ refreshKey }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { address, signer } = useWeb3();
  const { user } = useFirebaseAuth();

  const [acceptedChats, setAcceptedChats] = useState<ChatRequest[]>([]);
  const [pendingRequests, setPendingRequests] = useState<ChatRequest[]>([]);
  const [historyRequests, setHistoryRequests] = useState<ChatRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);

  // nickname map keyed by lowercase sender address.
  const [nicknames, setNicknames] = useState<Record<string, string>>({});

  // Edit-nickname modal state.
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);

    try {
      // Read-only contract: no signer needed, no wallet prompt.
      const contract = getMailboxContractRead();
      const nextId = Number(await contract.nextRequestId()); // IDs exist for 1..nextId-1
      const target = address.toLowerCase();

      const accepted: ChatRequest[] = [];
      const pending: ChatRequest[] = [];
      const history: ChatRequest[] = [];

      // Scan newest-first in parallel chunks to keep RPC calls bounded.
      for (let start = nextId - 1; start >= 1; start -= FETCH_CHUNK) {
        const ids: number[] = [];
        for (let j = start; j >= Math.max(1, start - FETCH_CHUNK + 1); j--) {
          ids.push(j);
        }
        const structs = await Promise.all(
          ids.map((id) => contract.requests(BigInt(id))),
        );

        for (let k = 0; k < ids.length; k++) {
          const req = structs[k];
          // Deleted/rejected requests return a zero struct (receiver == 0x0),
          // which never matches `target`, so they are naturally excluded.
          if (!req || req.receiver?.toLowerCase() !== target) continue;

          const item = mapRequest(BigInt(ids[k]), req);
          if (item.accepted) {
            accepted.push(item);
          } else if (Date.now() / 1000 <= item.expirationTime) {
            pending.push(item);
          } else {
            history.push(item);
          }
        }
      }

      setAcceptedChats(accepted);
      setPendingRequests(pending);
      setHistoryRequests(history);
    } catch (err: any) {
      console.error("[Sidebar] Failed to load requests:", err);
      setError(err.reason ?? err.message ?? "Could not load chats");
    } finally {
      setLoading(false);
    }
  }, [address]);

  // Load everything on mount, on account change, and when a knock is sent.
  useEffect(() => {
    if (!address) {
      setAcceptedChats([]);
      setPendingRequests([]);
      setHistoryRequests([]);
      return;
    }
    void loadRequests();
  }, [address, refreshKey, loadRequests]);

  // Fetch nicknames for the addresses in the Chats section.
  useEffect(() => {
    if (!user) return;
    const senders = Array.from(
      new Set(acceptedChats.map((c) => c.sender.toLowerCase())),
    );
    if (senders.length === 0) return;

    let cancelled = false;
    getNicknames(user.uid, senders)
      .then((fetched) => {
        if (cancelled) return;
        setNicknames((prev) => ({ ...prev, ...fetched }));
      })
      .catch((err: any) => {
        console.error("[Sidebar] nickname fetch failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [acceptedChats, user]);

  const handleAccept = useCallback(
    async (requestId: string) => {
      if (!signer) return;
      setActionId(requestId);
      setError(null);
      try {
        const contract = getMailboxContractWrite(signer);
        const tx = await contract.acceptRequest(BigInt(requestId));
        await tx.wait();
        await loadRequests();
        router.push(`/chat/${requestId}`);
      } catch (err: any) {
        console.error("Accept failed:", err);
        setError(err.reason ?? err.message ?? "Accept transaction failed");
      } finally {
        setActionId(null);
      }
    },
    [signer, loadRequests, router],
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
        await loadRequests();
      } catch (err: any) {
        console.error("Reject failed:", err);
        setError(err.reason ?? err.message ?? "Reject transaction failed");
      } finally {
        setActionId(null);
      }
    },
    [signer, loadRequests],
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
        if (trimmed) next[key] = trimmed;
        else delete next[key];
        return next;
      });
      setEditing(null);
    } catch (err: any) {
      console.error("[Sidebar] save nickname failed:", err);
      setEditError(err.message ?? "Could not save nickname");
    } finally {
      setEditSaving(false);
    }
  }

  if (!address) {
    return (
      <aside className="flex w-80 flex-col items-center justify-center gap-3 border-r border-[#DFD0B8]/10 bg-[#222831] p-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#393E46] text-3xl ring-1 ring-[#DFD0B8]/10">
          🦊
        </div>
        <p className="text-sm font-semibold text-[#DFD0B8]">Connect wallet</p>
        <p className="text-xs text-[#948979]">
          Connect MetaMask to view your chats and knocks.
        </p>
      </aside>
    );
  }

  const activeChatId = parseChatId(pathname);

  return (
    <aside className="flex w-80 flex-col border-r border-[#DFD0B8]/10 bg-[#222831]">
      <header className="flex items-center justify-between gap-2 border-b border-[#DFD0B8]/10 px-4 py-4">
        <div className="min-w-0">
          <h2 className="text-lg font-bold tracking-tight text-[#DFD0B8]">
            Chats
          </h2>
          <p className="truncate text-xs text-[#948979]">
            {shortenAddress(address)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.push("/send")}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#DFD0B8]/15 bg-[#393E46] text-lg font-bold text-[#DFD0B8] transition-colors duration-200 hover:border-[#DFD0B8]/40 hover:bg-[#31363F]"
          aria-label="Send a new knock"
          title="Send a new knock"
        >
          +
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {loading && acceptedChats.length === 0 && pendingRequests.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <span className="h-7 w-7 animate-spin rounded-full border-2 border-[#DFD0B8]/30 border-t-[#DFD0B8]" />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {error && (
              <p className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {error}
              </p>
            )}

            {/* Section 1: Chats */}
            <SectionLabel>Chats</SectionLabel>
            {acceptedChats.length === 0 ? (
              <EmptyHint>No conversations yet.</EmptyHint>
            ) : (
              acceptedChats.map((req) => {
                const nickname = nicknames[req.sender.toLowerCase()];
                const initial = nickname ? nickname[0].toUpperCase() : "💬";
                const isActive = activeChatId === req.requestId;
                return (
                  <div
                    key={`chat-${req.requestId}`}
                    className={`group flex items-center gap-3 rounded-xl px-2 py-2 transition-colors duration-200 ${
                      isActive
                        ? "bg-[#393E46]"
                        : "hover:bg-[#393E46]/60"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => router.push(`/chat/${req.requestId}`)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-[#DFD0B8]/10 bg-[#393E46] text-sm font-bold text-[#DFD0B8]">
                        {initial}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-[#DFD0B8]">
                          {nickname ?? shortenAddress(req.sender)}
                        </span>
                        {nickname && (
                          <span className="block truncate text-xs text-[#948979]">
                            {shortenAddress(req.sender)}
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditNickname(req.sender)}
                      aria-label="Edit nickname"
                      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[#948979] opacity-0 transition-colors duration-200 hover:text-[#DFD0B8] focus:text-[#DFD0B8] focus:opacity-100 group-hover:opacity-100"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-3.5 w-3.5"
                        aria-hidden
                      >
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
                  </div>
                );
              })
            )}

            {/* Section 2: Pending */}
            {pendingRequests.length > 0 && (
              <>
                <SectionLabel className="mt-4">Pending</SectionLabel>
                {pendingRequests.map((req) => (
                  <div
                    key={`pending-${req.requestId}`}
                    className="rounded-xl border border-[#DFD0B8]/10 bg-[#393E46] p-3"
                  >
                    <p className="mb-1 truncate text-sm text-[#DFD0B8]">
                      {decodePreview(req.encryptedPreviewMessage) ||
                        "Encrypted knock"}
                    </p>
                    <p className="mb-2 truncate text-xs text-[#948979]">
                      Sender address is hidden to protect privacy.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleAccept(req.requestId)}
                        disabled={actionId === req.requestId}
                        className="flex-1 rounded-lg bg-[#DFD0B8] px-3 py-1.5 text-xs font-bold text-[#222831] transition-colors hover:bg-[#DFD0B8]/90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {actionId === req.requestId ? "..." : "Accept"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReject(req.requestId)}
                        disabled={actionId === req.requestId}
                        className="flex-1 rounded-lg bg-[#948979] px-3 py-1.5 text-xs font-bold text-[#222831] transition-colors hover:bg-[#948979]/80 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {actionId === req.requestId ? "..." : "Reject"}
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Section 3: History */}
            {historyRequests.length > 0 && (
              <>
                <SectionLabel className="mt-4">History</SectionLabel>
                {historyRequests.map((req) => (
                  <button
                    key={`history-${req.requestId}`}
                    type="button"
                    onClick={() => router.push(`/chat/${req.requestId}`)}
                    className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors duration-200 hover:bg-[#393E46]/40"
                  >
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[#393E46] text-sm">
                      📜
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-[#948979]">
                        Knock #{req.requestId} · Expired
                      </span>
                      <span className="block truncate text-xs text-[#948979]/70">
                        {decodePreview(req.encryptedPreviewMessage) || ""}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            )}

            {acceptedChats.length === 0 &&
              pendingRequests.length === 0 &&
              historyRequests.length === 0 &&
              !error && (
                <EmptyHint>
                  No knocks yet. Tap + to send your first knock.
                </EmptyHint>
              )}
          </div>
        )}
      </div>

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
              htmlFor="sidebar-nickname-input"
              className="mb-1.5 block text-xs font-medium text-[#948979]"
            >
              Nickname
            </label>
            <input
              id="sidebar-nickname-input"
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
    </aside>
  );
}

function SectionLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={`px-2 text-[10px] font-bold uppercase tracking-wider text-[#948979] ${className}`}
    >
      {children}
    </p>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-2 text-xs text-[#948979]">{children}</p>;
}