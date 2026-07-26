/**
 * Minimal KnockKnockMailbox ABI for the Cloud Function.
 */

export const MAILBOX_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "requestId", type: "uint256" },
      { indexed: true, internalType: "address", name: "sender", type: "address" },
      { indexed: true, internalType: "address", name: "receiver", type: "address" },
    ],
    name: "RequestSent",
    type: "event",
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "requests",
    outputs: [
      { internalType: "address", name: "sender", type: "address" },
      { internalType: "address", name: "receiver", type: "address" },
      { internalType: "string", name: "encryptedPreviewMessage", type: "string" },
      { internalType: "bool", name: "isVerifiedHuman", type: "bool" },
      { internalType: "bool", name: "isOldEnoughWallet", type: "bool" },
      { internalType: "bool", name: "accepted", type: "bool" },
      { internalType: "bool", name: "isRevealed", type: "bool" },
      { internalType: "uint256", name: "expirationTime", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
];
