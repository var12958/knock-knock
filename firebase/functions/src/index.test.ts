import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  updateMock,
  setMock,
  getMock,
  transactionMock,
} = vi.hoisted(() => ({
  updateMock: vi.fn(),
  setMock: vi.fn(),
  getMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(),
  getApps: vi.fn(() => []),
}));

vi.mock("firebase-admin/database", () => ({
  getDatabase: vi.fn(() => ({
    ref: vi.fn((path: string) => {
      const capturedPath = path;
      return {
        get: () => getMock(capturedPath),
        set: (value: unknown) => setMock(capturedPath, value),
        update: (value: unknown) => updateMock(capturedPath, value),
        transaction: transactionMock,
      };
    }),
    update: updateMock,
    transaction: transactionMock,
  })),
}));

vi.mock("firebase-functions/params", () => ({
  defineString: vi.fn((_name: string, opts: { default?: string }) => ({
    value: vi.fn(() => {
      if (_name === "MAILBOX_ADDRESS") {
        return "0x1111111111111111111111111111111111111111";
      }
      return opts?.default ?? "";
    }),
  })),
}));

import {
  reserveUsernameAndCreateProfileHandler,
  linkWalletHandler,
  publishChatRequestHandler,
  verifyFCCOnboardingHandler,
  switchLinkedWalletHandler,
  validateUsername,
  normalizeUsername,
  assertProfileWalletMatches,
} from "./index.js";
import { HttpsError } from "firebase-functions/v2/https";
import * as ethers from "ethers";
import { MAILBOX_ABI } from "./mailboxAbi.js";

const TEST_WALLET = new ethers.Wallet(
  "0x0000000000000000000000000000000000000000000000000000000000000001",
);

const getTransactionReceiptSpy = vi.spyOn(
  ethers.JsonRpcProvider.prototype,
  "getTransactionReceipt",
);

// ethers.Contract adds ABI methods dynamically; add a prototype spy so we can
// mock the mailbox `requests(uint256)` view used by verifyFCCOnboardingHandler.
(ethers.Contract.prototype as any).requests = vi.fn();
const contractRequestsSpy = vi.spyOn(
  ethers.Contract.prototype as any,
  "requests",
);

function makeRequest<T>(data: T, uid = "test-uid", token: Record<string, unknown> = {}) {
  return {
    auth: { uid, token, tokenId: "" as any, eventId: "", eventNumber: 1, operationId: "" },
    data,
    rawRequest: {} as any,
    instanceIdToken: "",
    app: {} as any,
    id: "test-id",
  };
}

describe("reserveUsernameAndCreateProfileHandler", () => {
  beforeEach(() => {
    transactionMock.mockReset();
  });

  function mockTransaction(opts: { profileExists?: boolean; usernameExists?: boolean } = {}) {
    transactionMock.mockImplementation(async (updateFn: any) => {
      const currentData: Record<string, unknown> = {};
      currentData["users"] = {};
      currentData["usernames"] = {};
      if (opts.profileExists) {
        (currentData["users"] as Record<string, unknown>)["test-uid"] = { uid: "test-uid" };
      }
      if (opts.usernameExists) {
        (currentData["usernames"] as Record<string, unknown>)["knock-user"] = { uid: "other-uid" };
      }
      const result = updateFn(currentData);
      if (result === undefined) {
        return { committed: false, snapshot: { val: () => currentData } };
      }
      return { committed: true, snapshot: { val: () => result } };
    });
  }

  it("reserves a username and creates a profile atomically", async () => {
    mockTransaction();

    const result = await reserveUsernameAndCreateProfileHandler(
      makeRequest({ username: "knock_user" }, "test-uid", { email: "a@b.com", name: "Knock" }),
    );

    expect(result).toEqual({ success: true, username: "knock_user" });
    expect(transactionMock).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated callers", async () => {
    await expect(
      reserveUsernameAndCreateProfileHandler({
        auth: undefined,
        data: { username: "knock_user" },
        rawRequest: {} as any,
        instanceIdToken: "",
        app: {} as any,
        id: "test-id",
      }),
    ).rejects.toThrow(HttpsError);
  });

  it("rejects invalid usernames", async () => {
    await expect(
      reserveUsernameAndCreateProfileHandler(makeRequest({ username: "ab" })),
    ).rejects.toThrow(HttpsError);
  });

  it("rejects duplicate reservations", async () => {
    mockTransaction({ usernameExists: true });

    await expect(
      reserveUsernameAndCreateProfileHandler(makeRequest({ username: "knock_user" })),
    ).rejects.toThrow(/already taken/);
  });

  it("rejects when the profile already exists", async () => {
    mockTransaction({ profileExists: true });

    await expect(
      reserveUsernameAndCreateProfileHandler(makeRequest({ username: "knock_user" })),
    ).rejects.toThrow(/already have a profile/);
  });

  it("returns a nested update object without slash-containing keys", async () => {
    let capturedUpdate: Record<string, unknown> | undefined;
    transactionMock.mockImplementation(async (updateFn: any) => {
      capturedUpdate = updateFn({ users: {}, usernames: {} });
      return { committed: true, snapshot: { val: () => capturedUpdate } };
    });

    await reserveUsernameAndCreateProfileHandler(
      makeRequest({ username: "knock_user" }, "test-uid", { email: "a@b.com", name: "Knock" }),
    );

    expect(capturedUpdate).toBeDefined();
    expect(capturedUpdate).toEqual({
      users: {
        "test-uid": expect.objectContaining({
          uid: "test-uid",
          username: "knock_user",
          email: "a@b.com",
          displayName: "Knock",
        }),
      },
      usernames: {
        "knock-user": expect.objectContaining({
          uid: "test-uid",
          reservedAt: expect.any(Number),
        }),
      },
    });

    // Regression guard: the transaction result must never contain keys with RTDB
    // path separators such as "users/test-uid" or "usernames/knock-user".
    const keys = Object.keys(capturedUpdate ?? {});
    for (const key of keys) {
      expect(key).not.toMatch(/[.#$\/[\]]/);
    }
  });
});

describe("linkWalletHandler", () => {
  beforeEach(() => {
    transactionMock.mockReset();
  });

  function mockTransaction(opts: { profileWallet?: string; existingLinkUid?: string } = {}) {
    transactionMock.mockImplementation(async (updateFn: any) => {
      const currentData: Record<string, unknown> = {};
      currentData["users"] = { "test-uid": { uid: "test-uid", walletAddress: opts.profileWallet ?? null } };
      currentData["walletAddresses"] = {};
      if (opts.existingLinkUid) {
        const walletAddress = (await TEST_WALLET.getAddress()).toLowerCase();
        (currentData["walletAddresses"] as Record<string, unknown>)[walletAddress] = { uid: opts.existingLinkUid };
      }
      const result = updateFn(currentData);
      if (result === undefined) {
        return { committed: false, snapshot: { val: () => currentData } };
      }
      return { committed: true, snapshot: { val: () => result } };
    });
  }

  it("links a wallet when the signature is valid", async () => {
    const walletAddress = await TEST_WALLET.getAddress();
    const message = `Link wallet ${walletAddress.toLowerCase()} to KnockKnock account test-uid`;
    const signature = await TEST_WALLET.signMessage(message);

    mockTransaction();

    const result = await linkWalletHandler(
      makeRequest({ walletAddress, signature }),
    );

    expect(result).toEqual({ success: true, walletAddress });
  });

  it("rejects a mismatched signature", async () => {
    const walletAddress = await TEST_WALLET.getAddress();
    const otherWallet = new ethers.Wallet(
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    );
    const signature = await otherWallet.signMessage("wrong message");

    await expect(
      linkWalletHandler(makeRequest({ walletAddress, signature })),
    ).rejects.toThrow(/does not match/);
  });

  it("rejects linking a wallet that is already linked to another profile", async () => {
    const walletAddress = await TEST_WALLET.getAddress();
    const message = `Link wallet ${walletAddress.toLowerCase()} to KnockKnock account test-uid`;
    const signature = await TEST_WALLET.signMessage(message);

    mockTransaction({ existingLinkUid: "other-uid" });

    await expect(
      linkWalletHandler(makeRequest({ walletAddress, signature })),
    ).rejects.toThrow(/already linked to another account/);
  });

  it("rejects when the profile already has a wallet", async () => {
    const walletAddress = await TEST_WALLET.getAddress();
    const message = `Link wallet ${walletAddress.toLowerCase()} to KnockKnock account test-uid`;
    const signature = await TEST_WALLET.signMessage(message);

    mockTransaction({ profileWallet: "0x0987654321098765432109876543210987654321" });

    await expect(
      linkWalletHandler(makeRequest({ walletAddress, signature })),
    ).rejects.toThrow(/already has a wallet/);
  });
});

function makeRequestSentReceipt(
  requestId: bigint,
  sender: string,
  receiver: string,
): ethers.TransactionReceipt {
  const iface = new ethers.Interface(MAILBOX_ABI);
  const requestSentTopic = iface.getEvent("RequestSent")?.topicHash;
  if (!requestSentTopic) {
    throw new Error("RequestSent event not found in mailbox ABI");
  }

  return {
    to: "0x1111111111111111111111111111111111111111",
    status: 1,
    logs: [
      {
        address: "0x1111111111111111111111111111111111111111",
        topics: [
          requestSentTopic,
          ethers.zeroPadValue(ethers.toBeHex(requestId), 32),
          ethers.zeroPadValue(sender, 32),
          ethers.zeroPadValue(receiver, 32),
        ],
        data: "0x",
      },
    ],
  } as unknown as ethers.TransactionReceipt;
}

describe("publishChatRequestHandler", () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    getTransactionReceiptSpy.mockReset();
  });

  it("rejects when the sender profile is missing", async () => {
    getMock.mockResolvedValue({ exists: () => false, val: () => null });

    await expect(
      publishChatRequestHandler(makeRequest({ txHash: "0x" + "a".repeat(64) })),
    ).rejects.toThrow(/profile not found/);
  });

  it("publishes a chat request record after a valid mailbox transaction", async () => {
    const sender = "0x1234567890123456789012345678901234567890";
    const receiver = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const requestId = 12345n;
    const txHash = "0x" + "a".repeat(64);

    getMock.mockImplementation((path: string) => {
      if (path === "users/test-uid") {
        return { exists: () => true, val: () => ({ walletAddress: sender }) };
      }
      if (path === `walletAddresses/${receiver.toLowerCase()}`) {
        return { exists: () => true, val: () => ({ uid: "receiver-uid" }) };
      }
      return { exists: () => false, val: () => null };
    });
    getTransactionReceiptSpy.mockResolvedValue(
      makeRequestSentReceipt(requestId, sender, receiver),
    );

    const result = await publishChatRequestHandler(makeRequest({ txHash }));

    expect(result).toEqual({
      success: true,
      requestId: requestId.toString(),
      receiverUid: "receiver-uid",
    });
    expect(setMock).toHaveBeenCalledWith(
      `requests/${requestId.toString()}`,
      expect.objectContaining({
        senderUid: "test-uid",
        receiverUid: "receiver-uid",
        senderAddress: sender,
      }),
    );
  });

  it("saves the request even when the receiver wallet is not linked", async () => {
    const sender = "0x1234567890123456789012345678901234567890";
    const receiver = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const txHash = "0x" + "a".repeat(64);
    const requestId = 1n;

    getMock.mockImplementation((path: string) => {
      if (path === "users/test-uid") {
        return { exists: () => true, val: () => ({ walletAddress: sender }) };
      }
      return { exists: () => false, val: () => null };
    });
    getTransactionReceiptSpy.mockResolvedValue(
      makeRequestSentReceipt(requestId, sender, receiver),
    );

    const result = await publishChatRequestHandler(makeRequest({ txHash }));

    expect(result).toEqual({
      success: true,
      requestId: requestId.toString(),
      receiverUid: undefined,
    });
    const savedCall = setMock.mock.calls.find(
      ([path]) => path === `requests/${requestId.toString()}`,
    );
    expect(savedCall).toBeDefined();
    const savedValue = savedCall?.[1] as Record<string, unknown>;
    expect(savedValue).toMatchObject({
      senderUid: "test-uid",
      senderAddress: sender,
      receiverAddress: ethers.getAddress(receiver),
      createdAt: expect.any(Number),
    });
    expect(savedValue).not.toHaveProperty("receiverUid");
  });
});

describe("verifyFCCOnboardingHandler", () => {
  beforeEach(() => {
    getMock.mockReset();
    getTransactionReceiptSpy.mockReset();
    contractRequestsSpy.mockReset();
    updateMock.mockReset();
  });

  it("rejects unauthenticated callers", async () => {
    await expect(
      verifyFCCOnboardingHandler({
        auth: undefined,
        data: { txHash: "0x" + "a".repeat(64) },
        rawRequest: {} as any,
        instanceIdToken: "",
        app: {} as any,
        id: "test-id",
      }),
    ).rejects.toThrow(HttpsError);
  });

  it("rejects when the profile is missing", async () => {
    getMock.mockResolvedValue({ exists: () => false, val: () => null });

    await expect(
      verifyFCCOnboardingHandler(makeRequest({ txHash: "0x" + "a".repeat(64) })),
    ).rejects.toThrow(/profile not found/);
  });

  it("writes verified flags after a valid attested transaction", async () => {
    const sender = "0x1234567890123456789012345678901234567890";
    const receiver = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const txHash = "0x" + "a".repeat(64);
    const requestId = 999n;

    getMock.mockImplementation((path: string) => {
      if (path === "users/test-uid") {
        return {
          exists: () => true,
          val: () => ({
            uid: "test-uid",
            username: "test",
            walletAddress: sender,
          }),
        };
      }
      return { exists: () => false, val: () => null };
    });
    getTransactionReceiptSpy.mockResolvedValue(
      makeRequestSentReceipt(requestId, sender, receiver),
    );
    contractRequestsSpy.mockResolvedValue({
      sender,
      receiver,
      encryptedPreviewMessage: "0x",
      isVerifiedHuman: true,
      isOldEnoughWallet: true,
      accepted: false,
      isRevealed: false,
      expirationTime: 0n,
    });

    const result = await verifyFCCOnboardingHandler(makeRequest({ txHash }));

    expect(result).toEqual({
      success: true,
      isVerifiedHuman: true,
      isOldEnoughWallet: true,
    });
    expect(updateMock).toHaveBeenCalledWith(
      "users/test-uid",
      expect.objectContaining({
        isVerifiedHuman: true,
        isOldEnoughWallet: true,
        verificationTxHash: txHash,
      }),
    );
  });

  it("rejects an invalid transaction hash", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "users/test-uid") {
        return {
          exists: () => true,
          val: () => ({
            uid: "test-uid",
            username: "test",
            walletAddress: "0x1234567890123456789012345678901234567890",
          }),
        };
      }
      return { exists: () => false, val: () => null };
    });

    await expect(
      verifyFCCOnboardingHandler(makeRequest({ txHash: "not-a-hash" })),
    ).rejects.toThrow(/valid transaction hash/);
  });
});

describe("username helpers", () => {
  it("normalizes usernames", () => {
    expect(normalizeUsername("Hello World!!")).toBe("hello-world");
    expect(normalizeUsername("UPPER_CASE-123")).toBe("upper-case-123");
  });

  it("validates username rules", () => {
    expect(() => validateUsername("ab")).toThrow(HttpsError);
    expect(() => validateUsername("valid_user-1")).not.toThrow();
  });
});

describe("assertProfileWalletMatches", () => {
  it("throws when no wallet is linked", () => {
    expect(() => assertProfileWalletMatches({} as any, "0x1234".padEnd(42, "0"))).toThrow(
      /wallet/,
    );
  });

  it("throws when wallet does not match", () => {
    expect(() =>
      assertProfileWalletMatches(
        { walletAddress: "0x1234567890123456789012345678901234567890" },
        "0x0987654321098765432109876543210987654321",
      ),
    ).toThrow(/does not match/);
  });

  it("passes when wallet matches", () => {
    expect(() =>
      assertProfileWalletMatches(
        { walletAddress: "0x1234567890123456789012345678901234567890" },
        "0x1234567890123456789012345678901234567890",
      ),
    ).not.toThrow();
  });
});

describe("switchLinkedWalletHandler", () => {
  beforeEach(() => {
    getMock.mockReset();
    getTransactionReceiptSpy.mockReset();
    contractRequestsSpy.mockReset();
    transactionMock.mockReset();
  });

  function mockVerifiedProfile(walletAddress: string) {
    getMock.mockImplementation((path: string) => {
      if (path === "users/test-uid") {
        return {
          exists: () => true,
          val: () => ({
            uid: "test-uid",
            username: "test",
            walletAddress,
            verifiedAt: Date.now(),
            isVerifiedHuman: true,
            isOldEnoughWallet: true,
          }),
        };
      }
      return { exists: () => false, val: () => null };
    });
  }

  function mockSwitchTransaction(opts: { newAddressTakenBy?: string } = {}) {
    transactionMock.mockImplementation(async (updateFn: any) => {
      const currentData: Record<string, unknown> = {
        users: {
          "test-uid": {
            uid: "test-uid",
            username: "test",
            walletAddress: "0x1234567890123456789012345678901234567890",
            verifiedAt: Date.now(),
            isVerifiedHuman: true,
            isOldEnoughWallet: true,
          },
        },
        walletAddresses: {
          "0x1234567890123456789012345678901234567890": { uid: "test-uid", linkedAt: Date.now() },
        },
      };
      if (opts.newAddressTakenBy) {
        const newWalletAddress = (await TEST_WALLET.getAddress()).toLowerCase();
        (currentData["walletAddresses"] as Record<string, unknown>)[newWalletAddress] = {
          uid: opts.newAddressTakenBy,
          linkedAt: Date.now(),
        };
      }
      const result = updateFn(currentData);
      if (result === undefined) {
        return { committed: false, snapshot: { val: () => currentData } };
      }
      return { committed: true, snapshot: { val: () => result } };
    });
  }

  it("rejects unauthenticated callers", async () => {
    await expect(
      switchLinkedWalletHandler({
        auth: undefined,
        data: { walletAddress: "0x" + "1".repeat(40), signature: "0x", txHash: "0x" + "a".repeat(64) },
        rawRequest: {} as any,
        instanceIdToken: "",
        app: {} as any,
        id: "test-id",
      }),
    ).rejects.toThrow(HttpsError);
  });

  it("rejects when the profile is missing", async () => {
    getMock.mockResolvedValue({ exists: () => false, val: () => null });

    await expect(
      switchLinkedWalletHandler(
        makeRequest({ walletAddress: "0x" + "1".repeat(40), signature: "0x", txHash: "0x" + "a".repeat(64) }),
      ),
    ).rejects.toThrow(/profile not found/);
  });

  it("rejects when the profile has not been verified", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "users/test-uid") {
        return {
          exists: () => true,
          val: () => ({
            uid: "test-uid",
            username: "test",
            walletAddress: "0x1234567890123456789012345678901234567890",
            verifiedAt: null,
          }),
        };
      }
      return { exists: () => false, val: () => null };
    });

    await expect(
      switchLinkedWalletHandler(
        makeRequest({ walletAddress: "0x" + "1".repeat(40), signature: "0x", txHash: "0x" + "a".repeat(64) }),
      ),
    ).rejects.toThrow(/verified before switching/);
  });

  it("rejects a mismatched signature", async () => {
    const newWalletAddress = await TEST_WALLET.getAddress();
    mockVerifiedProfile("0x1234567890123456789012345678901234567890");

    const otherWallet = new ethers.Wallet(
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    );
    const signature = await otherWallet.signMessage("wrong message");

    await expect(
      switchLinkedWalletHandler(
        makeRequest({ walletAddress: newWalletAddress, signature, txHash: "0x" + "a".repeat(64) }),
      ),
    ).rejects.toThrow(/does not match/);
  });

  it("rejects when the new wallet is already linked to another profile", async () => {
    const newWalletAddress = await TEST_WALLET.getAddress();
    const receiver = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const txHash = "0x" + "a".repeat(64);
    const requestId = 888n;
    const message = `Switch wallet to ${newWalletAddress.toLowerCase()} for KnockKnock account test-uid`;
    const signature = await TEST_WALLET.signMessage(message);

    mockVerifiedProfile("0x1234567890123456789012345678901234567890");
    mockSwitchTransaction({ newAddressTakenBy: "other-uid" });
    getTransactionReceiptSpy.mockResolvedValue(
      makeRequestSentReceipt(requestId, newWalletAddress, receiver),
    );
    contractRequestsSpy.mockResolvedValue({
      sender: newWalletAddress,
      receiver,
      encryptedPreviewMessage: "0x",
      isVerifiedHuman: true,
      isOldEnoughWallet: true,
      accepted: false,
      isRevealed: false,
      expirationTime: 0n,
    });

    await expect(
      switchLinkedWalletHandler(
        makeRequest({ walletAddress: newWalletAddress, signature, txHash }),
      ),
    ).rejects.toThrow(/Wallet switch conflict/);
  });

  it("switches the linked wallet after a valid verification transaction", async () => {
    const oldWalletAddress = "0x1234567890123456789012345678901234567890";
    const newWalletAddress = await TEST_WALLET.getAddress();
    const receiver = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const txHash = "0x" + "a".repeat(64);
    const requestId = 777n;

    const message = `Switch wallet to ${newWalletAddress.toLowerCase()} for KnockKnock account test-uid`;
    const signature = await TEST_WALLET.signMessage(message);

    mockVerifiedProfile(oldWalletAddress);
    mockSwitchTransaction();
    getTransactionReceiptSpy.mockResolvedValue(
      makeRequestSentReceipt(requestId, newWalletAddress, receiver),
    );
    contractRequestsSpy.mockResolvedValue({
      sender: newWalletAddress,
      receiver,
      encryptedPreviewMessage: "0x",
      isVerifiedHuman: true,
      isOldEnoughWallet: true,
      accepted: false,
      isRevealed: false,
      expirationTime: 0n,
    });

    const result = await switchLinkedWalletHandler(
      makeRequest({ walletAddress: newWalletAddress, signature, txHash }),
    );

    expect(result).toEqual({
      success: true,
      walletAddress: newWalletAddress,
      isVerifiedHuman: true,
      isOldEnoughWallet: true,
    });
    expect(transactionMock).toHaveBeenCalledOnce();
  });
});
