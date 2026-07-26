"use client";

import { useWeb3 } from "@/context/Web3Context";
import { COSTON2_CHAIN_ID } from "@/lib/chain";

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function Web3Header() {
  const { address, chainId, isConnecting, error, connect } = useWeb3();
  const isCorrectNetwork = chainId === COSTON2_CHAIN_ID;

  return (
    <header className="w-full border-b border-slate-200 bg-white px-6 py-4 shadow-sm">
      <div className="mx-auto flex max-w-5xl items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 text-xl">
            🚪
          </div>
          <h1 className="text-xl font-bold text-slate-800">KnockKnock</h1>
        </div>

        <div className="flex items-center gap-4">
          {address ? (
            <div className="flex items-center gap-3 rounded-lg bg-slate-50 px-4 py-2">
              <div className="flex flex-col items-end">
                <span className="text-sm font-medium text-slate-700">
                  {shortenAddress(address)}
                </span>
                <span
                  className={`text-xs font-semibold ${
                    isCorrectNetwork ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {isCorrectNetwork
                    ? "Flare Coston2"
                    : `Wrong network (${chainId ?? "unknown"})`}
                </span>
              </div>
            </div>
          ) : (
            <button
              onClick={connect}
              disabled={isConnecting}
              className="rounded-lg bg-brand-600 px-5 py-2.5 font-medium text-white shadow transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isConnecting ? "Connecting..." : "Connect MetaMask"}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-auto mt-3 max-w-5xl rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
    </header>
  );
}
