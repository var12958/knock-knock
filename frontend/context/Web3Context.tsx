"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { ethers } from "ethers";
import { COSTON2_CHAIN_ID, COSTON2_CONFIG } from "@/lib/chain";

interface Web3State {
  address: string | null;
  chainId: number | null;
  signer: ethers.JsonRpcSigner | null;
  provider: ethers.BrowserProvider | null;
  isConnecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const Web3Context = createContext<Web3State | undefined>(undefined);

export function Web3Provider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Prompt MetaMask to switch to the Flare Coston2 network.
   * If the network is not configured in the wallet, add it first.
   */
  async function ensureCoston2Network(ethProvider: any): Promise<void> {
    try {
      await ethProvider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: COSTON2_CONFIG.chainId }],
      });
    } catch (switchError: any) {
      // 4902 means the chain has not been added to MetaMask yet.
      if (switchError.code === 4902) {
        await ethProvider.request({
          method: "wallet_addEthereumChain",
          params: [COSTON2_CONFIG],
        });
      } else {
        throw switchError;
      }
    }
  }

  async function connect() {
    setError(null);
    setIsConnecting(true);

    try {
      if (typeof window === "undefined" || !(window as any).ethereum) {
        throw new Error(
          "MetaMask not detected. Please install MetaMask and refresh the page."
        );
      }

      const ethProvider = (window as any).ethereum;
      const browserProvider = new ethers.BrowserProvider(ethProvider);

      // Request account access.
      await ethProvider.request({ method: "eth_requestAccounts" });

      // Make sure we are on Coston2.
      await ensureCoston2Network(ethProvider);

      const newSigner = await browserProvider.getSigner();
      const userAddress = await newSigner.getAddress();
      const network = await browserProvider.getNetwork();

      setProvider(browserProvider);
      setSigner(newSigner);
      setAddress(userAddress);
      setChainId(Number(network.chainId));
    } catch (err: any) {
      console.error("Wallet connection failed:", err);
      setError(err.message ?? "Failed to connect wallet");
    } finally {
      setIsConnecting(false);
    }
  }

  function disconnect() {
    setProvider(null);
    setSigner(null);
    setAddress(null);
    setChainId(null);
    setError(null);
  }

  // Listen for account and chain changes while connected.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const ethProvider = (window as any).ethereum;
    if (!ethProvider) return;

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        disconnect();
      } else if (accounts[0] !== address) {
        connect();
      }
    };

    const handleChainChanged = () => {
      window.location.reload();
    };

    ethProvider.on("accountsChanged", handleAccountsChanged);
    ethProvider.on("chainChanged", handleChainChanged);

    return () => {
      ethProvider.removeListener("accountsChanged", handleAccountsChanged);
      ethProvider.removeListener("chainChanged", handleChainChanged);
    };
  }, [address]);

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
        disconnect,
      }}
    >
      {children}
    </Web3Context.Provider>
  );
}

export function useWeb3() {
  const context = useContext(Web3Context);
  if (context === undefined) {
    throw new Error("useWeb3 must be used within a Web3Provider");
  }
  return context;
}
