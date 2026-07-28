"use client";

import React from "react";

/** A detected, supported wallet the user can pick in the modal. */
export interface WalletChoice {
  /** "metamask" or "phantom" — also used as the selection key. */
  id: string;
  /** Human-readable name shown on the button. */
  name: string;
}

interface WalletSelectionModalProps {
  /** When false, the modal renders nothing. */
  open: boolean;
  /** The supported wallets installed in the browser. */
  wallets: WalletChoice[];
  /** True while the chosen wallet is connecting (disables the buttons). */
  isConnecting?: boolean;
  /** Called with the id of the wallet the user clicked. */
  onSelect: (id: string) => void;
  /** Called when the user dismisses the modal (backdrop / Cancel). */
  onCancel: () => void;
}

/** Emoji glyph used as a lightweight icon per wallet. */
function walletGlyph(id: string): string {
  return id === "phantom" ? "👻" : "🦊";
}

/**
 * Small modal that lets the user choose between MetaMask and Phantom when both
 * are installed. Uses the app's color palette (bg-[#222831] / bg-[#393E46] /
 * text-[#DFD0B8]) and mirrors the styling of the existing edit-nickname modal.
 */
export default function WalletSelectionModal({
  open,
  wallets,
  isConnecting = false,
  onSelect,
  onCancel,
}: WalletSelectionModalProps) {
  if (!open || wallets.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex animate-message-in items-center justify-center bg-black/50 px-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isConnecting) onCancel();
      }}
    >
      <div className="w-full max-w-sm rounded-3xl border border-[#DFD0B8]/15 bg-[#393E46] p-6 shadow-2xl shadow-black/40">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#222831] text-xl ring-1 ring-[#DFD0B8]/10">
            👛
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-bold text-[#DFD0B8]">Choose a wallet</h3>
            <p className="truncate text-xs text-[#948979]">
              Multiple wallets detected. Select one to continue.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {wallets.map((wallet) => (
            <button
              key={wallet.id}
              type="button"
              onClick={() => onSelect(wallet.id)}
              disabled={isConnecting}
              className="flex items-center gap-3 rounded-2xl border border-[#DFD0B8]/15 bg-[#222831] px-4 py-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-[#DFD0B8]/40 hover:shadow-lg hover:shadow-black/30 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
            >
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-[#DFD0B8]/10 bg-[#393E46] text-xl">
                {walletGlyph(wallet.id)}
              </span>
              <span className="flex-1">
                <span className="block text-sm font-bold text-[#DFD0B8]">
                  {wallet.name}
                </span>
                <span className="block text-xs text-[#948979]">
                  Connect with {wallet.name}
                </span>
              </span>
              <span className="text-[#948979]">→</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onCancel}
          disabled={isConnecting}
          className="mt-5 w-full rounded-2xl border border-[#948979]/40 bg-[#222831] px-4 py-3 text-sm font-semibold text-[#DFD0B8] transition-colors duration-200 hover:border-[#948979] hover:bg-[#31363F] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}