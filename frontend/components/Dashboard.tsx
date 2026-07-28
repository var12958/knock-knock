"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import ChatRoom from "./ChatRoom";
import SendRequestForm from "./SendRequestForm";

/**
 * Parse a `/chat/[requestId]` path into its request id, validating that it is a
 * positive integer. Returns null for non-chat routes or malformed ids.
 */
function parseChatId(pathname: string): string | null {
  const match = pathname.match(/^\/chat\/([^/]+)$/);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  try {
    return BigInt(id) > BigInt(0) ? id : null;
  } catch {
    return null;
  }
}

export default function Dashboard() {
  const pathname = usePathname() ?? "/";
  // Bumped after a knock is sent so the sidebar reloads its lists.
  const [refreshKey, setRefreshKey] = useState(0);

  const chatId = parseChatId(pathname);
  const isSend = pathname === "/send";

  return (
    <div className="flex h-[calc(100vh-9.5rem)] overflow-hidden rounded-3xl border border-[#DFD0B8]/10 bg-[#222831] shadow-2xl shadow-black/25">
      <Sidebar refreshKey={refreshKey} />

      <div className="flex flex-1 overflow-hidden bg-[#222831]">
        {chatId ? (
          <ChatRoom requestId={chatId} />
        ) : isSend ? (
          <div className="flex-1 overflow-y-auto p-6 sm:p-8">
            <SendRequestForm onMessageSent={() => setRefreshKey((k) => k + 1)} />
          </div>
        ) : chatId === null && /^\/chat\//.test(pathname) ? (
          <InvalidChatState />
        ) : (
          <WelcomeState />
        )}
      </div>
    </div>
  );
}

function WelcomeState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full border border-[#DFD0B8]/10 bg-[#393E46] text-4xl shadow-inner ring-1 ring-[#DFD0B8]/10">
        💬
      </div>
      <h3 className="text-xl font-bold tracking-tight text-[#DFD0B8]">
        Select a conversation
      </h3>
      <p className="max-w-sm text-sm leading-relaxed text-[#948979]">
        Pick a chat from the sidebar to start messaging, or send a new knock to
        start a private, end-to-end encrypted conversation on Flare.
      </p>
    </div>
  );
}

function InvalidChatState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full border border-rose-500/20 bg-rose-500/10 text-4xl">
        ⚠️
      </div>
      <h3 className="text-xl font-bold tracking-tight text-[#DFD0B8]">
        Invalid chat request ID
      </h3>
      <p className="max-w-sm text-sm leading-relaxed text-[#948979]">
        That chat request ID could not be found. Pick a conversation from the
        sidebar.
      </p>
    </div>
  );
}