import { ethers } from "ethers";
import { getReadProvider } from "./provider";
import KnockKnockMailboxArtifact from "./abis/KnockKnockMailbox.json";
import KnockKnockFCCVerifierArtifact from "./abis/KnockKnockFCCVerifier.json";

// Hardhat artifacts wrap the ABI array in an `abi` key, but some ABI files
// are already the plain ABI array. Normalize both to a plain array so ethers
// receives a valid ABI regardless of the source format.
function unwrapAbi(artifact: any): any[] {
  if (Array.isArray(artifact)) return artifact;
  if (artifact && Array.isArray(artifact.abi)) return artifact.abi;
  throw new Error("Contract ABI file is not a valid ABI array or Hardhat artifact");
}

const KnockKnockMailboxAbi = unwrapAbi(KnockKnockMailboxArtifact);
const KnockKnockFCCVerifierAbi = unwrapAbi(KnockKnockFCCVerifierArtifact);

/**
 * Deployed KnockKnockMailbox address.
 *
 * IMPORTANT: Replace this with the address produced by:
 *   npx hardhat run scripts/deploy.js --network coston2
 * The value below is a placeholder and must be updated before using the dApp
 * on Coston2. For local Hardhat testing, set this to the address printed by
 * `npx hardhat run scripts/deploy.js --network hardhat`.
 */
export const MAILBOX_ADDRESS =
  process.env.NEXT_PUBLIC_MAILBOX_ADDRESS ?? "";

/**
 * Deployed KnockKnockFCCVerifier address.
 *
 * IMPORTANT: Replace this with the address produced by:
 *   npx hardhat run scripts/deployFCC.js --network coston2
 */
export const FCC_VERIFIER_ADDRESS =
  process.env.NEXT_PUBLIC_FCC_VERIFIER_ADDRESS ?? "";

export const MAILBOX_ABI = KnockKnockMailboxAbi;
export const FCC_VERIFIER_ABI = KnockKnockFCCVerifierAbi;

const PLACEHOLDER_ADDRESS = "0x" + "0".repeat(40);

function assertMailboxConfigured() {
  if (!MAILBOX_ADDRESS || MAILBOX_ADDRESS === PLACEHOLDER_ADDRESS) {
    throw new Error(
      "MAILBOX_ADDRESS is not configured. Set NEXT_PUBLIC_MAILBOX_ADDRESS in a .env.local file."
    );
  }
}

function assertVerifierConfigured() {
  if (!FCC_VERIFIER_ADDRESS || FCC_VERIFIER_ADDRESS === PLACEHOLDER_ADDRESS) {
    throw new Error(
      "FCC_VERIFIER_ADDRESS is not configured. Set NEXT_PUBLIC_FCC_VERIFIER_ADDRESS in frontend/.env.local."
    );
  }
}

/**
 * Get a read-only mailbox contract instance.
 */
export function getMailboxContractRead(): ethers.Contract {
  assertMailboxConfigured();
  return new ethers.Contract(MAILBOX_ADDRESS, MAILBOX_ABI, getReadProvider());
}

/**
 * Get a mailbox contract instance connected to a signer.
 */
export function getMailboxContractWrite(
  signer: ethers.Signer
): ethers.Contract {
  assertMailboxConfigured();
  return new ethers.Contract(MAILBOX_ADDRESS, MAILBOX_ABI, signer);
}

/**
 * Get a read-only FCC verifier contract instance.
 */
export function getFCCVerifierContractRead(): ethers.Contract {
  assertVerifierConfigured();
  return new ethers.Contract(
    FCC_VERIFIER_ADDRESS,
    FCC_VERIFIER_ABI,
    getReadProvider()
  );
}

/**
 * Get an FCC verifier contract instance connected to a signer.
 */
export function getFCCVerifierContractWrite(
  signer: ethers.Signer
): ethers.Contract {
  assertVerifierConfigured();
  return new ethers.Contract(FCC_VERIFIER_ADDRESS, FCC_VERIFIER_ABI, signer);
}
