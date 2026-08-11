import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import SendRequestForm from "./SendRequestForm";

const { useWeb3Mock } = vi.hoisted(() => ({
  useWeb3Mock: vi.fn(),
}));

vi.mock("@/context/Web3Context", () => ({
  useWeb3: useWeb3Mock,
}));

vi.mock("@/context/FirebaseAuthContext", () => ({
  useFirebaseAuth: () => ({ user: null }),
}));

vi.mock("@/lib/contracts", () => ({
  getMailboxContractWrite: vi.fn(),
  getFCCVerifierContractWrite: vi.fn(),
  MAILBOX_ADDRESS: "0x0000000000000000000000000000000000000001",
  MAILBOX_ABI: [],
  FCC_VERIFIER_ADDRESS: "0x0000000000000000000000000000000000000002",
  FCC_VERIFIER_ABI: [],
}));

vi.mock("@/lib/encodePreview", () => ({
  encodePreview: (text: string) => `0x${Buffer.from(text).toString("hex")}`,
}));

vi.mock("@/lib/firebaseFunctions", () => ({
  publishChatRequest: vi.fn(),
}));

vi.mock("@/lib/firebase", () => ({
  realtimeDb: null,
}));

function mockWeb3(overrides = {}) {
  useWeb3Mock.mockReturnValue({
    signer: { provider: {} },
    address: "0x1111111111111111111111111111111111111111",
    chainId: 114,
    ...overrides,
  });
}

describe("SendRequestForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_FCC_PROXY_URL = "http://localhost:7702/action";
  });

  it("resets form fields when the connected wallet address changes", async () => {
    mockWeb3({ address: "0x1111111111111111111111111111111111111111" });
    const { rerender } = render(<SendRequestForm />);

    const receiversInput = screen.getByLabelText(/Receiver address/i);
    const previewInput = screen.getByLabelText(/Encrypted preview message/i);

    fireEvent.change(receiversInput, {
      target: { value: "0x2222222222222222222222222222222222222222" },
    });
    fireEvent.change(previewInput, {
      target: { value: "Hello from account one" },
    });

    expect(receiversInput).toHaveValue(
      "0x2222222222222222222222222222222222222222",
    );
    expect(previewInput).toHaveValue("Hello from account one");

    mockWeb3({ address: "0x3333333333333333333333333333333333333333" });
    rerender(<SendRequestForm />);

    await waitFor(() => {
      expect(receiversInput).toHaveValue("");
      expect(previewInput).toHaveValue("");
    });
  });
});
