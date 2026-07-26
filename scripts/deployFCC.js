const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * @notice Update an environment variable in a .env-style file.
 * @param {string} filePath Path to the env file.
 * @param {string} key Variable name to update.
 * @param {string} value New value for the variable.
 */
function upsertEnv(filePath, key, value) {
  let content = "";
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, "utf8");
  }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedKey}=.*$`, "m");

  if (pattern.test(content)) {
    content = content.replace(pattern, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}\n`;
  }

  fs.writeFileSync(filePath, content);
}

/**
 * @notice Strictly validate a value is a 0x-prefixed 40-hex-character address.
 * @param {*} value Value to check.
 * @returns {boolean}
 */
function isValidHexAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * @notice Read a required address env var. Throws if missing or invalid.
 * @param {string} key Env var name.
 * @returns {string} A valid 0x hex address.
 */
function getRequiredAddress(key) {
  const raw = process.env[key];
  if (!isValidHexAddress(raw)) {
    throw new Error(
      `${key} must be set to a valid 0x hex address in .env (got "${raw}").`
    );
  }
  return raw;
}

/**
 * @notice Read a positive integer from an environment variable.
 * @dev Falls back to the provided value if the env var is missing or not a
 *      valid non-negative integer. Used for the FCC extension ID.
 *
 * @param {string} key Env var name.
 * @param {number|string} fallback Fallback value to use.
 * @returns {bigint} A non-negative integer.
 */
function getPositiveIntegerEnvOrFallback(key, fallback) {
  const raw = process.env[key];
  const fallbackBigInt = BigInt(fallback ?? 0);

  if (!raw || raw.trim() === "") {
    console.warn(
      `⚠️  ${key} is not set. Using fallback ${fallbackBigInt.toString()}.`
    );
    return fallbackBigInt;
  }

  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    console.warn(
      `⚠️  ${key}="${raw}" is not a valid integer. Using fallback ${fallbackBigInt.toString()}.`
    );
    return fallbackBigInt;
  }

  const value = BigInt(normalized);
  if (value <= 0n) {
    console.warn(
      `⚠️  ${key}="${raw}" must be > 0. Using fallback ${fallbackBigInt.toString()}.`
    );
    return fallbackBigInt;
  }

  return value;
}

/**
 * @notice Deploy the KnockKnockFCCVerifier and link it to the mailbox.
 * @dev Run with:
 *      npx hardhat run scripts/deployFCC.js --network coston2
 *
 * Required environment variables:
 *  - MAILBOX_ADDRESS: already-deployed KnockKnockMailbox address
 *  - TEE_EXTENSION_REGISTRY: Flare TEE Extension Registry address on the target chain
 *  - TEE_MACHINE_REGISTRY: Flare TEE Machine Registry address on the target chain
 *  - TEE_SIGNER_ADDRESS: address derived from the FCC extension's signing key
 *  - EXTENSION_ID: non-zero FCC extension ID registered on-chain
 *
 * For local Hardhat testing, deploy a mailbox first and set the registry
 * addresses to a local mock (see contracts/mocks/MockTeeRegistries.sol).
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying FCC verifier with account:", deployer.address);

  const isLocal = network.name === "hardhat";

  // On non-local networks we MUST have real Flare registry addresses.
  let teeExtensionRegistry;
  let teeMachineRegistry;
  if (isLocal) {
    teeExtensionRegistry =
      process.env.TEE_EXTENSION_REGISTRY ||
      "0x0000000000000000000000000000000000000001";
    teeMachineRegistry =
      process.env.TEE_MACHINE_REGISTRY ||
      "0x0000000000000000000000000000000000000002";
  } else {
    teeExtensionRegistry = getRequiredAddress("TEE_EXTENSION_REGISTRY");
    teeMachineRegistry = getRequiredAddress("TEE_MACHINE_REGISTRY");
  }

  let mailboxAddress = process.env.MAILBOX_ADDRESS;
  if (!isValidHexAddress(mailboxAddress)) {
    if (!isLocal) {
      throw new Error(
        `MAILBOX_ADDRESS must be set to a valid 0x hex address in .env (got "${mailboxAddress}").`
      );
    }
    console.log(
      "MAILBOX_ADDRESS not set; deploying a fresh mailbox for local testing..."
    );

    const MailboxFactory = await ethers.getContractFactory("KnockKnockMailbox");
    const mailbox = await MailboxFactory.deploy();
    await mailbox.waitForDeployment();
    mailboxAddress = await mailbox.getAddress();
    console.log("KnockKnockMailbox deployed to:", mailboxAddress);
  }

  const VerifierFactory = await ethers.getContractFactory("KnockKnockFCCVerifier");
  const verifier = await VerifierFactory.deploy(teeExtensionRegistry, teeMachineRegistry);
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log("KnockKnockFCCVerifier deployed to:", verifierAddress);

  // Set the extension ID. For real Coston2 deployments this must be the ID
  // returned by Flare's TEE extension registry after you register your image.
  const extensionId = getPositiveIntegerEnvOrFallback("EXTENSION_ID", 1);
  const setIdTx = await verifier.setExtensionId(extensionId);
  await setIdTx.wait();
  console.log("KnockKnockFCCVerifier extensionId set to:", extensionId.toString());

  // Set a non-zero fallback TEE machine so the demo still works when the real
  // Flare machine registry has no machines registered for EXTENSION_ID.
  // The deployer address is used as a placeholder; any non-zero address works.
  const fallbackTeeMachine = isLocal
    ? "0x0000000000000000000000000000000000000001"
    : deployer.address;
  const fallbackTx = await verifier.setFallbackTeeMachine(fallbackTeeMachine);
  await fallbackTx.wait();
  console.log("KnockKnockFCCVerifier fallback TEE machine set to:", fallbackTeeMachine);

  // Configure the mailbox to trust proofs signed by the TEE extension.
  const teeSignerAddress = isLocal
    ? process.env.TEE_SIGNER_ADDRESS || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    : getRequiredAddress("TEE_SIGNER_ADDRESS");

  const mailbox = await ethers.getContractAt("KnockKnockMailbox", mailboxAddress);
  const tx = await mailbox.setTEESigner(teeSignerAddress);
  await tx.wait();
  console.log("Mailbox TEE signer set to:", teeSignerAddress);

  // Persist deployment metadata.
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const artifactPath = path.join(deploymentsDir, `${network.name}-fcc.json`);
  const artifact = {
    network: network.name,
    chainId: network.config.chainId,
    mailboxAddress,
    verifierAddress,
    teeExtensionRegistry,
    teeMachineRegistry,
    teeSignerAddress,
    extensionId: extensionId.toString(),
    fallbackTeeMachine,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  console.log("FCC deployment artifact written to:", artifactPath);

  // Keep .env and the frontend env in sync.
  const rootEnv = path.join(__dirname, "..", ".env");
  const frontendEnv = path.join(__dirname, "..", "frontend", ".env.local");
  upsertEnv(rootEnv, "MAILBOX_ADDRESS", mailboxAddress);
  upsertEnv(rootEnv, "TEE_EXTENSION_REGISTRY", teeExtensionRegistry);
  upsertEnv(rootEnv, "TEE_MACHINE_REGISTRY", teeMachineRegistry);
  upsertEnv(rootEnv, "TEE_SIGNER_ADDRESS", teeSignerAddress);
  upsertEnv(rootEnv, "EXTENSION_ID", extensionId.toString());
  upsertEnv(rootEnv, "FALLBACK_TEE_MACHINE", fallbackTeeMachine);
  if (fs.existsSync(frontendEnv)) {
    upsertEnv(frontendEnv, "NEXT_PUBLIC_MAILBOX_ADDRESS", mailboxAddress);
    upsertEnv(frontendEnv, "NEXT_PUBLIC_FCC_VERIFIER_ADDRESS", verifierAddress);
    console.log("Updated frontend/.env.local mailbox and verifier addresses");
  } else {
    console.log(
      "frontend/.env.local not found — create it from frontend/.env.local.example and set:"
    );
    console.log("  NEXT_PUBLIC_MAILBOX_ADDRESS=", mailboxAddress);
    console.log("  NEXT_PUBLIC_FCC_VERIFIER_ADDRESS=", verifierAddress);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("FCC deployment failed:", error);
    process.exit(1);
  });
