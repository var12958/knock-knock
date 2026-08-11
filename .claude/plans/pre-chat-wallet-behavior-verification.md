# Plan: Move Wallet Behavioral Verification to the Pre-Chat Acceptance Gate

## Objective
Modify the KnockKnock application so a receiver must complete a private TEE behavioral check on the sender’s wallet **before** they can accept a chat request. The existing `CHECK` button in the chat header must be removed and replaced by a prominent `CHECK WALLET` action on the pending knock card. Only after the TEE returns a valid Human/Bot probability should the `ACCEPT` button become enabled.

Target UX:

```
Incoming Knock → CHECK WALLET → Private TEE + ML Analysis → Behavioral Risk Result → ACCEPT/REJECT → Chat
```

## Current State
- `frontend/components/ChatRoom.tsx` already contains an inline `CHECK` button and `handleCheckMlBehavior` that calls `CHECK_ML_BEHAVIOR` on the Flare FCC proxy, verifies the TEE signature, and shows a `Human X% | Bot Y% — TEE Verified` badge.
- `frontend/components/InboxList.tsx` renders pending knocks with `Accept` / `Reject` buttons. The sender address is hidden (`isRevealed === false`) until accept.
- `fcc/typescript/src/app/handlers.ts` registers `CHECK_ML_BEHAVIOR`, which uses `analyzeWalletBehavior` + `predictBotProbability` + `generateExplanation` from `mlBehavior.ts`.
- `fcc/typescript/src/app/mlBehavior.ts` mixes feature extraction, heuristic Random-Forest/Isolation-Forest inference, and mock fallbacks in one file.
- The mailbox contract (`KnockKnockMailbox.sol`) does **not** enforce behavioral checks; enforcement will remain UI-side to avoid changing the on-chain contract API.

## Constraints
1. Preserve all existing functionality: Firebase auth, E2E encrypted chat, wallet connection, smart contracts, TEE proof verification, Gitcoin Passport verification, tipping, burn-after-reading, group knocks, and current UI.
2. Do **not** mock the TEE or create fake ML results in production logic. The demo-friendly mock feature vector fallback in `mlBehavior.ts` may remain in the TEE for local RPC outages, but the frontend must treat a real TEE-signed response as authoritative.
3. Keep the architecture modular so the ML inference service/model can be replaced or upgraded later.
4. No smart-contract changes unless a later decision explicitly approves them.
5. Sender identity stays hidden on the pending card (no reveal before accept).

## Approach

### 1. Modularize the FCC ML inference service
**Goal:** Separate the "feature extraction" layer from the "inference" layer so a future model can be swapped without touching handler orchestration.

- In `fcc/typescript/src/app/mlBehavior.ts`:
  - Keep `analyzeWalletBehavior(address)` (feature extraction).
  - Define a new `MlInferenceService` interface:
    ```ts
    export interface MlPrediction {
      botProbability: number;
      humanProbability: number;
      explanation: string[];
      modelVersion: string;
    }
    export interface MlInferenceService {
      predict(features: number[]): MlPrediction;
    }
    ```
  - Move the current `predictBotProbability` / `generateExplanation` logic into a `HeuristicMlInferenceService` class that implements `MlInferenceService`.
  - Export a factory `createMlInferenceService(): MlInferenceService` that returns the heuristic implementation today and can later return a hosted-model or ONNX implementation.
- In `fcc/typescript/src/app/handlers.ts`:
  - Instantiate `createMlInferenceService()` at module load and call `service.predict(features)` inside `handleCheckMlBehavior`.
  - Keep all signing/encoding logic unchanged.

### 2. Add frontend verification utilities
**Goal:** Encapsulate decoding, cryptographic verification, and risk-level mapping in a reusable, testable module.

- Create `frontend/lib/walletBehavior.ts`:
  - Type `WalletBehaviorResult` (humanProbability, botProbability, explanation[], modelVersion, riskLevel, timestamp, signature, signerAddress).
  - `verifyWalletBehaviorAttestation(encodedData: string, expectedTargetAddress: string, expectedSigner?: string): WalletBehaviorResult` — re-implements the checks currently in `ChatRoom.handleCheckMlBehavior`:
    - decode the 8 ABI fields,
    - verify `humanBp + botBp === 10_000`,
    - verify `targetAddress` matches,
    - verify attestation age ≤ 300 s,
    - recover the signer and compare against the response signer and optional `NEXT_PUBLIC_TEE_SIGNER_ADDRESS`.
  - `computeBehaviorRiskLevel(botProbability: number): "LOW" | "MEDIUM" | "HIGH"`:
    - LOW: botProbability < 0.30
    - MEDIUM: 0.30 ≤ botProbability < 0.70
    - HIGH: botProbability ≥ 0.70
  - `requestWalletBehaviorCheck(proxyUrl: string, targetAddress: string, signal?: AbortSignal): Promise<WalletBehaviorResult>` — builds the `CHECK_ML_BEHAVIOR` payload, polls/receives the proxy response, and runs verification.
- Create `frontend/components/WalletBehaviorResult.tsx`:
  - Pure presentational component that renders:
    - risk badge (LOW/MEDIUM/HIGH) with color coding,
    - `Human X% | Bot Y% — TEE Verified`,
    - model version,
    - top 3 explanation bullets,
    - a subtle "Verified inside Flare TEE" note.

### 3. Move the verification gate into the pending-knock card
**Goal:** The receiver sees the anonymous knock, clicks `CHECK WALLET`, waits, then sees the result. `ACCEPT` is disabled until a valid result is present.

- Update `frontend/components/InboxList.tsx`:
  - Add a per-request wallet-check state map keyed by `requestId`:
    ```ts
    type CheckState =
      | { status: "idle" }
      | { status: "loading" }
      | { status: "error"; message: string }
      | { status: "success"; result: WalletBehaviorResult };
    ```
  - In the pending card, hide sender address (already hidden) and render:
    - If `check.status === "idle"`: a prominent `CHECK WALLET` button (primary style, shield icon).
    - If `check.status === "loading"`: an `Analyzing Wallet…` block with spinner and copy: "TEE is scanning on-chain history and running the behavioral model. This stays private."
    - If `check.status === "error"`: inline error + retry button.
    - If `check.status === "success"`: `<WalletBehaviorResult result={...} />`.
  - The `ACCEPT` button is `disabled` unless `actionId !== requestId` and `check.status === "success"`.
  - Keep `REJECT` always enabled (so the receiver can bail out even while loading).
  - After a successful accept, the request leaves pending and the check state can be discarded.
  - On address/signer change, clear all per-request check state.

### 4. Remove the old chat-header check
**Goal:** Avoid duplicate UI and dead code.

- In `frontend/components/ChatRoom.tsx`:
  - Remove `mlScore`, `isCheckingML`, `mlError` state.
  - Remove `handleCheckMlBehavior`.
  - Remove the `CHECK` button, result badge, and error pill from the header.
  - Keep the `Active` badge and all chat/message/tip/burn functionality intact.

### 5. Tests
**Goal:** Meet the 80% coverage expectation and verify the new gate.

- Add `frontend/lib/walletBehavior.test.ts`:
  - Test `computeBehaviorRiskLevel` thresholds.
  - Test `verifyWalletBehaviorAttestation` with a valid signature and with tampered/invalid signatures.
  - Test stale-attestation rejection.
  - Test `humanBp + botBp === 10_000` enforcement.
- Add `frontend/components/WalletBehaviorResult.test.tsx`:
  - Render LOW, MEDIUM, HIGH states.
  - Verify explanation list and percentages.
- Update `frontend/components/ChatRoom.tsx` to remove CHECK UI. If a test existed for it, update it.
- Run `npm test` and `npm run lint` in the frontend directory.
- Run FCC tests if any exist (`npm test` in `fcc/typescript`).

### 6. Code review & security review
**Goal:** Follow the ECC workflow rules.

- Use the `code-reviewer` agent after the implementation is written.
- Use the `security-reviewer` agent because this touches TEE signature verification, user input (addresses), and Firebase paths.
- Fix any CRITICAL/HIGH findings before committing.

## File Changes

| File | Action | Summary |
|------|--------|---------|
| `fcc/typescript/src/app/mlBehavior.ts` | Modify | Add `MlInferenceService` interface, `HeuristicMlInferenceService`, and `createMlInferenceService()` factory. |
| `fcc/typescript/src/app/handlers.ts` | Modify | Use `createMlInferenceService()` in `handleCheckMlBehavior`. |
| `frontend/lib/walletBehavior.ts` | Create | Decode, verify, and map TEE ML attestation; compute risk level. |
| `frontend/lib/walletBehavior.test.ts` | Create | Unit tests for verification and risk mapping. |
| `frontend/components/WalletBehaviorResult.tsx` | Create | Presentational result card. |
| `frontend/components/WalletBehaviorResult.test.tsx` | Create | Component tests. |
| `frontend/components/InboxList.tsx` | Modify | Add per-request check state, `CHECK WALLET` UX, and gate Accept on success. |
| `frontend/components/ChatRoom.tsx` | Modify | Remove CHECK button, ML state, and handler. |
| `frontend/components/ChatRoom.test.tsx` | Create/Update | Remove any CHECK-related assertions; keep chat tests. |
| `frontend/.env.local.example` | Maybe update | Document `NEXT_PUBLIC_TEE_SIGNER_ADDRESS` if not already present. |

## Acceptance Criteria
- [ ] A pending knock card shows a `CHECK WALLET` button instead of an enabled `ACCEPT` button.
- [ ] Clicking `CHECK WALLET` triggers `CHECK_ML_BEHAVIOR` against the sender’s wallet and shows `Analyzing Wallet…`.
- [ ] On success, the card displays `Human X% | Bot Y% — TEE Verified` plus LOW/MEDIUM/HIGH risk and explanation bullets.
- [ ] Only after success does the `ACCEPT` button become enabled.
- [ ] Clicking `REJECT` never opens chat and works regardless of check state.
- [ ] The chat room no longer contains a `CHECK` button or ML badge.
- [ ] Existing chat, tipping, burn-after-reading, group knocks, and onboarding flows continue to work.
- [ ] New unit/component tests pass and coverage remains ≥ 80%.
- [ ] No fake ML results or mocked TEE logic are introduced in production code.
- [ ] `code-reviewer` and `security-reviewer` agents sign off with no CRITICAL issues.

## User Decisions (Resolved)
1. **Persistent check state:** Persist across sessions so the receiver does not have to re-run the check every time they return to the inbox.
2. **Minimum human probability to accept:** `ACCEPT` is enabled only when the TEE result is valid *and* the risk level is not `HIGH` (bot probability < 70%).
3. **On-chain enforcement:** Remain UI-only for now; structure the code so a future contract upgrade can require an on-chain attestation.

## Persistence Details
- Store the **raw ABI-encoded TEE response** (the `data` field from the FCC proxy) in `localStorage` under a key scoped to the request: `knockknock-behavior-check-v1:${requestId}`.
- On inbox load, attempt to restore each pending request's check state by re-running `verifyWalletBehaviorAttestation` on the stored bytes. Skip the 300-second staleness check during restore; the TEE signature itself proves the result was produced by the TEE, and the request's on-chain expiration bounds its lifetime.
- If the stored bytes are missing, tampered, or fail signature/address/basis-point verification, fall back to `idle`.
- Provide a "Re-check" / "Check again" control so the receiver can refresh the analysis.

## Risk Gating Details
- `computeBehaviorRiskLevel(botProbability)` returns:
  - `LOW`: botProbability < 0.30
  - `MEDIUM`: 0.30 ≤ botProbability < 0.70
  - `HIGH`: botProbability ≥ 0.70
- `ACCEPT` is enabled only when `check.status === "success"` **and** `result.riskLevel !== "HIGH"`.
- `REJECT` remains enabled in every state.

## Phases
1. FCC inference modularization + handler wiring.
2. Frontend utility + presentational components + tests.
3. InboxList integration and gating.
4. ChatRoom cleanup.
5. Agent review, lint/test, commit.
