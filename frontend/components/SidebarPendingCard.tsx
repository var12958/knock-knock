"use client";

import PendingMLCheck from "./PendingMLCheck";
import { decodePreview } from "@/lib/encodePreview";
import { type MLBehaviorScore } from "@/lib/runMLBehaviorCheck";

interface SidebarPendingCardProps {
  requestId: string;
  sender: string;
  encryptedPreviewMessage: string;
  isRevealed: boolean;
  actionId: string | null;
  mlScore: MLBehaviorScore | null | undefined;
  mlLoading: boolean;
  mlError: string | null | undefined;
  onAccept: () => void;
  onReject: () => void;
  onCheck: () => void;
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function SidebarPendingCard({
  requestId,
  sender,
  encryptedPreviewMessage,
  isRevealed,
  actionId,
  mlScore,
  mlLoading,
  mlError,
  onAccept,
  onReject,
  onCheck,
}: SidebarPendingCardProps) {
  const preview = decodePreview(encryptedPreviewMessage);
  const isWorking = actionId === requestId;

  return (
    <div className="rounded-xl border border-[#DFD0B8]/10 bg-[#393E46] p-3">
      <div className="mb-2 flex items-start gap-3 rounded-lg border border-[#948979]/20 bg-[#222831] p-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-[#DFD0B8]/10 bg-[#393E46] text-base">
          ❓
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[#948979]">
            Preview
          </p>
          <p className="mt-0.5 break-words text-sm font-medium text-[#DFD0B8]">
            {preview || "No preview included with this knock"}
          </p>
        </div>
      </div>

      <p className="mb-2 truncate text-xs text-[#948979]">
        {isRevealed
          ? `Sender: ${shortenAddress(sender)}`
          : "Sender address is hidden to protect privacy."}
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onAccept}
          disabled={isWorking}
          className="flex-1 rounded-lg bg-[#DFD0B8] px-3 py-1.5 text-xs font-bold text-[#222831] transition-colors hover:bg-[#DFD0B8]/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isWorking ? "..." : "Accept"}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={isWorking}
          className="flex-1 rounded-lg bg-[#948979] px-3 py-1.5 text-xs font-bold text-[#222831] transition-colors hover:bg-[#948979]/80 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isWorking ? "..." : "Reject"}
        </button>
      </div>
      <PendingMLCheck
        score={mlScore}
        loading={mlLoading}
        error={mlError}
        actionDisabled={isWorking}
        onCheck={onCheck}
      />
    </div>
  );
}
