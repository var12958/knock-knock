import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import RequireVerified from "./RequireVerified";

const { replaceMock, getUserProfileMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  getUserProfileMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

vi.mock("@/context/FirebaseAuthContext", () => ({
  useFirebaseAuth: vi.fn(),
}));

vi.mock("@/lib/firebaseProfile", () => ({
  getUserProfile: getUserProfileMock,
}));

import { useFirebaseAuth } from "@/context/FirebaseAuthContext";

function mockAuth(user: { uid: string } | null, loading = false) {
  (useFirebaseAuth as any).mockReturnValue({ user, loading });
}

describe("RequireVerified", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    getUserProfileMock.mockReset();
  });

  it("redirects unauthenticated users to /onboard", async () => {
    mockAuth(null, false);
    render(<RequireVerified>protected content</RequireVerified>);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/onboard"));
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("redirects users without a verified profile", async () => {
    mockAuth({ uid: "user-123" }, false);
    getUserProfileMock.mockResolvedValue({
      uid: "user-123",
      username: "test",
      walletAddress: null,
      verifiedAt: null,
    });

    render(<RequireVerified>protected content</RequireVerified>);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/onboard"));
  });

  it("renders children for verified users", async () => {
    mockAuth({ uid: "user-123" }, false);
    getUserProfileMock.mockResolvedValue({
      uid: "user-123",
      username: "test",
      walletAddress: "0x1234567890123456789012345678901234567890",
      verifiedAt: Date.now(),
      isVerifiedHuman: true,
      isOldEnoughWallet: true,
    });

    render(<RequireVerified>protected content</RequireVerified>);

    await waitFor(() => expect(screen.getByText("protected content")).toBeInTheDocument());
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("redirects users whose verification flags are false", async () => {
    mockAuth({ uid: "user-123" }, false);
    getUserProfileMock.mockResolvedValue({
      uid: "user-123",
      username: "test",
      walletAddress: "0x1234567890123456789012345678901234567890",
      verifiedAt: Date.now(),
      isVerifiedHuman: false,
      isOldEnoughWallet: false,
    });

    render(<RequireVerified>protected content</RequireVerified>);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/onboard"));
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("shows a spinner while auth is loading", () => {
    mockAuth(null, true);
    render(<RequireVerified>protected content</RequireVerified>);

    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
