import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import OnboardingWizard from "./OnboardingWizard";

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

vi.mock("@/context/Web3Context", () => ({
  useWeb3: vi.fn(),
}));

vi.mock("@/lib/firebaseProfile", () => ({
  isUsernameAvailable: vi.fn(() => Promise.resolve(true)),
  getUserProfile: getUserProfileMock,
  encodeUsername: (u: string) => u.toLowerCase(),
}));

vi.mock("@/lib/firebaseFunctions", () => ({
  reserveUsernameAndCreateProfile: vi.fn(),
  linkWallet: vi.fn(),
  verifyOnboarding: vi.fn(),
}));

vi.mock("@/lib/runFCCVerification", () => ({
  runFCCVerification: vi.fn(),
}));

import { useFirebaseAuth } from "@/context/FirebaseAuthContext";
import { useWeb3 } from "@/context/Web3Context";

function mockAuth(
  user: { uid: string } | null,
  loading = false,
  error: string | null = null,
) {
  (useFirebaseAuth as any).mockReturnValue({
    user,
    loading,
    error,
    signInWithGoogle: vi.fn(),
    signInWithEmail: vi.fn(),
    signUpWithEmail: vi.fn(),
  });
}

function mockWeb3(overrides = {}) {
  (useWeb3 as any).mockReturnValue({
    address: null,
    chainId: null,
    signer: null,
    connect: vi.fn(),
    ...overrides,
  });
}

describe("OnboardingWizard step determination", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    getUserProfileMock.mockReset();
  });

  it("shows the auth step when the user is not signed in", () => {
    mockAuth(null, false);
    mockWeb3();

    render(<OnboardingWizard />);
    expect(screen.getByText("Welcome to KnockKnock 👋")).toBeInTheDocument();
  });

  it("renders the login form while auth is still loading", () => {
    mockAuth(null, true);
    mockWeb3();

    render(<OnboardingWizard />);
    expect(screen.getByText("Welcome to KnockKnock 👋")).toBeInTheDocument();
    expect(
      screen.getByText(/Authentication is initializing/i),
    ).toBeInTheDocument();
  });

  it("disables the auth form while the user profile is loading", async () => {
    mockAuth({ uid: "user-123" }, false);
    mockWeb3();
    getUserProfileMock.mockReturnValue(new Promise(() => {}));

    render(<OnboardingWizard />);
    await waitFor(() =>
      expect(screen.getByText("Loading your profile…")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /Sign in with Google/i }),
    ).toBeDisabled();
  });

  it("shows the username step when the profile has no username", async () => {
    mockAuth({ uid: "user-123" }, false);
    mockWeb3();
    getUserProfileMock.mockResolvedValue({
      uid: "user-123",
      username: null,
    });

    render(<OnboardingWizard />);
    await waitFor(() =>
      expect(screen.getByText("Choose a username")).toBeInTheDocument(),
    );
  });

  it("shows the wallet step when the profile has a username but no wallet", async () => {
    mockAuth({ uid: "user-123" }, false);
    mockWeb3();
    getUserProfileMock.mockResolvedValue({
      uid: "user-123",
      username: "test_user",
      walletAddress: null,
    });

    render(<OnboardingWizard />);
    await waitFor(() =>
      expect(screen.getByText("Connect your Flare wallet")).toBeInTheDocument(),
    );
  });

  it("shows the verify step when the profile has a wallet but is not verified", async () => {
    mockAuth({ uid: "user-123" }, false);
    mockWeb3({
      address: "0x1234567890123456789012345678901234567890",
      chainId: 114,
    });
    getUserProfileMock.mockResolvedValue({
      uid: "user-123",
      username: "test_user",
      walletAddress: "0x1234567890123456789012345678901234567890",
      verifiedAt: null,
    });

    render(<OnboardingWizard />);
    await waitFor(() =>
      expect(screen.getByText("Verify your identity")).toBeInTheDocument(),
    );
  });

  it("redirects verified users to /send", async () => {
    mockAuth({ uid: "user-123" }, false);
    mockWeb3({
      address: "0x1234567890123456789012345678901234567890",
      chainId: 114,
    });
    getUserProfileMock.mockResolvedValue({
      uid: "user-123",
      username: "test_user",
      walletAddress: "0x1234567890123456789012345678901234567890",
      verifiedAt: Date.now(),
      isVerifiedHuman: true,
      isOldEnoughWallet: true,
    });

    render(<OnboardingWizard />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/send"));
  });

  it("keeps users on the verify step when verification flags are false", async () => {
    mockAuth({ uid: "user-123" }, false);
    mockWeb3({
      address: "0x1234567890123456789012345678901234567890",
      chainId: 114,
    });
    getUserProfileMock.mockResolvedValue({
      uid: "user-123",
      username: "test_user",
      walletAddress: "0x1234567890123456789012345678901234567890",
      verifiedAt: Date.now(),
      isVerifiedHuman: false,
      isOldEnoughWallet: false,
    });

    render(<OnboardingWizard />);
    await waitFor(() =>
      expect(screen.getByText("Verify your identity")).toBeInTheDocument(),
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("shows the Firebase auth context error in the onboarding wizard", () => {
    mockAuth(null, false, "Authentication service unavailable.");
    mockWeb3();

    render(<OnboardingWizard />);
    expect(
      screen.getByText("Authentication service unavailable."),
    ).toBeInTheDocument();
  });

  it("shows an error when the user profile cannot be loaded", async () => {
    mockAuth({ uid: "user-123" }, false);
    mockWeb3();
    getUserProfileMock.mockRejectedValue(new Error("Network error"));

    render(<OnboardingWizard />);
    await waitFor(() =>
      expect(
        screen.getByText(
          "Could not load your profile. Please refresh and try again.",
        ),
      ).toBeInTheDocument(),
    );
  });
});
