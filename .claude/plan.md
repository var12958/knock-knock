# Plan: KnockKnock Chat Room with Firebase + Client-Side Encryption

## Goal
Add a real-time chat room to the existing Next.js frontend that:
1. Uses Firebase Realtime Database to store and stream messages.
2. Encrypts messages client-side with crypto-js using a deterministic shared key.
3. Lives at `/chat/[requestId]` and is reachable from the Inbox after accepting a request.

## Architecture Decisions

### 1. Firebase Choice
- **Firebase Realtime Database** (not Firestore) because it natively supports real-time `onValue` listeners, which matches the requirement.
- Initialize Firebase in `frontend/lib/firebase.ts` using environment variables.

### 2. Encryption Approach (hackathon-safe, documented as weak)
- Use **crypto-js AES**.
- Shared key is derived deterministically from the two chat participant addresses:
  - Sort addresses alphabetically to ensure both sides compute the same key.
  - Hash the ordered pair with a static salt using `ethers.keccak256`.
  - Take the first 32 hex characters as the AES passphrase.
- **Security note**: because wallet addresses are public, anyone can derive this key. This is acceptable only for a hackathon demo. Production must use a key exchange (e.g., ECDH) or a secret shared off-chain.

### 3. Data Model
```
/chats/{requestId}/messages/{pushId}
  sender: address
  text: encryptedHex
  timestamp: number
```
- Messages ordered by Firebase push key (chronological) or by timestamp.

### 4. Chat Page (`/chat/[requestId]`)
- Server-rendered outer page (`frontend/app/chat/[requestId]/page.tsx`) passes `requestId` to a client component.
- Client component (`frontend/components/ChatRoom.tsx`) does the following:
  - Reads `KnockKnockMailbox.requests(requestId)` to get `sender` and `receiver`.
  - Validates that the connected wallet is either sender or receiver.
  - Derives the shared key.
  - Listens to `/chats/{requestId}/messages` in real time.
  - Decrypts each message and renders it with sender labels.
  - Provides an input + send button that encrypts and pushes a new message.

### 5. Inbox Navigation Update
- After `acceptRequest` succeeds in `InboxList.tsx`, call `router.push(`/chat/${requestId}`)`.
- The chat component will load the request details and start listening.

### 6. Files to Create / Modify

#### New files
1. `frontend/lib/firebase.ts` — Firebase app + Realtime Database initialization.
2. `frontend/lib/chatCrypto.ts` — Key derivation, encrypt, decrypt helpers.
3. `frontend/components/ChatRoom.tsx` — Real-time chat UI.
4. `frontend/app/chat/[requestId]/page.tsx` — Route wrapper.

#### Modified files
1. `frontend/components/InboxList.tsx` — Navigate to `/chat/[requestId]` after accepting.
2. `frontend/package.json` — Add `firebase`, `crypto-js`, `@types/crypto-js`.
3. `frontend/.env.local.example` — Add Firebase config env vars.
4. `frontend/README.md` — Document Firebase setup and security rules.

### 7. Dependencies
- `firebase` (v10+)
- `crypto-js` (v4+)
- `@types/crypto-js`

### 8. Security Rules (provided, not deployed)
- Example rules that allow authenticated app users to read/write `/chats/{requestId}`.
- Reminder that real production rules should verify wallet ownership (e.g., via Firebase Auth custom tokens signed by the wallet).

### 9. Error Handling
- Show clear errors when:
  - Firebase is not configured.
  - The connected wallet is not a participant in the chat.
  - A message fails to decrypt (show a placeholder instead of crashing).

### 10. Styling
- Tailwind CSS, matching the existing KnockKnock design system.
- Message bubbles: own messages on the right (brand color), other messages on the left (slate).
