"use client";

import { useEffect, useRef, useState } from "react";
import { ref, push, set, onValue } from "firebase/database";
import { getAuth } from "firebase/auth";
import { realtimeDb } from "@/lib/firebase";
import { useWeb3 } from "@/context/Web3Context";
import { getMailboxContractRead } from "@/lib/contracts";
import { decryptMessage, deriveChatKey, encryptMessage } from "@/lib/chatCrypto";
import { ethers } from "ethers";

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: number;
  isMine: boolean;
  isTip?: boolean;
}

interface RequestDetails {
  sender: string;
  receiver: string;
  accepted: boolean;
}

interface ChatRoomProps {
  requestId: string;
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function ChatRoom({ requestId }: ChatRoomProps) {
  const { address, signer } = useWeb3();
  const [request, setRequest] = useState<RequestDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [isTipping, setIsTipping] = useState(false);
  const [isTipModalOpen, setIsTipModalOpen] = useState(false);
  const [tipAmount, setTipAmount] = useState("0.1");
  const [tipError, setTipError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Load request details from the blockchain.
  useEffect(() => {
    let cancelled = false;

    async function loadRequest() {
      try {
        const contract = getMailboxContractRead();
        const req = await contract.requests(BigInt(requestId));
        if (cancelled) return;

        setRequest({
          sender: req.sender,
          receiver: req.receiver,
          accepted: req.accepted,
        });
      } catch (err: any) {
        console.error("Failed to load request:", err);
        setError(err.message ?? "Could not load chat request");
      } finally {
        setLoading(false);
      }
    }

    loadRequest();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  // Validate that the connected wallet is a participant and the request is accepted.
  useEffect(() => {
    if (!request || !address) return;

    const isParticipant =
      address.toLowerCase() === request.sender.toLowerCase() ||
      address.toLowerCase() === request.receiver.toLowerCase();

    if (!isParticipant) {
      setError("You are not a participant in this chat.");
      return;
    }

    if (!request.accepted) {
      setError("This chat request has not been accepted yet.");
      return;
    }

    setError(null);
  }, [request, address]);

  // Subscribe to Firebase messages in real time.
  useEffect(() => {
    if (!request || !address) return;

    const isParticipant =
      address.toLowerCase() === request.sender.toLowerCase() ||
      address.toLowerCase() === request.receiver.toLowerCase();
    if (!isParticipant || !request.accepted) return;

    if (!realtimeDb) {
      setError("Firebase Database is not configured.");
      return;
    }

    const messagesRef = ref(realtimeDb, `chats/${requestId}/messages`);
    const key = deriveChatKey(request.sender, request.receiver);

    console.log(`[ChatRoom] Subscribing to read path: chats/${requestId}/messages`);
    console.log("[ChatRoom] Firebase Auth currentUser (read):", getAuth(realtimeDb.app).currentUser);

    const unsubscribe = onValue(
      messagesRef,
      (snapshot) => {
        const data = snapshot.val();
        if (!data) {
          setMessages([]);
          return;
        }

        const loaded: ChatMessage[] = [];

        Object.entries(data).forEach(([id, value]: [string, any]) => {
          if (
            !value ||
            typeof value.sender !== "string" ||
            typeof value.text !== "string"
          ) {
            return;
          }
          // Tip notifications are plaintext system messages, not encrypted —
          // skip decryption so they render verbatim instead of as a lock.
          const isTip = value.isTip === true;
          const plain = isTip ? value.text : decryptMessage(value.text, key);
          loaded.push({
            id,
            sender: value.sender,
            text: isTip ? plain : plain ?? "🔒 Unable to decrypt message",
            timestamp: value.timestamp ?? 0,
            isMine: value.sender.toLowerCase() === address.toLowerCase(),
            isTip,
          });
        });

        loaded.sort((a, b) => a.timestamp - b.timestamp);
        setMessages(loaded);
      },
      (err: any) => {
        console.error("[ChatRoom] Firebase read failed:", err);
        setError(err.message ?? "Failed to load messages");
      },
    );

    return () => {
      unsubscribe();
    };
  }, [request, requestId, address]);

  // Auto-scroll to the latest message.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || !request || !address || !signer) return;

    setSending(true);

    try {
      if (!realtimeDb) {
        throw new Error("Firebase Database is not configured.");
      }

      const key = deriveChatKey(request.sender, request.receiver);
      const encrypted = encryptMessage(draft.trim(), key);

      const messagesRef = ref(realtimeDb, `chats/${requestId}/messages`);
      const newMessageRef = push(messagesRef);
      const exactPath = `chats/${requestId}/messages/${newMessageRef.key}`;

      console.log(`[ChatRoom] Database write path: ${exactPath}`);
      console.log("[ChatRoom] Firebase Auth currentUser (write):", getAuth(realtimeDb.app).currentUser);
      console.log("[ChatRoom] Message payload:", {
        sender: address,
        text: encrypted,
        timestamp: Date.now(),
      });

      await set(newMessageRef, {
        sender: address,
        text: encrypted,
        timestamp: Date.now(),
      });

      setDraft("");
    } catch (err: any) {
      console.error("[ChatRoom] Failed to send message:", err);
      console.error("[ChatRoom] Error code:", err.code);
      console.error("[ChatRoom] Error message:", err.message);
      setError(err.message ?? "Message could not be sent");
    } finally {
      setSending(false);
    }
  }

  // Open the tip modal, resetting the amount to the default each time.
  function openTipModal() {
    setTipAmount("0.1");
    setTipError(null);
    setIsTipModalOpen(true);
  }

  // Send a native FLR tip to the other participant and log a system message.
  // Reads the amount from the tip modal state.
  async function handleTip() {
    if (!signer || !request || !address) return;

    const recipient =
      address.toLowerCase() === request.sender.toLowerCase()
        ? request.receiver
        : request.sender;

    if (recipient.toLowerCase() === address.toLowerCase()) {
      setTipError("You cannot tip yourself.");
      return;
    }

    const amount = tipAmount.trim();
    if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
      setTipError("Please enter a valid tip amount.");
      return;
    }

    // Close the modal on valid submission; the spinner takes over on the Tip button.
    setIsTipModalOpen(false);
    setTipError(null);
    setIsTipping(true);
    setError(null);

    try {
      // Standard native-token transfer to the other user's wallet.
      const tx = await signer.sendTransaction({
        to: recipient,
        value: ethers.parseEther(amount),
      });
      await tx.wait();

      if (!realtimeDb) {
        throw new Error("Firebase Database is not configured.");
      }

      // Log a plaintext system notification in the chat thread.
      const messagesRef = ref(realtimeDb, `chats/${requestId}/messages`);
      const tipRef = push(messagesRef);
      await set(tipRef, {
        sender: "system",
        text: `Sent a tip of ${amount} FLR!`,
        timestamp: Date.now(),
        isTip: true,
      });
    } catch (err: any) {
      console.error("[ChatRoom] Tip failed:", err);
      setError(err.shortMessage ?? err.message ?? "Tip transaction failed");
    } finally {
      setIsTipping(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-[#948979]">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-[#DFD0B8]/30 border-t-[#DFD0B8]" />
          <span className="text-sm">Loading chat... 🚪</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 p-8 text-center">
        <p className="text-rose-300">{error}</p>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="rounded-2xl border border-[#DFD0B8]/10 bg-[#393E46] p-8 text-center">
        <p className="text-[#DFD0B8]">Chat request not found.</p>
      </div>
    );
  }

  const otherAddress =
    address?.toLowerCase() === request.sender.toLowerCase()
      ? request.receiver
      : request.sender;

  return (
    <div className="relative mx-auto flex h-[calc(100vh-9.5rem)] max-w-3xl flex-col overflow-hidden rounded-3xl border border-[#DFD0B8]/10 bg-[#393E46] shadow-2xl shadow-black/25">
      {/* Header */}
      <div className="border-b border-[#DFD0B8]/10 bg-[#393E46]/95 px-6 py-4 backdrop-blur-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full border border-[#DFD0B8]/10 bg-[#222831] text-xl">
              💬
            </div>
            <div>
              <h2 className="text-lg font-bold text-[#DFD0B8]">
                Chat #{requestId}
              </h2>
              <p className="text-xs text-[#948979]">
                With {shortenAddress(otherAddress)}
              </p>
            </div>
          </div>
          <span className="rounded-full border border-[#DFD0B8]/20 bg-[#222831] px-4 py-1.5 text-xs font-bold text-[#DFD0B8]">
            Active
          </span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#222831] text-3xl ring-1 ring-[#DFD0B8]/10">
                👋
              </div>
              <p className="text-sm text-[#948979]">
                No messages yet. Say hello — it&apos;s end-to-end encrypted.
              </p>
            </div>
          </div>
        ) : (
          <ul role="list" className="flex flex-col gap-5">
            {messages.map((msg) => {
              if (msg.isTip) {
                return (
                  <li
                    key={msg.id}
                    className="animate-message-in flex justify-center"
                  >
                    <div className="flex max-w-[90%] items-center gap-2 rounded-2xl bg-[#DFD0B8] px-5 py-2.5 text-xs font-bold text-[#222831] shadow-md">
                      <span className="text-base leading-none">💸</span>
                      <span>{msg.text}</span>
                      <span className="text-[10px] font-normal text-[#222831]/60">
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                  </li>
                );
              }

              return (
                <li
                  key={msg.id}
                  className={`animate-message-in flex max-w-[85%] flex-col ${
                    msg.isMine ? "ml-auto items-end" : "items-start"
                  }`}
                >
                  <span className="mb-1 text-xs text-[#948979]">
                    {msg.isMine ? "You" : shortenAddress(msg.sender)}
                  </span>
                  <div
                    className={`relative rounded-3xl px-5 py-3 text-sm leading-relaxed shadow-md ${
                      msg.isMine
                        ? "rounded-br-md bg-gradient-to-b from-[#DFD0B8] to-[#c9b89a] text-[#222831]"
                        : "rounded-bl-md border border-[#DFD0B8]/10 bg-[#31363F] text-[#DFD0B8]"
                    }`}
                  >
                    {msg.text}
                  </div>
                  <span className="mt-1 text-[10px] text-[#948979]">
                    {new Date(msg.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </li>
              );
            })}
            <div ref={messagesEndRef} />
          </ul>
        )}
      </div>

      {/* Input */}
      <form
        onSubmit={handleSend}
        className="border-t border-[#DFD0B8]/10 bg-[#393E46]/95 px-5 py-5 backdrop-blur-xl sm:px-6"
      >
        <div className="flex gap-3">
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <input
            id="chat-input"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type an encrypted message..."
            disabled={sending || isTipping}
            className="flex-1 rounded-2xl border border-[#948979]/50 bg-[#222831] px-5 py-3.5 text-sm text-[#DFD0B8] transition-all duration-200 placeholder:text-[#948979]/60 focus:border-[#DFD0B8] focus:outline-none focus:ring-1 focus:ring-[#DFD0B8]/50 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="button"
            onClick={openTipModal}
            disabled={isTipping || sending || !signer}
            aria-label="Send a FLR tip"
            className="flex items-center justify-center gap-1.5 rounded-2xl border border-[#DFD0B8]/30 bg-[#222831] px-4 py-3.5 text-sm font-bold text-[#DFD0B8] shadow-md transition-all duration-300 hover:-translate-y-0.5 hover:border-[#DFD0B8] hover:bg-[#31363F] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
          >
            {isTipping ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#DFD0B8]/30 border-t-[#DFD0B8]" />
            ) : (
              <>
                <span className="text-base leading-none">💸</span>
                <span className="hidden sm:inline">Tip</span>
              </>
            )}
          </button>
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-b from-[#DFD0B8] to-[#c9b89a] px-6 py-3.5 text-sm font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[#DFD0B8]/25 disabled:cursor-not-allowed disabled:from-[#948979] disabled:to-[#948979] disabled:text-[#222831] disabled:opacity-60 disabled:shadow-none"
          >
            {sending ? (
              "Sending..."
            ) : (
              <>
                <svg
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="h-4 w-4"
                  aria-hidden
                >
                  <path d="M3.4 20.4l17.45-8.3a1 1 0 000-1.8L3.4 1.99a1 1 0 00-1.39 1.18L4.2 9.5a.5.5 0 00.45.39l8.85.6a.2.2 0 01.01.4l-8.86.6a.5.5 0 00-.45.39l-2.2 6.34A1 1 0 003.4 20.4z" />
                </svg>
                Send
              </>
            )}
          </button>
        </div>
        <p className="mt-2 text-xs text-[#948979]">
          Messages are encrypted client-side before reaching Firebase.
        </p>
      </form>

      {/* Tip modal */}
      {isTipModalOpen && (
        <div
          className="absolute inset-0 z-20 flex animate-message-in items-center justify-center rounded-3xl bg-black/50 px-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsTipModalOpen(false);
          }}
        >
          <div className="w-full max-w-sm rounded-3xl border border-[#DFD0B8]/15 bg-[#393E46] p-6 shadow-2xl shadow-black/40">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#222831] text-xl ring-1 ring-[#DFD0B8]/10">
                💸
              </div>
              <div>
                <h3 className="text-base font-bold text-[#DFD0B8]">
                  Send a tip
                </h3>
                <p className="text-xs text-[#948979]">
                  To {shortenAddress(otherAddress)}
                </p>
              </div>
            </div>

            <label
              htmlFor="tip-amount"
              className="mb-1.5 block text-xs font-medium text-[#948979]"
            >
              Amount (FLR)
            </label>
            <input
              id="tip-amount"
              type="text"
              inputMode="decimal"
              autoFocus
              value={tipAmount}
              onChange={(e) => {
                setTipAmount(e.target.value);
                setTipError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleTip();
                } else if (e.key === "Escape") {
                  setIsTipModalOpen(false);
                }
              }}
              className="w-full rounded-2xl border border-[#948979]/50 bg-[#222831] px-4 py-3 text-sm text-[#DFD0B8] transition-all duration-200 placeholder:text-[#948979]/60 focus:border-[#DFD0B8] focus:outline-none focus:ring-1 focus:ring-[#DFD0B8]/50"
            />
            {tipError && (
              <p className="mt-2 text-xs text-rose-300">{tipError}</p>
            )}

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setIsTipModalOpen(false)}
                className="flex-1 rounded-2xl border border-[#948979]/40 bg-[#222831] px-4 py-3 text-sm font-semibold text-[#DFD0B8] transition-colors duration-200 hover:border-[#948979] hover:bg-[#31363F]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleTip}
                className="flex-1 rounded-2xl bg-gradient-to-b from-[#DFD0B8] to-[#c9b89a] px-4 py-3 text-sm font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[#DFD0B8]/25"
              >
                Confirm Tip
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
