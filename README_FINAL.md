# KnockKnock 

**Bounty 2 — Confidential Compute Apps**

---

## Short Description

KnockKnock is a privacy-first messaging platform that uses **Flare Confidential Compute (FCC / TEE)** to verify user identity without exposing sensitive data, enabling **anonymous Web3 handshakes**. Before a sender can slide into a receiver’s DMs, a Trusted Execution Environment privately attests their wallet age and humanity via the Gitcoin Passport API and Flare RPC. The receiver sees only trust badges — the sender’s wallet address remains hidden until the knock is accepted.

---

## Target User

- **Web3 developers**, **DAO contributors**, and **investors** who receive a high volume of inbound messages.
- Users who want **spam-free, credible DMs** without doxxing their wallet or verification data to the public blockchain.
- Communities that value **provable reputation** combined with **selective anonymity**.

---

## Demo Link & Video

- **Live Demo:** [INSERT VERCEL LIVE LINK]
- **Demo Video:** [INSERT LOOM VIDEO LINK]
- **GitHub Repo:**  https://github.com/var12958/knock-knock

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14, React 18, TypeScript, Tailwind CSS, Framer Motion |
| Smart Contracts | Solidity 0.8.20, OpenZeppelin v5, Hardhat |
| Confidential Compute | Flare Confidential Compute (FCC / TEE), TypeScript extension |
| Identity & Auth | Firebase Authentication (Google + Email/Password), Firebase Realtime Database |
| On-Chain ML | Python scikit-learn (Random Forest + Isolation Forest) trained on Ethereum wallet features |
| Web3 Client | Ethers.js v6 |
| Backend Functions | Firebase Cloud Functions (Node.js / TypeScript) |
| Web2 Attestation | Flare Data Connector (FDC) for Twitter verification |

---

## Features

### 1. ML-Powered On-Chain Sybil Detection
A Python-trained **Random Forest / Isolation Forest** model runs inside the TEE. The extension scans a wallet’s recent on-chain behavior, extracts the top-10 most informative features (gas patterns, timestamp variance, transaction velocity, value distributions, counterparty diversity), and returns a **signed human/bot probability** with explainable top factors. The model artifact is exported from `ml/train_model.py` as `model_weights.json` and consumed natively by the TypeScript TEE handler.

### 2. Real Gitcoin Passport API Verification
The TEE submits the sender wallet to the **Gitcoin Passport scorer API** and evaluates the returned humanity score. API keys and raw scores never leave the enclave — only the boolean attestation and a cryptographic signature are published.

### 3. Smart Contract Anonymous Handshakes
The `KnockKnockMailbox` contract stores chat requests with encrypted previews. The sender’s identity is hidden on the pending request card and only revealed on-chain when the receiver clicks **Accept**. Until acceptance, the receiver sees only the TEE-backed “Verified Human” and “Old Wallet” badges.

### 4. Web2.5 Firebase Authentication
Users log in with **Google or Email/Password** via Firebase Auth, then cryptographically link a Flare wallet through a signature challenge. Firebase Cloud Functions enforce one-wallet-per-profile, atomic username reservation, and on-chain transaction verification before writing verification badges.

### 5. End-to-End Encrypted Real-Time Chat
Messages are encrypted client-side with AES before being written to **Firebase Realtime Database**. The shared key is deterministically derived from the two participant addresses for the hackathon demo; the architecture supports upgrading to ECDH key exchange in production.

### 6. In-Chat $FLR Tipping
Any chat participant can send a native **$FLR tip** directly to the other party. The transfer is a standard native-token transaction; a system message is recorded in the chat thread once the on-chain transfer confirms.

### 7. Self-Destructing Messages (Burn After Reading)
A burn-mode toggle tags outgoing messages as **burn-after-reading**. When the recipient’s client reads the message, a 30-second self-destruct countdown begins and the message is automatically deleted from Firebase and local state.

### 8. Group Knocks (Multi-Party Verification)
Senders can knock up to **three receivers at once**. The frontend requests a separate TEE proof for each receiver, submits each proof to the mailbox, and persists a group mapping so the sidebar renders the multi-party conversation as a single **Group Chat** card.

### 9. Premium Cinematic UI
A dark, glassmorphic interface with ambient gradients, smooth motion transitions, Apple-style verification loaders, WhatsApp-style sidebar navigation, custom nicknames, and badge-driven trust signaling — built to feel like a $10,000 product experience.

---

## How Flare is Used

KnockKnock is built natively on **Flare Confidential Compute (FCC)** and Flare Smart Contracts. The platform could not deliver anonymous, trust-preserving messaging without the TEE.

### Private Verification Inside the TEE
When a sender creates a knock, the app calls `KnockKnockFCCVerifier.requestVerification(...)` on Flare Coston2. This posts a `KNOCKKNOCK/VERIFY_SENDER` instruction to the Flare TEE network with the sender address as a **private input**.

Inside the enclave, the TypeScript extension performs two checks:

1. **Proof-of-History** — queries the **Flare RPC** (`coston2-api.flare.network`) to find the wallet’s first outgoing transaction via binary search on nonce, then confirms the wallet has been active for at least the configured threshold.
2. **Proof-of-Humanity** — submits the wallet to the **Gitcoin Passport scorer API** and validates the returned score against the threshold.

The wallet address, RPC responses, and Passport score remain inside the TEE. The public output contains only:

- `isVerifiedHuman` (bool)
- `isOldEnoughWallet` (bool)
- A request-binding `bytes32` hash
- An ECDSA signature from the TEE signer

### On-Chain Proof Verification
The TEE signs `keccak256(chainId || mailbox || sender || isVerifiedHuman || isOldEnoughWallet || requestHash)`. The frontend polls the FCC proxy for the signed result and submits it to `KnockKnockMailbox.sendRequestWithProof(...)`. The mailbox contract verifies the signature against the configured `teeSigner`, checks the deadline and request-hash binding, and only then creates the chat request.

### Flare FDC for Twitter Verification
For Web2 reputation, the TEE extension and Firebase Cloud Functions both integrate the **Flare Data Connector (FDC)**. They construct a `Web2Json` attestation against the Twitter v2 API, poll the FDC verifier for a Merkle proof, and write a `twitterVerified` badge to the user profile only when the attestation confirms a verified account.

### Deployment Network
All contracts and attestations run on **Flare Coston2 testnet (Chain ID 114)**.

---

## What Was Newly Built

Everything in this repository was built from scratch during the hackathon period:

- **`KnockKnockMailbox.sol`** — anonymous chat requests, accept/reject logic, TEE signature verification, pagination, anti-spam caps, and FLR tipping support.
- **`KnockKnockFCCVerifier.sol`** — on-chain InstructionSender that posts private verification jobs to the Flare TEE network without exposing the sender address in emitted events.
- **FCC TypeScript Extension** (`fcc/typescript`) — TEE handlers for `VERIFY_SENDER`, `VERIFY_TWITTER`, and `CHECK_ML_BEHAVIOR`, including Gitcoin Passport calls, Flare RPC queries, FDC polling, and ECDSA signing.
- **ML Training Pipeline** (`ml/train_model.py`) — feature selection, Random Forest training, and JSON serialization of decision-tree rules for TEE execution.
- **Web2.5 Frontend** (`frontend/`) — Next.js 14 app with Firebase Auth, wallet linking, real-time encrypted chat, group knocks, burn-after-reading, and cinematic UI.
- **Firebase Cloud Functions** — username reservation, wallet linking, on-chain chat-request publishing, FCC onboarding verification, wallet switching, and server-side Twitter/FDC verification.

---

## Smart Contract Addresses

**Flare Coston2 (Chain ID 114):**

- **KnockKnockMailbox:** [INSERT DEPLOYED MAILBOX ADDRESS]
- **KnockKnockFCCVerifier:** [INSERT DEPLOYED VERIFIER ADDRESS]

> Deployment artifacts are also persisted in `deployments/coston2.json` and `deployments/coston2-fcc.json` for CI/CD and local reference.

---

## How to Run Locally

### Prerequisites

- Node.js v20+
- npm or yarn
- Python 3.11+ with `pip`
- MetaMask or another EVM wallet
- Firebase CLI (`npm install -g firebase-tools`)
- A Flare Coston2 wallet funded with test FLR

### 1. Clone & Install Dependencies

```bash
git clone  https://github.com/var12958/knock-knock
cd knockknock
npm install
cd frontend && npm install
cd ../fcc/typescript && npm install
cd ../../firebase/functions && npm install
```

### 2. Configure Environment Variables

From the project root:

```bash
cp .env.example .env
cp frontend/.env.local.example frontend/.env.local
cp fcc/typescript/.env.example fcc/typescript/.env
```

Edit the files with your:

- Deployer `PRIVATE_KEY`
- `MAILBOX_ADDRESS` and `FCC_VERIFIER_ADDRESS` after deployment
- Flare RPC URL, Gitcoin Passport API key, and scorer ID
- TEE signer private key and derived address
- Firebase web app credentials

### 3. Compile & Deploy Smart Contracts

```bash
# From project root
npx hardhat compile

# Deploy the mailbox
npx hardhat run scripts/deploy.js --network coston2

# Deploy the FCC verifier and link it to the mailbox
npx hardhat run scripts/deployFCC.js --network coston2
```

The FCC deploy script writes the resulting addresses back into `.env` and `frontend/.env.local`.

### 4. Train the ML Model

```bash
cd ml
pip install -r requirements.txt
python train_model.py
```

This produces `ml/model_weights.json`. Copy it into the TEE extension:

```bash
cp ml/model_weights.json fcc/typescript/src/app/model_weights.json
```

### 5. Start the FCC Development Server

```bash
cd fcc/typescript
npm run build
export TEE_SIGNER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
npm start
```

The local TEE proxy listens on `http://localhost:7702` and exposes `POST /action`, `GET /state`, and `POST /reset`.

### 6. Start the Firebase Emulator

```bash
cd firebase/functions
npm run build
firebase emulators:start --only functions,database
```

### 7. Start the Next.js Frontend

```bash
cd frontend
npm run dev
```

Open `http://localhost:3000`, connect your wallet to **Flare Coston2**, sign in with Firebase, and send your first anonymous knock.

### 8. Run the Test Suites

```bash
# Solidity tests
npx hardhat test

# Frontend tests
cd frontend && npm test

# Firebase functions tests
cd firebase/functions && npm test

# ML tests
cd ml && pytest
```

---

## Roadmap

1. **Mobile App** — Native iOS and Android apps with push notifications for incoming knocks and encrypted chat.
2. **Mainnet Deployment** — Upgrade TEE infrastructure and deploy contracts to **Flare Mainnet** for production-grade privacy.
3. **Soulbound Identity NFTs** — Mint non-transferable SBTs to users who pass TEE verification, creating a portable, privacy-preserving reputation credential.
4. **Group Chat Encryption** — Implement secure multi-party encryption for the Group Knock feature.

---

## Built With ❤️ for the Flare Hackathon

KnockKnock combines the programmability of Flare, the confidentiality of FCC/TEEs, and the UX expectations of modern messaging apps to prove that Web3 identity can be both verifiable and private.

