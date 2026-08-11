import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import Sidebar from "./Sidebar";

const {
  useWeb3Mock,
  useFirebaseAuthMock,
  getMailboxContractReadMock,
  runMLBehaviorCheckMock,
  formatMLBadgeMock,
  subscribeNicknamesMock,
  subscribeDeletedChatsMock,
  decodePreviewMock,
  usePathnameMock,
} = vi.hoisted(() => ({
  useWeb3Mock: vi.fn(),
  useFirebaseAuthMock: vi.fn(),
  getMailboxContractReadMock: vi.fn(),
  runMLBehaviorCheckMock: vi.fn(),
  formatMLBadgeMock: vi.fn(),
  subscribeNicknamesMock: vi.fn(() => () => {}),
  subscribeDeletedChatsMock: vi.fn(() => () => {}),
  decodePreviewMock: vi.fn((hex: string) => hex.replace(/^0x/, "")),
  usePathnameMock: vi.fn(() => "/"),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: usePathnameMock,
}));

vi.mock("@/context/Web3Context", () => ({
  useWeb3: useWeb3Mock,
}));

vi.mock("@/context/FirebaseAuthContext", () => ({
  useFirebaseAuth: useFirebaseAuthMock,
}));

vi.mock("@/lib/contracts", () => ({
  getMailboxContractRead: getMailboxContractReadMock,
  getMailboxContractWrite: vi.fn(),
}));

vi.mock("@/lib/encodePreview", () => ({
  decodePreview: decodePreviewMock,
}));

vi.mock("@/lib/runMLBehaviorCheck", () => ({
  runMLBehaviorCheck: runMLBehaviorCheckMock,
  formatMLBadge: formatMLBadgeMock,
}));

vi.mock("@/lib/firebaseContacts", () => ({
  subscribeNicknames: subscribeNicknamesMock,
  setNickname: vi.fn(),
}));

vi.mock("@/lib/firebaseDeletedChats", () => ({
  subscribeDeletedChats: subscribeDeletedChatsMock,
  addDeletedChat: vi.fn(),
}));

vi.mock("@/lib/firebase", () => ({
  realtimeDb: null,
}));

const CONNECTED_ADDRESS = "0x1111111111111111111111111111111111111111";
const SENDER_ADDRESS = "0x2222222222222222222222222222222222222222";

function mockWeb3(overrides = {}) {
  useWeb3Mock.mockReturnValue({
    address: CONNECTED_ADDRESS,
    signer: { provider: {} },
    ...overrides,
  });
}

function mockAuth() {
  useFirebaseAuthMock.mockReturnValue({ user: { uid: "user-123" } });
}

function makePendingRequest() {
  return {
    sender: SENDER_ADDRESS,
    receiver: CONNECTED_ADDRESS,
    encryptedPreviewMessage: "0x48656c6c6f",
    isVerifiedHuman: true,
    isOldEnoughWallet: true,
    accepted: false,
    isRevealed: false,
    expirationTime: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("Sidebar pending CHECK button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_FCC_PROXY_URL = "http://localhost:7702/action";
    process.env.NEXT_PUBLIC_TEE_SIGNER_ADDRESS =
      "0x3333333333333333333333333333333333333333";
    mockAuth();
    mockWeb3();

    getMailboxContractReadMock.mockReturnValue({
      nextRequestId: vi.fn().mockResolvedValue(BigInt(2)),
      requests: vi.fn().mockImplementation((id: bigint) => {
        if (id === BigInt(1)) return Promise.resolve(makePendingRequest());
        return Promise.resolve({ receiver: "0x0000000000000000000000000000000000000000" });
      }),
    });

    decodePreviewMock.mockImplementation((hex: string) =>
      hex === "0x48656c6c6f" ? "Hello" : "",
    );

    formatMLBadgeMock.mockReturnValue("Human 95% | Bot 5% — TEE Verified");
  });

  it("calls CHECK_ML_BEHAVIOR via the proxy and shows the verified badge", async () => {
    runMLBehaviorCheckMock.mockResolvedValue({
      humanProbability: 95,
      botProbability: 5,
      explanation: ["Low gas volatility", "Diverse counterparty set"],
      modelVersion: "v1",
      targetAddress: SENDER_ADDRESS,
      signerAddress: "0x tee",
      timestamp: Math.floor(Date.now() / 1000),
      signature: "0x sig",
    });

    render(<Sidebar />);

    const checkButton = await screen.findByRole("button", { name: /CHECK/i });
    expect(checkButton).toBeInTheDocument();

    fireEvent.click(checkButton);

    await waitFor(() => {
      expect(runMLBehaviorCheckMock).toHaveBeenCalledWith(
        "http://localhost:7702/action",
        SENDER_ADDRESS,
        "0x3333333333333333333333333333333333333333",
        expect.any(AbortSignal),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Human 95% | Bot 5% — TEE Verified")).toBeInTheDocument();
    });
  });

  it("shows a loading spinner while the ML check is running", async () => {
    let resolveCheck!: (value: any) => void;
    runMLBehaviorCheckMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );

    render(<Sidebar />);

    const checkButton = await screen.findByRole("button", { name: /CHECK/i });
    fireEvent.click(checkButton);

    await waitFor(() => {
      expect(screen.getByText("...")).toBeInTheDocument();
    });

    resolveCheck({
      humanProbability: 80,
      botProbability: 20,
      explanation: ["Some activity"],
      modelVersion: "v1",
      targetAddress: SENDER_ADDRESS,
      signerAddress: "0x tee",
      timestamp: Math.floor(Date.now() / 1000),
      signature: "0x sig",
    });

    await waitFor(() => {
      expect(screen.queryByText("...")).not.toBeInTheDocument();
    });
  });

  it("displays an error message when the ML check fails", async () => {
    runMLBehaviorCheckMock.mockRejectedValue(
      new Error("FCC proxy returned an invalid ML result."),
    );

    render(<Sidebar />);

    const checkButton = await screen.findByRole("button", { name: /CHECK/i });
    fireEvent.click(checkButton);

    await waitFor(() => {
      expect(
        screen.getByText("FCC proxy returned an invalid ML result."),
      ).toBeInTheDocument();
    });
  });
});
