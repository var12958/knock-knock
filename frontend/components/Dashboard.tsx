"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import InboxList from "./InboxList";
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

/**
 * Parse a `/chat/group/[groupId]` path into its group id. Returns null for
 * non-group-chat routes.
 */
function parseGroupId(pathname: string): string | null {
  const match = pathname.match(/^\/chat\/group\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function Dashboard() {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  // Bumped after a knock is sent so the sidebar reloads its lists.
  const [refreshKey, setRefreshKey] = useState(0);

  const chatId = parseChatId(pathname);
  const groupId = parseGroupId(pathname);
  const isSend = pathname === "/send";

  // Dashboard view is driven by the `view` query param so the header tabs can
  // route directly to the correct list (Pending / Chats / History).
  const activeTab: "inbox" | "chats" | "history" =
    searchParams.get("view") === "chats"
      ? "chats"
      : searchParams.get("view") === "history"
      ? "history"
      : "inbox";
  const isTabView = !chatId && !groupId && !isSend;

  return (
    <div className="flex h-[calc(100vh-9.5rem)] overflow-hidden rounded-3xl border border-[#DFD0B8]/10 bg-[#222831] shadow-2xl shadow-black/25">
      <div className="flex flex-col">
        <Sidebar refreshKey={refreshKey} />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden bg-[#222831]">
        {isTabView && (
          <div className="flex items-center justify-between border-b border-[#DFD0B8]/10 px-6 py-4">
            <h2 className="text-lg font-bold tracking-tight text-[#DFD0B8]">
              {activeTab === "history"
                ? "History"
                : activeTab === "chats"
                ? "Chats"
                : "Inbox"}
            </h2>
            <button
              type="button"
              onClick={() => router.push("/send")}
              className="rounded-xl bg-[#DFD0B8] px-5 py-2 text-sm font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#DFD0B8]/90 hover:shadow-[#DFD0B8]/25"
            >
              + New Chat
            </button>
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          {chatId ? (
            <ChatRoom requestId={chatId} />
          ) : groupId ? (
            <GroupChatPlaceholder groupId={groupId} />
          ) : isSend ? (
            <div className="h-full overflow-y-auto p-6 sm:p-8">
              <SendRequestForm onMessageSent={() => setRefreshKey((k) => k + 1)} />
            </div>
          ) : chatId === null && /^\/chat\//.test(pathname) ? (
            <InvalidChatState />
          ) : activeTab === "inbox" ? (
            <InboxList refreshKey={refreshKey} initialMode="pending" />
          ) : activeTab === "chats" ? (
            <InboxList refreshKey={refreshKey} initialMode="chats" />
          ) : activeTab === "history" ? (
            <InboxList refreshKey={refreshKey} initialMode="history" />
          ) : (
            <WelcomeState />
          )}
        </div>
      </div>
    </div>
  );
}

function WelcomeState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-10 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full border border-[#DFD0B8]/10 bg-[#393E46] text-4xl shadow-inner ring-1 ring-[#DFD0B8]/10">
        💬
      </div>
      <h3 className="text-xl font-bold tracking-tight text-[#DFD0B8]">
        Select a conversation
      </h3>
      <p className="max-w-sm text-sm leading-relaxed text-[#948979]">
        Pick a chat from the sidebar to start messaging, or tap "New Chat" to
        send a private knock on Flare.
      </p>
    </div>
  );
}

function InvalidChatState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-10 text-center">
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

/**
 * Placeholder for a Group Knock chat room. The full multi-party chat UI is
 * built later; for now this only confirms the route resolves and keeps the
 * sidebar mounted so the selected Group Chat card stays highlighted.
 */
function GroupChatPlaceholder({ groupId }: { groupId: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-10 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full border border-[#DFD0B8]/10 bg-[#393E46] text-4xl shadow-inner ring-1 ring-[#DFD0B8]/10">
        👥
      </div>
      <h3 className="text-xl font-bold tracking-tight text-[#DFD0B8]">
        Group chat coming soon
      </h3>
      <p className="max-w-sm break-all text-sm leading-relaxed text-[#948979]">
        The multi-party chat room for group <span className="font-mono">{groupId}</span>{" "}
        will be available soon. Your individual knocks to each member are
        already on-chain.
      </p>
    </div>
  );
}