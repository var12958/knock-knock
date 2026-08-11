"use client";

import {
  formatMLBadge,
  type MLBehaviorScore,
} from "@/lib/runMLBehaviorCheck";

interface PendingMLCheckProps {
  score: MLBehaviorScore | null | undefined;
  loading: boolean;
  error: string | null | undefined;
  actionDisabled?: boolean;
  onCheck: () => void;
}

export default function PendingMLCheck({
  score,
  loading,
  error,
  actionDisabled,
  onCheck,
}: PendingMLCheckProps) {
  return (
    <div className="flex flex-col gap-2">
      {score && (
        <div
          className="group relative mb-2 flex items-center gap-2 rounded-lg border border-[#DFD0B8]/20 bg-[#222831] px-3 py-1.5 outline-none focus-within:border-[#DFD0B8]/50"
          tabIndex={0}
          aria-label="ML behavior score. Focus or hover for details."
        >
          <span className="text-xs">🛡️</span>
          <span className="text-xs font-bold text-[#DFD0B8]">
            {formatMLBadge(score)}
          </span>
          <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-56 -translate-x-1/2 rounded-xl border border-[#DFD0B8]/10 bg-[#222831] p-3 text-xs text-[#DFD0B8] opacity-0 shadow-xl shadow-black/30 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <p className="mb-2 font-bold text-[#DFD0B8]">
              Model: {score.modelVersion}
            </p>
            <ul className="list-disc space-y-1 pl-4 text-[#948979]">
              {score.explanation.map((factor, i) => (
                <li key={i}>{factor}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {error && !score && (
        <p className="mb-2 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={onCheck}
        disabled={actionDisabled || loading}
        className="rounded-lg border border-[#DFD0B8]/20 bg-[#222831] px-3 py-1.5 text-xs font-bold text-[#DFD0B8] transition-colors hover:border-[#DFD0B8]/40 hover:bg-[#31363F] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-1">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#DFD0B8]/30 border-t-[#DFD0B8]" />
            ...
          </span>
        ) : (
          "CHECK"
        )}
      </button>
    </div>
  );
}
