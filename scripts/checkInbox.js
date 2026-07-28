require("dotenv").config();
const hre = require("hardhat");
const { ethers, network } = hre;

/**
 * Manual diagnostic script for the KnockKnockMailbox inbox.
 *
 * Reads the deployed mailbox address from MAILBOX_ADDRESS (root .env) and
 * prints the pending + historical requests stored for a given receiver. Because
 * `getPendingRequests` requires `msg.sender == _receiver`, the script simulates
 * the call with `from: receiver` so it can inspect any wallet's inbox without
 * needing that wallet's private key.
 *
 * Usage (set WALLET2_ADDRESS first):
 *   PowerShell:
 *     $env:WALLET2_ADDRESS = '0xReceiverAddress'
 *     npx hardhat run scripts/checkInbox.js --network coston2
 *   bash:
 *     WALLET2_ADDRESS=0xReceiverAddress npx hardhat run scripts/checkInbox.js --network coston2
 */
async function main() {
  const receiver = process.env.WALLET2_ADDRESS;

  if (!receiver || !ethers.isAddress(receiver)) {
    console.error(
      "Please set WALLET2_ADDRESS to a valid receiver address before running this script."
    );
    console.error(
      "Example (PowerShell): $env:WALLET2_ADDRESS = '0x1234...'; npx hardhat run scripts/checkInbox.js --network coston2"
    );
    console.error(
      "Example (bash): WALLET2_ADDRESS=0x1234... npx hardhat run scripts/checkInbox.js --network coston2"
    );
    process.exit(1);
  }

  const mailboxAddress = process.env.MAILBOX_ADDRESS;
  if (!mailboxAddress || !ethers.isAddress(mailboxAddress)) {
    console.error(
      "MAILBOX_ADDRESS is missing or invalid in the environment / .env file."
    );
    process.exit(1);
  }

  console.log("Network:", network.name, "(chainId:", network.config.chainId, ")");
  console.log("Mailbox address:", mailboxAddress);
  console.log("Receiver address:", receiver);

  const artifact = await hre.artifacts.readArtifact("KnockKnockMailbox");
  const iface = new ethers.Interface(artifact.abi);

  // Helper: simulate a view call as a specific `from` address.
  async function callView(functionName, args, from) {
    const data = iface.encodeFunctionData(functionName, args);
    const callTx = { to: mailboxAddress, data };
    if (from) callTx.from = from;
    const result = await ethers.provider.call(callTx);
    if (!result || result === "0x") {
      throw new Error(
        `Empty response from ${mailboxAddress}. Verify the contract is deployed on ${network.name}.`
      );
    }
    return iface.decodeFunctionResult(functionName, result)[0];
  }

  // getPendingRequestIds and getPendingRequests both enforce msg.sender == _receiver.
  const ids = await callView("getPendingRequestIds", [receiver, 0, 20], receiver);
  const pending = await callView("getPendingRequests", [receiver, 0, 20], receiver);

  console.log("\n=== PENDING (not accepted, not expired) ===");
  console.log("Pending request IDs:", ids.map((id) => id.toString()));
  console.log("Pending request count:", pending.length);

  if (pending.length === 0) {
    console.log("No pending requests found for this receiver.");
  } else {
    pending.forEach((req, i) => {
      console.log(`\n[${i}] Request ID ${ids[i].toString()}:`);
      printRequest(req);
    });
  }

  // Try the new history getter. If the deployed contract predates it, fall back
  // to scanning all request IDs.
  console.log("\n=== HISTORY (accepted + any non-pending requests) ===");
  try {
    const [historyIds, history] = await callView(
      "getRequestsByReceiver",
      [receiver, 0, 20],
      receiver
    );
    console.log("History request count:", history.length);
    if (history.length === 0) {
      console.log("No request history found for this receiver.");
    } else {
      history.forEach((req, i) => {
        console.log(`\n[${i}] Historical request ID ${historyIds[i].toString()}:`);
        printRequest(req);
      });
    }
  } catch (historyErr) {
    console.warn(
      "getRequestsByReceiver not available on deployed contract (%s). " +
        "Redeploy with the updated KnockKnockMailbox.sol to enable history view.",
      historyErr.reason ?? historyErr.message
    );
    console.log("Falling back to scanning all request IDs...");

    const total = await callView("getTotalRequestCount", []);
    const totalNum = Number(total);

    // Use an ethers.Contract instance for struct-return decoding; it preserves
    // named field access better than raw Interface.decodeFunctionResult.
    const contract = new ethers.Contract(mailboxAddress, artifact.abi, ethers.provider);

    let found = 0;
    for (let i = 1; i <= totalNum && found < 20; i++) {
      try {
        const req = await contract.requests(i);
        if (req.receiver.toLowerCase() === receiver.toLowerCase()) {
          console.log(`\n[${found}] Request ID ${i}:`);
          printRequest(req);
          found++;
        }
      } catch (readErr) {
        // ID may not exist; skip.
        console.warn(`Could not read request ${i}:`, readErr.message);
      }
    }
    if (found === 0) {
      console.log("No requests for this receiver found by scanning all IDs.");
    }
  }

  const total = await callView("getTotalRequestCount", []);
  console.log("\nTotal requests ever created (nextRequestId - 1):", total.toString());
}

function printRequest(req) {
  const now = Math.floor(Date.now() / 1000);
  const expired = now > Number(req.expirationTime);
  console.log("  sender:", req.sender);
  console.log("  receiver:", req.receiver);
  console.log("  accepted:", req.accepted);
  console.log("  isRevealed:", req.isRevealed);
  console.log("  expired:", expired, "(expirationTime:", req.expirationTime.toString(), ")");
  console.log("  isVerifiedHuman:", req.isVerifiedHuman);
  console.log("  isOldEnoughWallet:", req.isOldEnoughWallet);
  console.log("  preview:", req.encryptedPreviewMessage);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("checkInbox failed:", error);
    process.exit(1);
  });
