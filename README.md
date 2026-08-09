# KnockKnock 👋

**Bounty 2 — Confidential Compute Apps**

KnockKnock is a privacy-first messaging platform that uses Flare Confidential Compute (FCC) to verify user identity without exposing sensitive data. By leveraging Trusted Execution Environments (TEEs), KnockKnock allows users to prove they are "Verified Humans" with a credible wallet history before sending an anonymous chat request.

---

## 📋 Submission Details

* **Project Name:** KnockKnock
* **Selected Bounty:** Bounty 2 — Confidential Compute Apps
* **Target User:** Web3 developers, DAO contributors, and investors who want to receive secure, spam-free DMs while verifying the sender's credibility anonymously.
* **Demo Link:** [INSERT VERCEL LIVE LINK HERE]
* **Demo Video:** [INSERT LOOM VIDEO LINK HERE]
* **GitHub Repo:** [INSERT GITHUB REPO LINK HERE]

---

## 🛡️ How the Project Uses Flare

KnockKnock utilizes Flare Confidential Compute (FCC) and Flare Smart Contracts to create a trustless, privacy-preserving verification flow:

1. **Private Verification (FCC):** 
   - When a user attempts to send a "Knock" (chat request), the app triggers a verification job inside the Flare TEE.
   - The TEE securely queries the **Gitcoin Passport API** to check the sender's humanity score.
   - The TEE queries the **Flare RPC** to verify the sender's wallet has been active for the required period.
   - **Crucially:** The API keys, the wallet's transaction history, and the exact Gitcoin score are kept completely private inside the enclave and never exposed to the public blockchain.

2. **On-Chain Proof Verification:**
   - The TEE generates a cryptographically signed proof of the verification results.
   - The frontend submits this proof to the `KnockKnockMailbox` smart contract on Flare Coston2.
   - The smart contract verifies the TEE signature on-chain. If valid, the anonymous chat request is stored.

3. **The Anonymous Handshake:**
   - The receiver sees the pending Knock with "Verified Human" and "Old Wallet" badges, but the sender's wallet address remains hidden.
   - Only if the receiver clicks "Accept" is the sender's identity revealed, and an end-to-end encrypted chat session begins.

---

## 🏗️ What Was Newly Built

Everything in this repository was built from scratch during the hackathon period:

* **Smart Contracts:** `KnockKnockMailbox.sol` (manages anonymous requests, proof verification, and tipping) and `KnockKnockFCCVerifier.sol` (posts verification jobs to the Flare TEE).
* **FCC TypeScript Extension:** A custom TEE handler that securely executes Gitcoin API calls and Flare RPC queries, signing the results.
* **Web2.5 Authentication:** A Firebase Authentication integration allowing Google/Email login, seamlessly bridging Web2 UX with Web3 privacy.
* **End-to-End Encrypted Chat:** Real-time messaging using Firebase Realtime Database with client-side AES encryption.
* **Premium UI/UX:** A cinematic, Apple-style verification loading screen, a WhatsApp-style sidebar, custom nicknames, self-destructing messages, and on-chain FLR tipping.

---

## 📜 Smart Contract Addresses (Flare Coston2)

* **KnockKnockMailbox:** [INSERT DEPLOYED MAILBOX ADDRESS]
* **KnockKnockFCCVerifier:** [INSERT DEPLOYED VERIFIER ADDRESS]

---

## 🚀 Roadmap & Next Steps

1. **Group Chat Encryption:** Implementing secure multi-party encryption for the Group Knock feature.
2. **Mobile App:** Developing a native mobile app with push notifications for incoming Knocks.
3. **Mainnet Deployment:** Upgrading the TEE infrastructure for production and deploying to Flare Mainnet.
4. **Soulbound Identity NFTs:** Minting non-transferable NFTs to users who pass verification.

---

## 💻 How to Run Locally

### Prerequisites
- Node.js v20+
- MetaMask or Phantom wallet installed
- Firebase CLI installed (`npm install -g firebase-tools`)

### 1. Clone and Install
```bash
git clone [INSERT GITHUB REPO LINK]
cd knockknock
npm install
cd frontend && npm install
cd ../fcc/typescript && npm install
cd ../firebase/functions && npm install
