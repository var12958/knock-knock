const { ethers, network, run } = require("hardhat");
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
 * @notice Deploy the KnockKnockMailbox contract.
 * @dev Run with:
 *      npx hardhat run scripts/deploy.js --network coston2
 *      or for local testing:
 *      npx hardhat run scripts/deploy.js --network hardhat
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying KnockKnockMailbox with account:", deployer.address);
  console.log(
    "Account balance:",
    (await deployer.provider.getBalance(deployer.address)).toString()
  );

  const KnockKnockMailbox = await ethers.getContractFactory(
    "KnockKnockMailbox"
  );
  const mailbox = await KnockKnockMailbox.deploy();

  // Wait for deployment to finish (Ethers v6 style).
  await mailbox.waitForDeployment();

  const contractAddress = await mailbox.getAddress();
  console.log("KnockKnockMailbox deployed to:", contractAddress);

  // Persist deployment metadata for the frontend and hackathon demo.
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const artifactPath = path.join(deploymentsDir, `${network.name}.json`);
  const artifact = {
    network: network.name,
    chainId: network.config.chainId,
    contractName: "KnockKnockMailbox",
    address: contractAddress,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  console.log("Deployment artifact written to:", artifactPath);

  // Keep .env and the frontend env in sync so the dApp picks up the new address.
  const rootEnv = path.join(__dirname, "..", ".env");
  const frontendEnv = path.join(__dirname, "..", "frontend", ".env.local");
  upsertEnv(rootEnv, "MAILBOX_ADDRESS", contractAddress);
  if (fs.existsSync(frontendEnv)) {
    upsertEnv(frontendEnv, "NEXT_PUBLIC_MAILBOX_ADDRESS", contractAddress);
    console.log("Updated frontend/.env.local NEXT_PUBLIC_MAILBOX_ADDRESS");
  } else {
    console.log(
      "frontend/.env.local not found — create it from frontend/.env.local.example and set NEXT_PUBLIC_MAILBOX_ADDRESS to:",
      contractAddress
    );
  }

  // Optionally verify the contract on a Flare-compatible explorer.
  // This requires FLARESCAN_API_KEY to be set in the .env file.
  if (network.name === "coston2" && process.env.FLARESCAN_API_KEY) {
    console.log("Waiting for block confirmations before verification...");
    try {
      await run("verify:verify", {
        address: contractAddress,
        constructorArguments: [],
      });
      console.log("Contract verified successfully");
    } catch (error) {
      console.warn("Verification failed or not supported:", error.message);
    }
  } else {
    console.log(
      "Skipping verification. Set FLARESCAN_API_KEY in .env to enable it on Coston2."
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
