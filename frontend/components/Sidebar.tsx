"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useWeb3 } from "@/context/Web3Context";
import { useFirebaseAuth } from "@/context/FirebaseAuthContext";
import { onValue, ref } from "firebase/database";
import { realtimeDb } from "@/lib/firebase";
import { getMailboxContractRead, getMailboxContractWrite } from "@/lib/contracts";
import { decodePreview } from "@/lib/encodePreview";
import { setNickname, subscribeNicknames } from "@/lib/firebaseContacts";
import {
  addDeletedChat,
  subscribeDeletedChats,
} from "@/lib/firebaseDeletedChats";
import {
  type MLBehaviorScore,
  runMLBehaviorCheck,
} from "@/lib/runMLBehaviorCheck";
import SidebarPendingCard from "./SidebarPendingCard";

/**
 * A Group Knock mapping persisted by SendRequestForm after a multi-receiver
 * send. `requestIds` are the on-chain mailbox request ids created for each
 * receiver; clicking the card routes to /chat/group/{groupId}.
 */
interface GroupChat {
  groupId: string;
  requestIds: string[];
  createdAt: number;
}

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

/** Parse a `/chat/group/[groupId]` path into its group id (active highlighting). */
function parseGroupId(pathname: string): string | null {
  const match = pathname.match(/^\/chat\/group\/([^/]+)$/);
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

  // TEE ML behavior check results keyed by request id.
  const [mlScores, setMlScores] = useState<Record<string, MLBehaviorScore | null>>({});
  const [mlLoadingIds, setMlLoadingIds] = useState<Set<string>>(new Set());
  const [mlErrors, setMlErrors] = useState<Record<string, string>>({});
  const mlAbortControllersRef = useRef<Record<string, AbortController>>({});
  const mlCheckTokensRef = useRef<Record<string, number>>({});

  // Request ids the user has hidden from their Chats list (persisted in
  // Firebase at deletedChats/{uid}/{requestId}). Accepted chats and History
  // items whose id is in this set are filtered out of the rendered list so the
  // two views stay consistent. Kept as a Set so membership checks are O(1) and
  // the real-time subscription can reconcile it directly.
  const [deletedChats, setDeletedChats] = useState<Set<string>>(new Set());
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Mirror of deletedChats used inside async loaders without recreating callbacks.
  const deletedChatsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    deletedChatsRef.current = deletedChats;
  }, [deletedChats]);

  // Group Knock mappings for the current user (persisted at groups/{uid}).
  // Each entry groups the on-chain request ids created for a multi-receiver
  // send into a single Group Chat card rendered above individual chats.
  const [groups, setGroups] = useState<GroupChat[]>([]);

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

      const acceptedMap = new Map<string, ChatRequest>();
      const pendingMap = new Map<string, ChatRequest>();
      const historyMap = new Map<string, ChatRequest>();

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

          const sender = req.sender?.toLowerCase();
          if (sender === target) continue;

          const item = mapRequest(BigInt(ids[k]), req);
          // Deduplicate by requestId within each category.
          if (item.accepted) {
            acceptedMap.set(item.requestId, item);
          } else if (Date.now() / 1000 <= item.expirationTime) {
            pendingMap.set(item.requestId, item);
          } else {
            // History contains only unaccepted, expired requests. Rejected
            // requests are cleaned up on-chain and never returned. Hidden
            // (deleted) chats are dropped here and again at render time so the
            // Firebase subscription remains authoritative.
            if (!deletedChatsRef.current.has(item.requestId)) {
              historyMap.set(item.requestId, item);
            }
          }
        }
      }

      // Newest first in each list so recent activity appears at the top.
      const pending = Array.from(pendingMap.values()).sort(
        (a, b) => b.expirationTime - a.expirationTime,
      );
      const history = Array.from(historyMap.values()).sort(
        (a, b) => b.expirationTime - a.expirationTime,
      );

      // Accepted chats: one entry per unique sender, keep the newest requestId.
      const acceptedBySender = new Map<string, ChatRequest>();
      acceptedMap.forEach((req) => {
        const sender = req.sender.toLowerCase();
        const existing = acceptedBySender.get(sender);
        if (!existing || BigInt(req.requestId) > BigInt(existing.requestId)) {
          acceptedBySender.set(sender, req);
        }
      });
      const accepted = Array.from(acceptedBySender.values()).sort(
        (a, b) => b.expirationTime - a.expirationTime,
      );

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

  // Abort in-flight ML checks and clear per-account results when the wallet
  // changes so a different user never sees another account's analysis.
  useEffect(() => {
    Object.values(mlAbortControllersRef.current).forEach((controller) => {
      controller.abort();
    });
    mlAbortControllersRef.current = {};
    mlCheckTokensRef.current = {};
    setMlScores({});
    setMlLoadingIds(new Set());
    setMlErrors({});
  }, [address]);

  // Subscribe to the user's entire private nickname address book in real time.
  // The write path is contacts/${uid}/${senderAddress} (see contactsRef); this
  // subscribes to the parent contacts/${uid} node and delivers a lowercase-keyed
  // map on the first load and on every change. This decouples nickname loading
  // from the on-chain chats loading (which previously gated the fetch) so saved
  // nicknames reliably appear on the next app load and stay in sync.
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
      console.error("[Sidebar] nickname subscription failed:", err);
    }
  }, [user]);

  // Subscribe to the user's hidden-chats id set in real time. This is decoupled
  // from the on-chain chats fetch (same pattern as nicknames): the flag set
  // populates as soon as the user is authenticated and reconciles the accepted
  // list via the render-time filter below.
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
      console.error("[Sidebar] deletedChats subscription failed:", err);
    }
  }, [user]);

  // Subscribe to the user's Group Knock mappings in real time. Each mapping is
  // written by SendRequestForm after a multi-receiver send and rendered as a
  // Group Chat card above the individual accepted chats.
  useEffect(() => {
    if (!user || !realtimeDb) return;
    let active = true;
    try {
      const groupsRef = ref(realtimeDb, `groups/${user.uid}`);
      const unsubscribe = onValue(groupsRef, (snapshot) => {
        if (!active) return;
        if (!snapshot.exists()) {
          setGroups([]);
          return;
        }
        const val = snapshot.val() as Record<
          string,
          { requestIds?: string[]; createdAt?: number }
        >;
        const list: GroupChat[] = Object.entries(val).map(
          ([groupId, g]) => ({
            groupId,
            requestIds: Array.isArray(g.requestIds) ? g.requestIds : [],
            createdAt: typeof g.createdAt === "number" ? g.createdAt : 0,
          }),
        );
        // Newest groups first.
        list.sort((a, b) => b.createdAt - a.createdAt);
        setGroups(list);
      });
      return () => {
        active = false;
        unsubscribe();
      };
    } catch (err: any) {
      console.error("[Sidebar] groups subscription failed:", err);
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

      // Cancel any previous in-flight check for this request so rapid re-clicks
      // do not race and stale results cannot update state.
      const requestKey = request.requestId;
      const token = (mlCheckTokensRef.current[requestKey] ?? 0) + 1;
      mlCheckTokensRef.current[requestKey] = token;
      mlAbortControllersRef.current[requestKey]?.abort();
      const abortController = new AbortController();
      mlAbortControllersRef.current[requestKey] = abortController;

      setMlLoadingIds((prev) => new Set(prev).add(requestKey));
      setMlErrors((prev) => {
        const next = { ...prev };
        delete next[requestKey];
        return next;
      });

      try {
        const expectedSigner =
          process.env.NEXT_PUBLIC_TEE_SIGNER_ADDRESS?.trim() || undefined;
        const score = await runMLBehaviorCheck(
          proxyUrl,
          request.sender,
          expectedSigner,
          abortController.signal,
        );
        if (mlCheckTokensRef.current[requestKey] !== token) return;
        setMlScores((prev) => ({ ...prev, [requestKey]: score }));
      } catch (err: any) {
        if (err.name === "AbortError") return;
        if (mlCheckTokensRef.current[requestKey] !== token) return;
        setMlErrors((prev) => ({
          ...prev,
          [requestKey]: err.message ?? "Behavior check failed",
        }));
      } finally {
        if (mlCheckTokensRef.current[requestKey] === token) {
          delete mlAbortControllersRef.current[requestKey];
          setMlLoadingIds((prev) => {
            const next = new Set(prev);
            next.delete(requestKey);
            return next;
          });
        }
      }
    },
    [],
  );

  function openEditNickname(sender: string) {
    setEditing(sender);
    setEditValue(nicknames[sender.toLowerCase()] ?? "");
    setEditError(null);
  }

  /**
   * Hide an accepted chat from the user's Chats list. Hiding is a client-side
   * preference only — it writes a truthy flag to `deletedChats/{uid}/{requestId}`
   * and the render-time filter drops the row. It does NOT touch the on-chain
   * request or the encrypted chat history. Optimistic local update first so
   * the row disappears instantly; the real-time subscription reconciles.
   */
  const handleDeleteChat = useCallback(
    async (requestId: string) => {
      if (!user) return;
      setActionId(requestId);
      setDeletingId(requestId);
      setError(null);
      // Optimistic: drop the row immediately.
      setDeletedChats((prev) => {
        const next = new Set(prev);
        next.add(requestId);
        return next;
      });
      try {
        await addDeletedChat(user.uid, requestId);
      } catch (err: any) {
        console.error("[Sidebar] delete chat failed:", err);
        // Roll back the optimistic hide so the row reappears.
        setDeletedChats((prev) => {
          const next = new Set(prev);
          next.delete(requestId);
          return next;
        });
        setError(err.message ?? "Could not hide chat");
      } finally {
        setActionId(null);
        setDeletingId(null);
      }
    },
    [user],
  );

  async function handleSaveNickname() {
    if (!user || !editing) return;
    const trimmed = editValue.trim();
    setEditSaving(true);
    setEditError(null);
    try {
      // Writes to contacts/${uid}/${senderAddress.toLowerCase()} (see contactsRef).
      await setNickname(user.uid, editing, trimmed);
      // Optimistic local update; the onValue subscription above will reconcile.
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
          Connect your wallet to view your chats and knocks.
        </p>
      </aside>
    );
  }

  const activeChatId = parseChatId(pathname);
  const activeGroupId = parseGroupId(pathname);

  // Accepted chats the user has NOT hidden. Filtering at render time (rather
  // than inside loadRequests) keeps the hidden list authoritative even when
  // the Firebase subscription arrives after the on-chain fetch.
  const visibleAcceptedChats = acceptedChats.filter(
    (req) => !deletedChats.has(req.requestId),
  );

  // History items the user has NOT hidden. The same deletedChats set drives
  // both the Chats and History sections so hiding a chat removes it everywhere.
  const visibleHistoryRequests = historyRequests.filter(
    (req) => !deletedChats.has(req.requestId),
  );

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

      <div className="flex-1 overflow-y-auto px-4 py-4">
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

            {/* Section 0: Group Chats — multi-party knocks rendered above
                individual accepted chats. */}
            {groups.length > 0 && (
              <>
                <SectionLabel>Group Chats</SectionLabel>
                {groups.map((g) => {
                  const isActive = activeGroupId === g.groupId;
                  return (
                    <button
                      key={`group-${g.groupId}`}
                      type="button"
                      onClick={() => router.push(`/chat/group/${g.groupId}`)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors duration-200 ${
                        isActive ? "bg-[#393E46]" : "hover:bg-[#393E46]/60"
                      }`}
                    >
                      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-[#DFD0B8]/10 bg-[#393E46] text-sm">
                        👥
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-[#DFD0B8]">
                          Group Chat
                        </span>
                        <span className="block truncate text-xs text-[#948979]">
                          {g.requestIds.length} members
                        </span>
                      </span>
                    </button>
                  );
                })}
              </>
            )}

            {/* Section 1: Chats */}
            <SectionLabel className={groups.length > 0 ? "mt-4" : ""}>
              Chats
            </SectionLabel>
            {visibleAcceptedChats.length === 0 ? (
              <SidebarEmpty
                icon="💬"
                title="No conversations yet"
                body="Accept a knock to start chatting."
              />
            ) : (
              visibleAcceptedChats.map((req) => {
                const nickname = nicknames[req.sender.toLowerCase()];
                const initial = nickname ? nickname[0].toUpperCase() : "💬";
                const isActive = activeChatId === req.requestId;
                const isDeleting = deletingId === req.requestId;
                return (
                  <div
                    key={`chat-${req.requestId}`}
                    className={`group flex items-center gap-3 rounded-xl px-3 py-3 transition-colors duration-200 ${
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
                    <button
                      type="button"
                      onClick={() => void handleDeleteChat(req.requestId)}
                      disabled={isDeleting || actionId === req.requestId}
                      aria-label={`Hide chat ${nickname ?? shortenAddress(req.sender)}`}
                      title="Hide chat"
                      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[#948979] opacity-0 transition-colors duration-200 hover:text-rose-300 focus:text-rose-300 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 group-hover:opacity-100"
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
                        <path d="M3 6h18" />
                        <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6M14 11v6" />
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
                  <SidebarPendingCard
                    key={`pending-${req.requestId}`}
                    requestId={req.requestId}
                    sender={req.sender}
                    encryptedPreviewMessage={req.encryptedPreviewMessage}
                    isRevealed={req.isRevealed}
                    actionId={actionId}
                    mlScore={mlScores[req.requestId]}
                    mlLoading={mlLoadingIds.has(req.requestId)}
                    mlError={mlErrors[req.requestId]}
                    onAccept={() => void handleAccept(req.requestId)}
                    onReject={() => void handleReject(req.requestId)}
                    onCheck={() => void handleCheckML(req)}
                  />
                ))}
              </>
            )}

            {/* Section 3: History */}
            {visibleHistoryRequests.length > 0 && (
              <>
                <SectionLabel className="mt-4">History</SectionLabel>
                {visibleHistoryRequests.map((req) => (
                  <button
                    key={`history-${req.requestId}`}
                    type="button"
                    onClick={() => router.push(`/chat/${req.requestId}`)}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors duration-200 hover:bg-[#393E46]/40"
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

            {visibleAcceptedChats.length === 0 &&
              pendingRequests.length === 0 &&
              visibleHistoryRequests.length === 0 &&
              !error && (
                <SidebarEmpty
                  icon="🚪"
                  title="Your door is quiet"
                  body="Tap + to send your first private knock."
                />
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
      className={`px-3 text-[10px] font-bold uppercase tracking-wider text-[#948979] ${className}`}
    >
      {children}
    </p>
  );
}

function SidebarEmpty({
  icon,
  title,
  body,
}: {
  icon: string;
  title: string;
  body: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col items-center rounded-2xl border border-[#DFD0B8]/10 bg-[#222831]/60 px-4 py-6 text-center"
    >
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#393E46] text-2xl ring-1 ring-[#DFD0B8]/10">
        {icon}
      </div>
      <p className="mb-1 text-sm font-bold text-[#DFD0B8]">{title}</p>
      <p className="text-xs leading-relaxed text-[#948979]">{body}</p>
    </motion.div>
  );
}