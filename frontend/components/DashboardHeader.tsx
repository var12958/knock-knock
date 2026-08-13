"use client";

import { useRouter, useSearchParams } from "next/navigation";

interface DashboardHeaderProps {
  activeTab: "inbox" | "chats" | "history";
  isOnSendPage: boolean;
}

export default function DashboardHeader({
  activeTab,
  isOnSendPage,
}: DashboardHeaderProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleTabClick = (tab: "inbox" | "chats" | "history") => {
    const view = tab === "inbox" ? "inbox" : tab;
    router.push(`/?view=${view}`);
  };

  const handleNewChat = () => {
    // Preserve the current view in the query params when navigating to /send
    const currentView = searchParams.get("view") || "inbox";
    router.push(`/send?view=${currentView}`);
  };

  return (
    <div className="flex items-center justify-between border-b border-[#DFD0B8]/10 px-6 py-4">
      <div className="flex gap-6">
        <button
          type="button"
          onClick={() => handleTabClick("inbox")}
          className={`text-sm font-semibold transition-all duration-200 ${
            activeTab === "inbox"
              ? "border-b-2 border-[#DFD0B8] text-[#DFD0B8]"
              : "border-b-2 border-transparent text-[#948979] hover:text-[#DFD0B8]"
          }`}
        >
          Pending
        </button>
        <button
          type="button"
          onClick={() => handleTabClick("chats")}
          className={`text-sm font-semibold transition-all duration-200 ${
            activeTab === "chats"
              ? "border-b-2 border-[#DFD0B8] text-[#DFD0B8]"
              : "border-b-2 border-transparent text-[#948979] hover:text-[#DFD0B8]"
          }`}
        >
          Chats
        </button>
        <button
          type="button"
          onClick={() => handleTabClick("history")}
          className={`text-sm font-semibold transition-all duration-200 ${
            activeTab === "history"
              ? "border-b-2 border-[#DFD0B8] text-[#DFD0B8]"
              : "border-b-2 border-transparent text-[#948979] hover:text-[#DFD0B8]"
          }`}
        >
          History
        </button>
      </div>

      {!isOnSendPage && (
        <button
          type="button"
          onClick={handleNewChat}
          className="rounded-xl bg-[#DFD0B8] px-5 py-2 text-sm font-bold text-[#222831] shadow-lg shadow-[#DFD0B8]/15 transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#DFD0B8]/90 hover:shadow-[#DFD0B8]/25"
        >
          + New Chat
        </button>
      )}
    </div>
  );
}
