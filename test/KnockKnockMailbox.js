const { expect } = require("chai");
const { ethers } = require("hardhat");

// Hardhat default test account #1 — used as the mock TEE signer in tests.
// This is a well-known public test key, not a secret.
const TEE_SIGNER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/**
 * @notice Test suite for KnockKnockMailbox.
 * @dev Uses Hardhat's built-in network and Chai assertions.
 */
describe("KnockKnockMailbox", function () {
  let mailbox;
  let owner;
  let sender;
  let receiver;
  let other;

  const SEVEN_DAYS = 7 * 24 * 60 * 60;
  const ENCRYPTED_PREVIEW = "encrypted-preview-message-123";

  /**
   * @notice Build a TEE attestation for sendRequestWithProof.
   * @dev Mirrors the signing logic in fcc/typescript/src/app/handlers.ts:
   *      requestHash = keccak256(abi.encodePacked(receiver, preview, deadline))
   *      signedHash  = keccak256(abi.encodePacked(chainId, mailbox, sender, isHuman, isOld, requestHash))
   */
  async function buildProof(
    senderAddr,
    receiverAddr,
    preview,
    deadline,
    isHuman,
    isOld,
    mailboxAddr = null,
    chainId = null
  ) {
    const targetMailbox = mailboxAddr ?? (await mailbox.getAddress());
    const id = chainId ?? Number((await ethers.provider.getNetwork()).chainId);
    const requestHash = ethers.keccak256(
      ethers.solidityPacked(
        ["address", "string", "uint256"],
        [receiverAddr, preview, deadline]
      )
    );
    const signedHash = ethers.keccak256(
      ethers.solidityPacked(
        ["uint256", "address", "address", "bool", "bool", "bytes32"],
        [id, targetMailbox, senderAddr, isHuman, isOld, requestHash]
      )
    );
    const signer = new ethers.Wallet(TEE_SIGNER_PRIVATE_KEY);
    const sig = await signer.signingKey.sign(signedHash);
    // Normalize v to 27/28 for ecrecover.
    const v = sig.v < 27 ? sig.v + 27 : sig.v;
    const signature =
      sig.r +
      sig.s.slice(2) +
      v.toString(16).padStart(2, "0");
    return { requestHash, signature, deadline };
  }

  beforeEach(async function () {
    [owner, sender, receiver, other] = await ethers.getSigners();

    const KnockKnockMailbox = await ethers.getContractFactory(
      "KnockKnockMailbox"
    );
    mailbox = await KnockKnockMailbox.deploy();
    await mailbox.waitForDeployment();
  });

  describe("sendRequest", function () {
    it("creates a request with a 7-day expiration", async function () {
      // Arrange
      const tx = await mailbox
        .connect(sender)
        .sendRequest(receiver.address, ENCRYPTED_PREVIEW, true, true);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      // Act
      const request = await mailbox.requests(1);

      // Assert
      expect(request.sender).to.equal(sender.address);
      expect(request.receiver).to.equal(receiver.address);
      expect(request.encryptedPreviewMessage).to.equal(ENCRYPTED_PREVIEW);
      expect(request.isVerifiedHuman).to.equal(true);
      expect(request.isOldEnoughWallet).to.equal(true);
      expect(request.accepted).to.equal(false);
      expect(request.isRevealed).to.equal(false);
      expect(request.expirationTime).to.equal(block.timestamp + SEVEN_DAYS);
    });

    it("emits a RequestSent event", async function () {
      await expect(
        mailbox
          .connect(sender)
          .sendRequest(receiver.address, ENCRYPTED_PREVIEW, false, false)
      )
        .to.emit(mailbox, "RequestSent")
        .withArgs(1, sender.address, receiver.address);
    });

    it("rejects the zero address as receiver", async function () {
      await expect(
        mailbox
          .connect(sender)
          .sendRequest(ethers.ZeroAddress, ENCRYPTED_PREVIEW, true, true)
      ).to.be.revertedWith("Receiver cannot be the zero address");
    });

    it("rejects a self-addressed request", async function () {
      await expect(
        mailbox
          .connect(sender)
          .sendRequest(sender.address, ENCRYPTED_PREVIEW, true, true)
      ).to.be.revertedWith("Cannot send a request to yourself");
    });

    it("rejects an empty preview message", async function () {
      await expect(
        mailbox.connect(sender).sendRequest(receiver.address, "", true, true)
      ).to.be.revertedWith("Preview message cannot be empty");
    });

    it("rejects a preview message exceeding the max length", async function () {
      const longMessage = "a".repeat(1025);
      await expect(
        mailbox
          .connect(sender)
          .sendRequest(receiver.address, longMessage, true, true)
      ).to.be.revertedWith("Preview message too long");
    });

    it("rejects duplicate active requests for the same sender-receiver pair", async function () {
      await mailbox
        .connect(sender)
        .sendRequest(receiver.address, ENCRYPTED_PREVIEW, true, true);

      await expect(
        mailbox
          .connect(sender)
          .sendRequest(receiver.address, "another-message", true, true)
      ).to.be.revertedWith("Active request already exists for this sender-receiver pair");
    });

    it("allows a new request after the previous one is rejected", async function () {
      await mailbox
        .connect(sender)
        .sendRequest(receiver.address, ENCRYPTED_PREVIEW, true, true);
      await mailbox.connect(receiver).rejectRequest(1);

      await expect(
        mailbox
          .connect(sender)
          .sendRequest(receiver.address, "new-message", true, true)
      )
        .to.emit(mailbox, "RequestSent")
        .withArgs(2, sender.address, receiver.address);
    });

    it("enforces the pending requests cap per receiver", async function () {
      // Create 100 pending requests from 100 different senders to the same receiver.
      const signers = await ethers.getSigners();
      for (let i = 0; i < 100; i++) {
        const s = signers[i + 4]; // skip owner, sender, receiver, other
        await mailbox
          .connect(s)
          .sendRequest(receiver.address, `msg-${i}`, true, true);
      }

      // The 101st request should fail.
      await expect(
        mailbox
          .connect(sender)
          .sendRequest(receiver.address, "overflow", true, true)
      ).to.be.revertedWith("Receiver has too many pending requests");
    });
  });

  describe("acceptRequest", function () {
    beforeEach(async function () {
      await mailbox
        .connect(sender)
        .sendRequest(receiver.address, ENCRYPTED_PREVIEW, true, true);
    });

    it("allows only the receiver to accept", async function () {
      // Act
      await mailbox.connect(receiver).acceptRequest(1);

      // Assert
      const request = await mailbox.requests(1);
      expect(request.accepted).to.equal(true);
      expect(request.isRevealed).to.equal(true);
    });

    it("emits a RequestAccepted event", async function () {
      await expect(mailbox.connect(receiver).acceptRequest(1))
        .to.emit(mailbox, "RequestAccepted")
        .withArgs(1, receiver.address);
    });

    it("reverts when a non-receiver tries to accept", async function () {
      await expect(
        mailbox.connect(other).acceptRequest(1)
      ).to.be.revertedWith("Only the receiver can perform this action");
    });

    it("reverts when the request is already accepted", async function () {
      await mailbox.connect(receiver).acceptRequest(1);

      await expect(
        mailbox.connect(receiver).acceptRequest(1)
      ).to.be.revertedWith("Request has already been accepted");
    });

    it("reverts when the request has expired", async function () {
      await ethers.provider.send("evm_increaseTime", [SEVEN_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        mailbox.connect(receiver).acceptRequest(1)
      ).to.be.revertedWith("Request has expired");
    });

    it("removes the request from the receiver's pending list", async function () {
      await mailbox.connect(receiver).acceptRequest(1);

      const pending = await mailbox
        .connect(receiver)
        .getPendingRequests(receiver.address, 0, 20);
      expect(pending.length).to.equal(0);
    });
  });

  describe("rejectRequest", function () {
    beforeEach(async function () {
      await mailbox
        .connect(sender)
        .sendRequest(receiver.address, ENCRYPTED_PREVIEW, true, true);
    });

    it("allows only the receiver to reject and delete the request", async function () {
      // Act
      await mailbox.connect(receiver).rejectRequest(1);

      // Assert
      expect(await mailbox.requestExists(1)).to.equal(false);
    });

    it("emits a RequestRejected event", async function () {
      await expect(mailbox.connect(receiver).rejectRequest(1))
        .to.emit(mailbox, "RequestRejected")
        .withArgs(1, receiver.address);
    });

    it("reverts when a non-receiver tries to reject", async function () {
      await expect(
        mailbox.connect(other).rejectRequest(1)
      ).to.be.revertedWith("Only the receiver can perform this action");
    });

    it("reverts when trying to reject an already accepted request", async function () {
      await mailbox.connect(receiver).acceptRequest(1);

      await expect(
        mailbox.connect(receiver).rejectRequest(1)
      ).to.be.revertedWith("Cannot reject an already accepted request");
    });

    it("removes the request from the receiver's pending list", async function () {
      await mailbox.connect(receiver).rejectRequest(1);

      const pending = await mailbox
        .connect(receiver)
        .getPendingRequests(receiver.address, 0, 20);
      expect(pending.length).to.equal(0);
    });

    it("does not reuse request IDs after deletion", async function () {
      // Send a second request so the first rejection triggers a swap.
      const [, , , , secondSender] = await ethers.getSigners();
      await mailbox
        .connect(secondSender)
        .sendRequest(receiver.address, "second-message", true, true);

      // Reject the first request (ID 1). It should be deleted.
      await mailbox.connect(receiver).rejectRequest(1);
      expect(await mailbox.requestExists(1)).to.equal(false);

      // The second request should still exist at ID 2.
      expect(await mailbox.requestExists(2)).to.equal(true);
      const request = await mailbox.requests(2);
      expect(request.sender).to.equal(secondSender.address);
    });
  });

  describe("getPendingRequests", function () {
    beforeEach(async function () {
      await mailbox
        .connect(sender)
        .sendRequest(receiver.address, ENCRYPTED_PREVIEW, true, true);
      const [, , , , secondSender] = await ethers.getSigners();
      await mailbox
        .connect(secondSender)
        .sendRequest(receiver.address, "second-message", false, true);
    });

    it("returns only unexpired, unaccepted requests for the receiver", async function () {
      const pending = await mailbox
        .connect(receiver)
        .getPendingRequests(receiver.address, 0, 20);

      expect(pending.length).to.equal(2);
      expect(pending[0].encryptedPreviewMessage).to.equal(ENCRYPTED_PREVIEW);
      expect(pending[1].encryptedPreviewMessage).to.equal("second-message");
    });

    it("excludes accepted requests", async function () {
      await mailbox.connect(receiver).acceptRequest(1);

      const pending = await mailbox
        .connect(receiver)
        .getPendingRequests(receiver.address, 0, 20);
      expect(pending.length).to.equal(1);
      expect(pending[0].encryptedPreviewMessage).to.equal("second-message");
    });

    it("excludes expired requests", async function () {
      await ethers.provider.send("evm_increaseTime", [SEVEN_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      const pending = await mailbox
        .connect(receiver)
        .getPendingRequests(receiver.address, 0, 20);
      expect(pending.length).to.equal(0);
    });

    it("does not return requests for other receivers", async function () {
      const pending = await mailbox
        .connect(other)
        .getPendingRequests(other.address, 0, 20);
      expect(pending.length).to.equal(0);
    });

    it("reverts when a non-receiver queries someone else's pending requests", async function () {
      await expect(
        mailbox.connect(other).getPendingRequests(receiver.address, 0, 20)
      ).to.be.revertedWith("Only the receiver can view their pending requests");
    });
  });

  describe("getPendingRequestIds", function () {
    beforeEach(async function () {
      await mailbox
        .connect(sender)
        .sendRequest(receiver.address, ENCRYPTED_PREVIEW, true, true);
      const [, , , , secondSender] = await ethers.getSigners();
      await mailbox
        .connect(secondSender)
        .sendRequest(receiver.address, "second-message", false, true);
    });

    it("returns only pending request IDs for the receiver", async function () {
      const ids = await mailbox
        .connect(receiver)
        .getPendingRequestIds(receiver.address, 0, 20);

      expect(ids.length).to.equal(2);
      expect(ids[0]).to.equal(1n);
      expect(ids[1]).to.equal(2n);
    });

    it("excludes accepted and expired request IDs", async function () {
      await mailbox.connect(receiver).acceptRequest(1);
      await ethers.provider.send("evm_increaseTime", [SEVEN_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      const ids = await mailbox
        .connect(receiver)
        .getPendingRequestIds(receiver.address, 0, 20);
      expect(ids.length).to.equal(0);
    });

    it("reverts when a non-receiver queries someone else's IDs", async function () {
      await expect(
        mailbox.connect(other).getPendingRequestIds(receiver.address, 0, 20)
      ).to.be.revertedWith("Only the receiver can view their pending requests");
    });
  });

  describe("setRequestExpirationDuration", function () {
    it("allows the owner to update the expiration duration", async function () {
      const newDuration = SEVEN_DAYS * 2;

      await expect(
        mailbox.connect(owner).setRequestExpirationDuration(newDuration)
      )
        .to.emit(mailbox, "ExpirationDurationUpdated")
        .withArgs(newDuration);

      expect(await mailbox.requestExpirationDuration()).to.equal(newDuration);
    });

    it("reverts when a non-owner tries to update the duration", async function () {
      await expect(
        mailbox.connect(other).setRequestExpirationDuration(SEVEN_DAYS * 2)
      ).to.be.revertedWithCustomError(mailbox, "OwnableUnauthorizedAccount");
    });

    it("reverts when the new duration is below the minimum", async function () {
      await expect(
        mailbox.connect(owner).setRequestExpirationDuration(30 * 60) // 30 minutes
      ).to.be.revertedWith("Duration out of bounds");
    });

    it("reverts when the new duration is above the maximum", async function () {
      await expect(
        mailbox.connect(owner).setRequestExpirationDuration(365 * 24 * 60 * 60)
      ).to.be.revertedWith("Duration out of bounds");
    });

    it("applies the new duration to subsequent requests", async function () {
      const newDuration = 1 * 24 * 60 * 60; // 1 day
      await mailbox.connect(owner).setRequestExpirationDuration(newDuration);

      const tx = await mailbox
        .connect(sender)
        .sendRequest(receiver.address, ENCRYPTED_PREVIEW, true, true);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const request = await mailbox.requests(1);
      expect(request.expirationTime).to.equal(block.timestamp + newDuration);
    });
  });

  describe("sendRequestWithProof (FCC attestation)", function () {
    beforeEach(async function () {
      const teeSigner = new ethers.Wallet(TEE_SIGNER_PRIVATE_KEY).address;
      await mailbox.connect(owner).setTEESigner(teeSigner);
    });

    it("creates a request when the TEE proof is valid", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + SEVEN_DAYS;
      const { requestHash, signature } = await buildProof(
        sender.address,
        receiver.address,
        ENCRYPTED_PREVIEW,
        deadline,
        true,
        true
      );

      const tx = await mailbox
        .connect(sender)
        .sendRequestWithProof(
          receiver.address,
          ENCRYPTED_PREVIEW,
          true,
          true,
          deadline,
          requestHash,
          signature
        );
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const request = await mailbox.requests(1);
      expect(request.sender).to.equal(sender.address);
      expect(request.receiver).to.equal(receiver.address);
      expect(request.isVerifiedHuman).to.equal(true);
      expect(request.isOldEnoughWallet).to.equal(true);
      expect(request.expirationTime).to.equal(block.timestamp + SEVEN_DAYS);
    });

    it("emits a RequestSent event", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + SEVEN_DAYS;
      const { requestHash, signature } = await buildProof(
        sender.address,
        receiver.address,
        ENCRYPTED_PREVIEW,
        deadline,
        true,
        true
      );

      await expect(
        mailbox
          .connect(sender)
          .sendRequestWithProof(
            receiver.address,
            ENCRYPTED_PREVIEW,
            true,
            true,
            deadline,
            requestHash,
            signature
          )
      )
        .to.emit(mailbox, "RequestSent")
        .withArgs(1, sender.address, receiver.address);
    });

    it("reverts with an invalid TEE signature", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + SEVEN_DAYS;
      const { requestHash } = await buildProof(
        sender.address,
        receiver.address,
        ENCRYPTED_PREVIEW,
        deadline,
        true,
        true
      );
      // Sign with a different key so the recovered address is not the TEE signer.
      const otherSigner = new ethers.Wallet(
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
      );
      const chainId = Number((await ethers.provider.getNetwork()).chainId);
      const wrongSignedHash = ethers.keccak256(
        ethers.solidityPacked(
          ["uint256", "address", "address", "bool", "bool", "bytes32"],
          [chainId, await mailbox.getAddress(), sender.address, true, true, requestHash]
        )
      );
      const wrongSig = await otherSigner.signingKey.sign(wrongSignedHash);
      const wrongSignature =
        wrongSig.r +
        wrongSig.s.slice(2) +
        (wrongSig.v < 27 ? wrongSig.v + 27 : wrongSig.v).toString(16).padStart(2, "0");

      await expect(
        mailbox
          .connect(sender)
          .sendRequestWithProof(
            receiver.address,
            ENCRYPTED_PREVIEW,
            true,
            true,
            deadline,
            requestHash,
            wrongSignature
          )
      ).to.be.revertedWith("Invalid TEE signature");
    });

    it("reverts when the proof is replayed", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + SEVEN_DAYS;
      const { requestHash, signature } = await buildProof(
        sender.address,
        receiver.address,
        ENCRYPTED_PREVIEW,
        deadline,
        true,
        true
      );

      await mailbox
        .connect(sender)
        .sendRequestWithProof(
          receiver.address,
          ENCRYPTED_PREVIEW,
          true,
          true,
          deadline,
          requestHash,
          signature
        );

      await expect(
        mailbox
          .connect(sender)
          .sendRequestWithProof(
            receiver.address,
            ENCRYPTED_PREVIEW,
            true,
            true,
            deadline,
            requestHash,
            signature
          )
      ).to.be.revertedWith("Proof already used");
    });

    it("reverts when TEE signer is not set", async function () {
      const freshMailbox = await (await ethers.getContractFactory("KnockKnockMailbox")).deploy();
      await freshMailbox.waitForDeployment();

      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + SEVEN_DAYS;
      const { requestHash, signature } = await buildProof(
        sender.address,
        receiver.address,
        ENCRYPTED_PREVIEW,
        deadline,
        true,
        true
      );

      await expect(
        freshMailbox
          .connect(sender)
          .sendRequestWithProof(
            receiver.address,
            ENCRYPTED_PREVIEW,
            true,
            true,
            deadline,
            requestHash,
            signature
          )
      ).to.be.revertedWith("TEE signer not configured");
    });

    it("reverts when a non-owner tries to set the TEE signer", async function () {
      await expect(
        mailbox.connect(other).setTEESigner(other.address)
      ).to.be.revertedWithCustomError(mailbox, "OwnableUnauthorizedAccount");
    });

    it("allows a sender to pass one true and one false flag", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + SEVEN_DAYS;
      const { requestHash, signature } = await buildProof(
        sender.address,
        receiver.address,
        ENCRYPTED_PREVIEW,
        deadline,
        true,
        false
      );

      await mailbox
        .connect(sender)
        .sendRequestWithProof(
          receiver.address,
          ENCRYPTED_PREVIEW,
          true,
          false,
          deadline,
          requestHash,
          signature
        );

      const request = await mailbox.requests(1);
      expect(request.isVerifiedHuman).to.equal(true);
      expect(request.isOldEnoughWallet).to.equal(false);
    });

    it("reverts when the on-chain receiver does not match the proof", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp + SEVEN_DAYS;
      const { requestHash, signature } = await buildProof(
        sender.address,
        receiver.address,
        ENCRYPTED_PREVIEW,
        deadline,
        true,
        true
      );

      await expect(
        mailbox
          .connect(sender)
          .sendRequestWithProof(
            other.address,
            ENCRYPTED_PREVIEW,
            true,
            true,
            deadline,
            requestHash,
            signature
          )
      ).to.be.revertedWith("Request hash mismatch");
    });

    it("reverts when the proof deadline has expired", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock.timestamp - 1;
      const { requestHash, signature } = await buildProof(
        sender.address,
        receiver.address,
        ENCRYPTED_PREVIEW,
        deadline,
        true,
        true
      );

      await expect(
        mailbox
          .connect(sender)
          .sendRequestWithProof(
            receiver.address,
            ENCRYPTED_PREVIEW,
            true,
            true,
            deadline,
            requestHash,
            signature
          )
      ).to.be.revertedWith("Proof deadline expired");
    });
  });
});
