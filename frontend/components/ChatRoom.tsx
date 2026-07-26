"use client";

import { useEffect, useRef, useState } from "react";
import { ref, push, onValue, off } from "firebase/database";
import { realtimeDb } from "@/lib/firebase";
import { useWeb3 } from "@/context/Web3Context";
import { getMailboxContractRead } from "@/lib/contracts";
import { decryptMessage, deriveChatKey, encryptMessage } from "@/lib/chatCrypto";

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: number;
  isMine: boolean;
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

    const unsubscribe = onValue(messagesRef, (snapshot) => {
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
        const plain = decryptMessage(value.text, key);
        loaded.push({
          id,
          sender: value.sender,
          text: plain ?? "🔒 Unable to decrypt message",
          timestamp: value.timestamp ?? 0,
          isMine: value.sender.toLowerCase() === address.toLowerCase(),
        });
      });

      loaded.sort((a, b) => a.timestamp - b.timestamp);
      setMessages(loaded);
    });

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

      await push(ref(realtimeDb, `chats/${requestId}/messages`), {
        sender: address,
        text: encrypted,
        timestamp: Date.now(),
      });

      setDraft("");
    } catch (err: any) {
      console.error("Failed to send message:", err);
      setError(err.message ?? "Message could not be sent");
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="text-slate-500">Loading chat... 🚪</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-8 text-center">
        <p className="text-red-700">{error}</p>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
        <p className="text-slate-600">Chat request not found.</p>
      </div>
    );
  }

  const otherAddress =
    address?.toLowerCase() === request.sender.toLowerCase()
      ? request.receiver
      : request.sender;

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="border-b border-slate-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-800">
              Chat #{requestId}
            </h2>
            <p className="text-xs text-slate-500">
              With {shortenAddress(otherAddress)}
            </p>
          </div>
          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700">
            Active
          </span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-slate-400">No messages yet. Say hello! 👋</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex max-w-[80%] flex-col ${
                  msg.isMine ? "ml-auto items-end" : "items-start"
                }`}
              >
                <span className="mb-1 text-xs text-slate-400">
                  {msg.isMine ? "You" : shortenAddress(msg.sender)}
                </span>
                <div
                  className={`rounded-2xl px-4 py-2.5 text-sm ${
                    msg.isMine
                      ? "bg-brand-600 text-white"
                      : "bg-slate-100 text-slate-800"
                  }`}
                >
                  {msg.text}
                </div>
                <span className="mt-1 text-[10px] text-slate-400">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <form
        onSubmit={handleSend}
        className="border-t border-slate-200 px-6 py-4"
      >
        <div className="flex gap-3">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type an encrypted message..."
            disabled={sending}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="rounded-lg bg-brand-600 px-5 py-2.5 font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Messages are encrypted client-side before reaching Firebase.
        </p>
      </form>
    </div>
  );
}
