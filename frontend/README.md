# KnockKnock Frontend

A Next.js dApp for the KnockKnock Web3 messaging app on the Flare Coston2 testnet.

## Features

- **MetaMask connect** with automatic switch/add of the Flare Coston2 network (Chain ID 114).
- **Send page** (`/send`) — send a hex-encoded preview message with self-reported proof badges.
- **Inbox page** (`/inbox`) — view pending requests, see proof badges, and accept or reject without revealing the sender address.
- **Chat room** (`/chat/[requestId]`) — real-time messaging via Firebase Realtime Database with client-side AES encryption.

## Quick start

1. Install dependencies:

```bash
cd frontend
npm install
```

2. Create `.env.local` from the example and set your deployed mailbox address and Firebase config:

```bash
cp .env.local.example .env.local
```

```bash
# .env.local
NEXT_PUBLIC_MAILBOX_ADDRESS=0xYourDeployedMailboxAddress

NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_DATABASE_URL=https://your_project-default-rtdb.region.firebasedatabase.app
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=123456789
NEXT_PUBLIC_FIREBASE_APP_ID=1:123456789:web:abcdef
```

3. Run the development server:

```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000) and connect MetaMask.

## Deploying the mailbox first

From the project root:

```bash
npx hardhat run scripts/deploy.js --network coston2
```

Copy the printed address into `frontend/.env.local` as `NEXT_PUBLIC_MAILBOX_ADDRESS`.

## Firebase setup

1. Go to [Firebase Console](https://console.firebase.google.com/) and create a project.
2. Enable **Realtime Database** (not Firestore).
3. Register a **Web app** and copy the config values into `.env.local`.
4. Install these security rules in the Realtime Database **Rules** tab:

```json
{
  "rules": {
    "chats": {
      "$requestId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

> ⚠️ These rules allow any authenticated Firebase user to read/write all chats. For a production dApp, integrate Firebase Auth with wallet-signed custom tokens so only `sender` and `receiver` can access `/chats/{requestId}`.

## FCC integration notes

The current `/send` page uses the self-reported `sendRequest` path so it works out of the box on Coston2. To enable the Flare Confidential Compute proof path (`sendRequestWithProof`), wire the page to:

1. Call `KnockKnockFCCVerifier.requestVerification(...)` on-chain.
2. Poll your TEE proxy for the signed `(isVerifiedHuman, isOldEnoughWallet, requestHash, signature)` response.
3. Submit the result to `KnockKnockMailbox.sendRequestWithProof(...)`.

The contract helpers in `lib/contracts.ts` already expose the mailbox ABI, which includes both functions.

## Chat encryption notes

- Messages are encrypted in the browser with **crypto-js AES** before being pushed to Firebase.
- The shared key is derived deterministically from the sender and receiver wallet addresses plus a static salt.
- ⚠️ Because wallet addresses are public, this key derivation is **not secure against a determined attacker**. It is acceptable for a hackathon demo, but a production app should use ECDH or a secret shared through a trusted channel.

## Navigation flow

1. Sender goes to `/send`, fills the form, and clicks **Send Knock**.
2. Receiver goes to `/inbox`, sees the pending request, and clicks **Accept**.
3. After the accept transaction is mined, the receiver is automatically routed to `/chat/{requestId}`.
4. Both sender and receiver can open `/chat/{requestId}` directly; the component loads request details from the blockchain and starts the real-time Firebase listener.

## Project structure

```
frontend/
  app/
    layout.tsx          # Web3Provider + Web3Header wrapper
    page.tsx            # Landing page
    send/page.tsx       # Send request form
    inbox/page.tsx      # Inbox list
    chat/[requestId]/   # Chat room route
  components/
    Web3Header.tsx      # Connect wallet button + network badge
    SendRequestForm.tsx # Send request form + transaction handling
    InboxList.tsx       # Pending requests + accept/reject + chat navigation
    ProofBadge.tsx      # Green/red proof indicator
    ChatRoom.tsx        # Real-time encrypted chat UI
  context/
    Web3Context.tsx     # MetaMask connection state
  lib/
    chain.ts            # Coston2 network config
    contracts.ts        # Mailbox ABI + contract instances
    encodePreview.ts    # Hex encode/decode preview messages
    provider.ts         # Read-only / browser provider helpers
    firebase.ts         # Firebase Realtime Database init
    chatCrypto.ts       # AES key derivation + encrypt/decrypt
```
