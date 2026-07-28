"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { COSTON2_CHAIN_ID, COSTON2_CONFIG } from "@/lib/chain";
import WalletSelectionModal, { WalletChoice } from "@/components/WalletSelectionModal";

/**
 * Minimal EIP-1193 provider shape we rely on. Real injected providers
 * (MetaMask, Phantom, Coinbase, etc.) conform to this; we only type the
 * surface we use plus the wallet-detection flags and the multi-injection
 * `providers` array that browsers expose when several wallets are installed.
 */
interface Eip1193Provider {
  isMetaMask?: boolean;
  isPhantom?: boolean;
  isCoinbaseWallet?: boolean;
  isTrust?: boolean;
  isRabby?: boolean;
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
  providers?: Eip1193Provider[];
}

/** Window shape with the injection points we care about. */
interface WindowWithWallets extends Window {
  ethereum?: Eip1193Provider;
  phantom?: { ethereum?: Eip1193Provider };
}

/**
 * The only wallets KnockKnock supports. Any injected provider that does not
 * set one of these flags is ignored entirely — Coinbase, Trust, Rabby, etc.
 * are never detected or connected.
 */
const ALLOWED_WALLET_FLAGS: Record<string, keyof Eip1193Provider> = {
  metamask: "isMetaMask",
  phantom: "isPhantom",
};

/** True if the provider identifies as one of the two supported wallets. */
function isAllowedWallet(p: Eip1193Provider): boolean {
  return p.isMetaMask === true || p.isPhantom === true;
}

/** Human-readable name for a supported wallet id. */
function walletName(id: "metamask" | "phantom"): string {
  return id === "phantom" ? "Phantom" : "MetaMask";
}

/** A detected, supported wallet plus its concrete EIP-1193 provider object. */
interface DetectedWallet {
  id: "metamask" | "phantom";
  provider: Eip1193Provider;
}

interface Web3State {
  address: string | null;
  chainId: number | null;
  signer: ethers.JsonRpcSigner | null;
  provider: ethers.BrowserProvider | null;
  isConnecting: boolean;
  error: string | null;
  /**
   * Default connect. If both MetaMask and Phantom are installed, opens the
   * wallet-selection modal and waits for the user to pick one. If only one is
   * installed, connects to it directly. Safe to pass to onClick.
   */
  connect: () => Promise<void>;
  /**
   * Connect to a specific injected wallet by name (e.g. "phantom", "metamask").
   * Bypasses the selection modal and connects directly when that wallet is
   * installed; otherwise falls back to detection (and the modal if both are
   * present).
   */
  connectWallet: (preferredWallet?: string) => Promise<void>;
  disconnect: () => void;
}

const Web3Context = createContext<Web3State | undefined>(undefined);

/**
 * Build a compact, log-safe descriptor of a provider so we can see which
 * wallet an object actually is without dumping a huge/circular structure.
 */
function describeProvider(label: string, p: unknown): Record<string, unknown> {
  const provider = p as Eip1193Provider | undefined;
  return {
    label,
    isMetaMask: provider?.isMetaMask === true,
    isPhantom: provider?.isPhantom === true,
    isCoinbaseWallet: provider?.isCoinbaseWallet === true,
    isTrust: provider?.isTrust === true,
    isRabby: provider?.isRabby === true,
    hasRequest: typeof provider?.request === "function",
    hasOn: typeof provider?.on === "function",
    hasProvidersArray: Array.isArray(provider?.providers)
      ? provider!.providers!.length
      : false,
  };
}

/**
 * Detect every supported wallet injected in the browser.
 *
 * When multiple wallets are installed, the browser concatenates them behind
 * `window.ethereum.providers`. We expand that array (falling back to the
 * single `window.ethereum`), and also pull in Phantom's dedicated injection
 * point `window.phantom.ethereum` — which is NOT always present in the
 * `providers` array when MetaMask injected first and Phantom loaded later.
 *
 * Only MetaMask and Phantom are ever returned; other wallets (Coinbase, Trust,
 * Rabby, …) are filtered out. Results are de-duplicated by wallet id so the
 * same provider object discovered through two injection points is not listed
 * twice. MetaMask is always listed before Phantom for a stable modal order.
 *
 * Returns `[]` on the server or when no supported wallet is injected.
 */
function detectWallets(): DetectedWallet[] {
  if (typeof window === "undefined") return [];
  const w = window as WindowWithWallets;
  const root = w.ethereum;

  console.groupCollapsed("[Web3Context] detectWallets() — detection");
  console.log("window.ethereum:", describeProvider("window.ethereum", root), root);
  console.log(
    "window.phantom:",
    w.phantom ? { hasEthereum: !!w.phantom.ethereum } : null,
  );
  console.log(
    "window.phantom.ethereum:",
    describeProvider("window.phantom.ethereum", w.phantom?.ethereum),
    w.phantom?.ethereum,
  );
  console.log(
    "window.ethereum.providers (raw):",
    Array.isArray(root?.providers)
      ? root.providers.map((p, i) => describeProvider(`providers[${i}]`, p))
      : "(no providers array)",
  );

  // Gather every injected provider object, including Phantom's dedicated
  // injection point (not always present in the providers array).
  const raw: Eip1193Provider[] = [];
  if (root) {
    if (Array.isArray(root.providers) && root.providers.length > 0) {
      raw.push(...root.providers);
    } else {
      raw.push(root);
    }
  }
  const phantomEth = w.phantom?.ethereum;
  if (phantomEth && !raw.includes(phantomEth)) {
    raw.push(phantomEth);
  }

  // RESTRICT to MetaMask and Phantom ONLY. Any other wallet (Coinbase, Trust,
  // Rabby, etc.) is filtered out and will never be detected or connected.
  const candidates = raw.filter(isAllowedWallet);
  console.log(
    "candidates (MetaMask/Phantom only):",
    candidates.map((p, i) => describeProvider(`candidate[${i}]`, p)),
  );

  // Map to detected wallets, de-duplicating by id (a provider object may be
  // reachable through both window.ethereum.providers and window.phantom).
  const byId = new Map<"metamask" | "phantom", Eip1193Provider>();
  for (const p of candidates) {
    const id: "metamask" | "phantom" =
      p.isPhantom === true ? "phantom" : "metamask";
    if (!byId.has(id)) byId.set(id, p);
  }

  // Stable order: MetaMask first, Phantom second.
  const ordered: DetectedWallet[] = [];
  for (const id of ["metamask", "phantom"] as const) {
    const provider = byId.get(id);
    if (provider) ordered.push({ id, provider });
  }

  console.log(
    "detected:",
    ordered.map((o) => ({ id: o.id, ...describeProvider(o.id, o.provider) })),
  );
  console.groupEnd();

  return ordered;
}

export function Web3Provider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The raw EIP-1193 provider the user actually connected with. Kept in state
  // so the account/chain listener effect can (re)subscribe to THAT provider
  // (e.g. Phantom), not a different one such as the MetaMask-injected window.ethereum.
  const [walletProvider, setWalletProvider] = useState<Eip1193Provider | null>(null);

  // Wallet-selection modal state. `pendingChoices` is non-null while the modal
  // is open; the corresponding provider objects are held in a ref keyed by id
  // so the modal itself only ever sees the lightweight { id, name } choices.
  const [pendingChoices, setPendingChoices] = useState<WalletChoice[] | null>(null);
  const pendingProvidersRef = useRef<Record<string, Eip1193Provider>>({});

  function clearConnectionState(): void {
    setWalletProvider(null);
    setProvider(null);
    setSigner(null);
    setAddress(null);
    setChainId(null);
    setError(null);
  }

  /**
   * Prompt the connected wallet to switch to Flare Coston2.
   * If the network is not configured in the wallet, add it first.
   */
  const ensureCoston2Network = useCallback(
    async (ethProvider: Eip1193Provider): Promise<void> => {
      try {
        await ethProvider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: COSTON2_CONFIG.chainId }],
        });
      } catch (switchError: unknown) {
        // Code 4902 means the chain has not been added to the wallet yet.
        const code = (switchError as { code?: number })?.code;
        if (code === 4902) {
          await ethProvider.request({
            method: "wallet_addEthereumChain",
            params: [COSTON2_CONFIG],
          });
        } else {
          throw switchError;
        }
      }
    },
    []
  );

  /**
   * Actually connect to a concrete EIP-1193 provider object. This is the
   * shared end-state of every connect path: a direct single-wallet connect,
   * an explicit preference, and a user choice from the selection modal all
   * funnel through here.
   */
  const connectWithProvider = useCallback(
    async (selected: Eip1193Provider): Promise<void> => {
      if (!selected || typeof selected.request !== "function") {
        throw new Error(
          "No wallet detected. Please install a wallet such as MetaMask or Phantom and refresh the page."
        );
      }

      console.groupCollapsed("[Web3Context] connectWithProvider() — start");
      console.log("selectedProvider:", describeProvider("selected", selected), selected);

      try {
        // Request account access from the chosen wallet.
        console.log("→ eth_requestAccounts on selectedProvider");
        const accounts = (await selected.request({ method: "eth_requestAccounts" })) as string[];
        console.log("eth_requestAccounts result:", accounts);
        if (accounts.length === 0) {
          console.log("⚠ eth_requestAccounts returned no accounts");
        }

        // Make sure we are on Coston2.
        console.log("→ wallet_switchEthereumChain / ensureCoston2Network");
        await ensureCoston2Network(selected);

        const browserProvider = new ethers.BrowserProvider(selected);
        const newSigner = await browserProvider.getSigner();
        const userAddress = await newSigner.getAddress();
        const network = await browserProvider.getNetwork();

        console.log("connected address:", userAddress);
        console.log("network chainId:", Number(network.chainId));

        setWalletProvider(selected);
        setProvider(browserProvider);
        setSigner(newSigner);
        setAddress(userAddress);
        setChainId(Number(network.chainId));
        setError(null);
        console.log("connectWithProvider() — success");
        console.groupEnd();
      } catch (err: unknown) {
        console.error("[Web3Context] Wallet connection failed:", err);
        console.log("connectWithProvider() — failed");
        console.groupEnd();
        throw err;
      }
    },
    [ensureCoston2Network]
  );

  /**
   * Connect to a wallet. Flow:
   *  - If a `preferredWallet` is given AND installed → connect to it directly.
   *  - If exactly ONE supported wallet is installed → connect to it directly.
   *  - If BOTH MetaMask and Phantom are installed → open the selection modal
   *    and wait for the user to choose (no connection happens yet).
   *  - If NONE is installed → set an error.
   */
  const connectWallet = useCallback(
    async (preferredWallet?: string): Promise<void> => {
      setError(null);
      setIsConnecting(true);

      console.groupCollapsed("[Web3Context] connectWallet() — start");
      console.log("preferredWallet:", preferredWallet ?? "(none)");

      try {
        const detected = detectWallets();

        if (detected.length === 0) {
          console.log("no supported wallet detected");
          console.groupEnd();
          throw new Error(
            "No wallet detected. Please install a wallet such as MetaMask or Phantom and refresh the page."
          );
        }

        // 1. Honor an explicit preference — but only for a supported, installed wallet.
        if (preferredWallet) {
          const key = preferredWallet.toLowerCase();
          const flag = ALLOWED_WALLET_FLAGS[key];
          if (flag) {
            const match = detected.find((d) => d.id === (key as "metamask" | "phantom"));
            if (match) {
              console.log("connecting to explicit preference:", match.id);
              console.groupEnd();
              await connectWithProvider(match.provider);
              return;
            }
            console.log("explicit preference '%s' not installed", preferredWallet);
          } else {
            console.log("explicit preference '%s' is not a supported wallet", preferredWallet);
          }
        }

        // 2. Exactly one supported wallet → connect directly (no modal).
        if (detected.length === 1) {
          console.log("single wallet detected, connecting directly:", detected[0].id);
          console.groupEnd();
          await connectWithProvider(detected[0].provider);
          return;
        }

        // 3. Both installed → open the selection modal. Do NOT connect yet;
        //    the user's choice drives connectWithProvider via handleWalletSelect.
        console.log("both wallets detected, opening selection modal");
        console.groupEnd();
        pendingProvidersRef.current = Object.fromEntries(
          detected.map((d) => [d.id, d.provider]),
        );
        setPendingChoices(detected.map((d) => ({ id: d.id, name: walletName(d.id) })));
      } catch (err: unknown) {
        console.error("[Web3Context] Wallet connection failed:", err);
        console.log("connectWallet() — failed");
        console.groupEnd();
        const message =
          err instanceof Error ? err.message : "Failed to connect wallet";
        setError(message);
      } finally {
        // isConnecting is only relevant while we are actively connecting to a
        // provider. When we stop to show the modal, the user is choosing, not
        // connecting — so drop the spinner here.
        setIsConnecting(false);
      }
    },
    [connectWithProvider]
  );

  async function connect(): Promise<void> {
    // No preference: detect and either connect directly (one wallet) or open
    // the selection modal (both wallets). Keeps `onClick={connect}` callers
    // type-safe (zero-arg).
    await connectWallet();
  }

  /** User picked a wallet in the selection modal → connect with its provider. */
  const handleWalletSelect = useCallback(
    async (id: string): Promise<void> => {
      const selectedProvider = pendingProvidersRef.current[id];
      setPendingChoices(null);
      if (!selectedProvider) {
        setError("Selected wallet is no longer available. Please try again.");
        return;
      }
      setError(null);
      setIsConnecting(true);
      try {
        await connectWithProvider(selectedProvider);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to connect wallet";
        setError(message);
      } finally {
        setIsConnecting(false);
        pendingProvidersRef.current = {};
      }
    },
    [connectWithProvider]
  );

  /** User dismissed the selection modal → cancel without connecting. */
  const handleWalletCancel = useCallback((): void => {
    setPendingChoices(null);
    pendingProvidersRef.current = {};
    setIsConnecting(false);
    setError(null);
  }, []);

  function disconnect(): void {
    // Best-effort: ask the wallet to drop account permissions so its UI shows
    // disconnected. Ignore failures — state is cleared regardless.
    if (walletProvider && typeof walletProvider.request === "function") {
      walletProvider
        .request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] })
        .catch((err: unknown) => {
          // Not all wallets support wallet_revokePermissions; that's fine.
          console.debug("[Web3Context] wallet_revokePermissions failed:", err);
        });
    }
    clearConnectionState();
  }

  // Stable ref used to ignore stale async updates when accounts switch rapidly.
  const switchNonceRef = useRef(0);

  // Listen for account and chain changes on the SELECTED wallet provider.
  // This is deliberately attached to `walletProvider` (e.g. Phantom's), not to
  // the aggregated window.ethereum — otherwise Phantom account changes would
  // be missed and MetaMask's would fire instead.
  useEffect(() => {
    if (!walletProvider || typeof walletProvider.on !== "function") {
      return;
    }
    const provider = walletProvider;

    const handleAccountsChanged = async (accounts: unknown): Promise<void> => {
      const accountList = (accounts as string[] | undefined) ?? [];
      if (accountList.length === 0) {
        clearConnectionState();
        return;
      }

      // Increment nonce so any in-flight update from a previous switch can be
      // discarded if a newer event arrives.
      const currentSwitch = ++switchNonceRef.current;

      try {
        const rawAccount = accountList[0];
        const newAddress = ethers.getAddress(rawAccount);

        // Refresh the signer/provider for the new account without going
        // through the full connect() flow (which prompts for network switch).
        const browserProvider = new ethers.BrowserProvider(provider);
        const newSigner = await browserProvider.getSigner();
        const signerAddress = await newSigner.getAddress();

        // Drop this update if it was superseded by a newer accountsChanged
        // event, or if the wallet returned a different account than the one
        // that fired the event.
        if (currentSwitch !== switchNonceRef.current) return;
        if (signerAddress !== newAddress) {
          console.warn(
            "[Web3Context] Signer address mismatch after switch:",
            signerAddress,
            "!==",
            newAddress
          );
          return;
        }

        const network = await browserProvider.getNetwork();
        if (currentSwitch !== switchNonceRef.current) return;

        setProvider(browserProvider);
        setSigner(newSigner);
        setAddress(newAddress);
        setChainId(Number(network.chainId));
        setError(null);
      } catch (err: unknown) {
        // Only surface errors from the most recent switch event.
        if (currentSwitch !== switchNonceRef.current) return;
        console.error("[Web3Context] Account switch failed:", err);
        const message =
          err instanceof Error ? err.message : "Failed to switch account";
        setError(message);
      }
    };

    const handleChainChanged = (): void => {
      // A reload is the simplest correct response to a chain change: ethers
      // caches providers per-chain, and stale state can produce wrong gas
      // estimates.
      window.location.reload();
    };

    provider.on("accountsChanged", handleAccountsChanged);
    provider.on("chainChanged", handleChainChanged);

    return () => {
      if (typeof provider.removeListener === "function") {
        provider.removeListener("accountsChanged", handleAccountsChanged);
        provider.removeListener("chainChanged", handleChainChanged);
      }
    };
  }, [walletProvider]);

  return (
    <Web3Context.Provider
      value={{
        address,
        chainId,
        signer,
        provider,
        isConnecting,
        error,
        connect,
        connectWallet,
        disconnect,
      }}
    >
      {children}
      <WalletSelectionModal
        open={pendingChoices !== null}
        wallets={pendingChoices ?? []}
        isConnecting={isConnecting}
        onSelect={(id) => {
          void handleWalletSelect(id);
        }}
        onCancel={handleWalletCancel}
      />
    </Web3Context.Provider>
  );
}

export function useWeb3(): Web3State {
  const context = useContext(Web3Context);
  if (context === undefined) {
    throw new Error("useWeb3 must be used within a Web3Provider");
  }
  return context;
}