# KnockKnock Phase 5 Deployment Plan

## Goal
Deploy the KnockKnock smart contracts to Flare Coston2, wire the Next.js frontend to the real Flare Confidential Compute (FCC) verification path, and lock down Firebase Realtime Database chat rules.

## Current State
- `KnockKnockMailbox.sol` and `KnockKnockFCCVerifier.sol` are implemented and compile.
- `scripts/deploy.js` deploys the mailbox and writes `deployments/coston2.json`.
- `scripts/deployFCC.js` deploys the verifier, links it to the mailbox, and sets the TEE signer.
- The frontend `SendRequestForm` currently calls `sendRequest` with self-reported booleans.
- No `.env` file exists at the project root; only `.env.example`.
- No `frontend/.env.local` exists; only `frontend/.env.local.example`.
- FCC registry addresses for Coston2 are **not** in the repo and must be supplied by the operator from Flare's official FCC deployment artifacts.

## Step 1 — Smart Contract Deployment to Coston2

### Actions
1. Create a real `.env` from `.env.example`.
2. Fund the deployer wallet with Coston2 C2FLR (faucet required).
3. Run `npx hardhat run scripts/deploy.js --network coston2`.
4. Copy the printed mailbox address into `.env` as `MAILBOX_ADDRESS` and into `frontend/.env.local` as `NEXT_PUBLIC_MAILBOX_ADDRESS`.

### Open Items / Risks
- The exact `TEE_EXTENSION_REGISTRY` and `TEE_MACHINE_REGISTRY` addresses for Coston2 must be obtained from Flare's official FCC Coston2 deployment config (the scaffold's `config/coston2/deployed-addresses.json` lists `FlareTeeManager` but not the registry names used by this project). We will use clear placeholders and tell the user to substitute the values.
- `requestVerification` is payable; the verifier may need a small `value` if the registry charges fees. We will default to `0` and note this.

## Step 2 — Frontend Environment Configuration

### Actions
1. Create `frontend/.env.local` from `frontend/.env.local.example`.
2. Set `NEXT_PUBLIC_MAILBOX_ADDRESS` to the deployed mailbox address.
3. Set `NEXT_PUBLIC_FCC_VERIFIER_ADDRESS` to the deployed verifier address.
4. (Optional) Set `NEXT_PUBLIC_FCC_PROXY_URL` if a local/operator proxy is used to retrieve TEE signatures.
5. Fill in Firebase project values.

## Step 3 — Wiring the Real FCC Path in `SendRequestForm`

### Approach
Replace the self-reported `sendRequest` call with a two-transaction flow:

1. **Request verification on-chain**
   - Call `KnockKnockFCCVerifier.requestVerification(receiver, encodedPreview, deadline, mailbox)`.
   - The contract encodes the private payload and emits `VerificationRequested(receiver, requestHash, teeId)`.
2. **Obtain the signed proof**
   - In a real Flare FCC deployment the TEE returns the signature through a proxy/relayer.
   - For the hackathon/local dev path the frontend can poll a small proxy endpoint or, if the local FCC server (`http://localhost:7702/action`) is reachable, call it with the reconstructed ABI-encoded message.
   - We will implement a helper that polls a configurable proxy URL and falls back to a manual/CORS note if the proxy is unavailable.
3. **Submit proof to mailbox**
   - Decode the TEE response `(bool isVerifiedHuman, bool isOldEnoughWallet, bytes32 requestHash, bytes signature)`.
   - Call `KnockKnockMailbox.sendRequestWithProof(...)` with the attested values.

### Files to Change
- `frontend/lib/abis/KnockKnockFCCVerifier.json` — create from Hardhat artifact.
- `frontend/lib/contracts.ts` — add `FCC_VERIFIER_ADDRESS`, `FCC_VERIFIER_ABI`, and `getFCCVerifierContractWrite`.
- `frontend/components/SendRequestForm.tsx` — replace `sendRequest` with the FCC flow.
- `frontend/.env.local.example` — add `NEXT_PUBLIC_FCC_VERIFIER_ADDRESS` and `NEXT_PUBLIC_FCC_PROXY_URL`.

### UX Considerations
- Show distinct status messages: "Submitting verification request…", "Waiting for TEE signature…", "Submitting proof to mailbox…".
- Cap polling to a reasonable timeout (~2 minutes) and allow cancellation.
- Keep a fallback note that if no proxy is running the user must supply the proof manually or run the local FCC server.

## Step 4 — Firebase Realtime Database Security Rules

### Rules Design
Lock each chat node to the two participants.

```json
{
  "rules": {
    "chats": {
      "$requestId": {
        ".read": "auth != null && (auth.uid == root.child('requests').child($requestId).child('sender').val() || auth.uid == root.child('requests').child($requestId).child('receiver').val())",
        ".write": "auth != null && (auth.uid == root.child('requests').child($requestId).child('sender').val() || auth.uid == root.child('requests').child('requestId).child('receiver').val())",
        "messages": {
          "$messageId": {
            ".validate": "newData.hasChildren(['sender', 'text', 'timestamp']) && newData.child('sender').val() == auth.uid"
          }
        }
      }
    }
  }
}
```

### Note
The rules assume a top-level `requests` node storing `sender`/`receiver` UIDs. If the app stores wallet addresses instead of Firebase UIDs, the rule should compare against `auth.token.address` or use a `participants` child. We will provide both variants.

## Verification Checklist
- [ ] `npx hardhat test` still passes.
- [ ] Contract deploys to Coston2 and address is persisted.
- [ ] Frontend reads mailbox and verifier addresses from env.
- [ ] Send flow calls `requestVerification` then `sendRequestWithProof`.
- [ ] Firebase rules validate in the Firebase Console rules simulator.

## Open Questions for User
1. Do you have the official Flare FCC Coston2 `TEE_EXTENSION_REGISTRY` and `TEE_MACHINE_REGISTRY` addresses? If not, we can deploy with placeholder registries and only use the `sendRequest` path, then swap them in later.
2. Do you want the local-dev FCC server polling fallback in the frontend, or do you have a real FCC proxy/relayer URL?
3. Does your Firebase auth use UIDs or wallet addresses to identify users?
