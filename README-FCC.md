# KnockKnock Flare Confidential Compute (FCC) Extension

This directory contains the privacy-preserving verifier for the KnockKnock messaging app, built as a [Flare Confidential Compute (FCC)](https://dev.flare.network/fcc/overview) extension.

## What it does

The FCC extension runs inside a Trusted Execution Environment (TEE) and privately verifies a sender before a `KnockKnockMailbox` chat request is created. It performs two checks:

1. **Proof of History** — queries the Flare RPC to confirm the sender wallet has been active for at least 365 days.
2. **Proof of Humanity** — simulates an identity score check (e.g., Gitcoin Passport) and passes if the score is above the threshold.

The sender wallet address is supplied as a **private input** to the TEE. The extension's public output contains only:

- `isVerifiedHuman` (`bool`)
- `isOldEnoughWallet` (`bool`)
- a request-binding `bytes32` hash
- an ECDSA signature from the TEE signer

The wallet address is never emitted in the public output data.

## Architecture

```text
┌─────────────┐         ┌─────────────────────────┐         ┌─────────────┐
│   Sender    │ ──────▶ │ KnockKnockFCCVerifier   │ ──────▶ │  Flare TEE  │
│   Wallet    │         │ (InstructionSender)     │         │   Network   │
└─────────────┘         └─────────────────────────┘         └──────┬──────┘
                                                                   │
                                                                   │ private input
                                                                   │ + RPC/identity queries
                                                                   │
                                                                   ▼
                                                          ┌─────────────────┐
                                                          │  TypeScript TEE │
                                                          │    extension    │
                                                          │ (this directory)│
                                                          └────────┬────────┘
                                                                   │
                                                                   │ signed proof
                                                                   │ (bool,bool,hash,sig)
                                                                   ▼
┌─────────────┐         ┌─────────────────────────┐         ┌─────────────┐
│   Sender    │ ──────▶ │   KnockKnockMailbox     │ ◀──────│   Proxy /   │
│   Wallet    │         │  sendRequestWithProof   │         │   Relayer   │
└─────────────┘         └─────────────────────────┘         └─────────────┘
```

1. The sender calls `KnockKnockFCCVerifier.requestVerification(receiver, encryptedPreview, deadline, mailbox)` on-chain. This posts a `KNOCKKNOCK/VERIFY_SENDER` instruction to the Flare TEE network. The on-chain `VerificationRequested` event does **not** include the sender address.
2. A TEE machine fetches the instruction, decrypts the private payload `(address sender, address receiver, string encryptedPreview, uint256 deadline, uint256 chainId, address mailbox)`, runs the two checks, and signs the result.
3. The signed proof is retrieved from the FCC proxy (off-chain polling).
4. The sender calls `KnockKnockMailbox.sendRequestWithProof(receiver, encryptedPreview, isVerifiedHuman, isOldEnoughWallet, deadline, requestHash, teeSignature)`. The mailbox verifies the signature, checks the deadline and the request-hash binding, and creates the request.

The original `KnockKnockMailbox.sendRequest(...)` remains available for testing and for users who do not want to go through FCC verification.

## Files

- `contracts/KnockKnockMailbox.sol` — updated mailbox with `sendRequestWithProof` and TEE signer management.
- `contracts/KnockKnockFCCVerifier.sol` — on-chain InstructionSender that submits jobs to the TEE.
- `fcc/typescript/src/app/handlers.ts` — core TEE verification logic (PoH + humanity + signing).
- `fcc/typescript/src/app/config.ts` — operation constants and thresholds.
- `fcc/typescript/src/main.ts` — local HTTP server entrypoint for development.
- `fcc/typescript/Dockerfile` — image for deployment inside Flare's confidential compute stack.
- `scripts/deployFCC.js` — deploys the verifier and links it to the mailbox.
- `test/KnockKnockMailbox.js` — includes FCC proof verification tests.
- `test/KnockKnockFCCVerifier.js` — tests verifier deployment, registry wiring, and instruction emission.
- `contracts/mocks/MockTeeRegistries.sol` — mock Flare TEE registries for offline verifier tests.

## Local development

### 1. Install and build the TypeScript extension

```bash
cd fcc/typescript
npm install
npm run build
```

### 2. Run the extension locally

```bash
# Use the well-known Hardhat test account #1 as the mock TEE signer.
export TEE_SIGNER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
npm start
```

The server listens on `http://localhost:7702` and exposes:

- `POST /action` — invoke a handler
- `GET /state` — inspect extension state
- `POST /reset` — reset in-memory state

### 3. Test the handler with curl

```bash
curl -X POST http://localhost:7702/action \
  -H "Content-Type: application/json" \
  -d '{
    "opType": "KNOCKKNOCK",
    "opCommand": "VERIFY_SENDER",
    "originalMessage": "0x..."
  }'
```

`originalMessage` must be the ABI-encoded tuple `(address sender, address receiver, string encryptedPreview, uint256 deadline, uint256 chainId, address mailbox)`.

### 4. Run the Hardhat tests

```bash
npx hardhat test
```

## Deploying to Coston2

1. Set the registry addresses in `.env`:

```bash
MAILBOX_ADDRESS=0x...
TEE_EXTENSION_REGISTRY=0x...
TEE_MACHINE_REGISTRY=0x...
TEE_SIGNER_ADDRESS=0x...
PRIVATE_KEY=0x...
FLARESCAN_API_KEY=...
```

2. Deploy/link the verifier:

```bash
npx hardhat run scripts/deployFCC.js --network coston2
```

3. Register the FCC extension image with the Flare TEE registry and set the resulting `extensionId` via `KnockKnockFCCVerifier.setExtensionId()`.

4. Build and push the TEE Docker image:

```bash
docker build -f fcc/typescript/Dockerfile -t knockknock-fcc .
```

Then follow the Flare FCC operator guide to register the image hash and run the `extension-tee` / `ext-proxy` / `redis` stack.

## Privacy notes

- The sender address is only present in the confidential instruction payload consumed by the TEE; the on-chain `VerificationRequested` event does **not** include it, and the TEE output does not reveal it.
- The TEE output signature binds the proof to `chainId || mailbox || sender || isVerifiedHuman || isOldEnoughWallet || requestHash`, so a valid proof cannot be replayed on another chain, contract, or wallet.
- Because every EVM transaction is signed by an EOA, `msg.sender` is public by design, and `KnockKnockMailbox.RequestSent` indexes it. True sender anonymity would require an additional relayer / meta-transaction layer.

## Production considerations

- Replace the mock `checkWalletAge` and `checkHumanity` fallbacks with live calls to a Flare RPC + an identity oracle, all made from inside the TEE.
- Derive the TEE signer address from on-chain attestation rather than setting it manually with `setTEESigner`.
- Rate-limit `requestVerification` calls or require payment to prevent instruction spam.
- Ensure the request-hash binding (`keccak256(receiver || preview || deadline)`) is recomputed and verified in the mailbox before accepting a TEE-signed proof.
- Use the TEE node's `/decrypt` endpoint to decrypt private inputs that are encrypted to the enclave's public key.

## Sources

- [Flare FCC Overview](https://dev.flare.network/fcc/overview)
- [Build Your First Extension](https://dev.flare.network/fcc/guides/getting-started)
- [Private Key Extension (TypeScript)](https://dev.flare.network/fcc/guides/sign-extension)
- [fce-sign TypeScript scaffold](https://github.com/flare-foundation/fce-sign)
- [fce-extension-scaffold](https://github.com/flare-foundation/fce-extension-scaffold)
