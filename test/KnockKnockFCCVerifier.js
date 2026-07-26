const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * @notice Test suite for KnockKnockFCCVerifier.
 * @dev The real Flare TEE registries are mocked with dummy contracts so the
 *      instruction-sending path can be exercised without a live FCC deployment.
 */
describe("KnockKnockFCCVerifier", function () {
  let verifier;
  let owner;
  let sender;
  let receiver;
  let registry;
  let machineRegistry;

  const SEVEN_DAYS = 7 * 24 * 60 * 60;

  beforeEach(async function () {
    [owner, sender, receiver] = await ethers.getSigners();

    const MockRegistry = await ethers.getContractFactory("MockTeeExtensionRegistry");
    registry = await MockRegistry.deploy();
    await registry.waitForDeployment();

    const MockMachineRegistry = await ethers.getContractFactory("MockTeeMachineRegistry");
    machineRegistry = await MockMachineRegistry.deploy();
    await machineRegistry.waitForDeployment();

    const VerifierFactory = await ethers.getContractFactory("KnockKnockFCCVerifier");
    verifier = await VerifierFactory.deploy(await registry.getAddress(), await machineRegistry.getAddress());
    await verifier.waitForDeployment();
  });

  it("records the registry addresses", async function () {
    expect(await verifier.teeExtensionRegistry()).to.equal(await registry.getAddress());
    expect(await verifier.teeMachineRegistry()).to.equal(await machineRegistry.getAddress());
  });

  it("allows the owner to set the extension ID", async function () {
    await expect(verifier.connect(owner).setExtensionId(42))
      .to.emit(verifier, "ExtensionIdUpdated")
      .withArgs(42);
    expect(await verifier.extensionId()).to.equal(42);
  });

  it("rejects zero-address registry dependencies", async function () {
    const VerifierFactory = await ethers.getContractFactory("KnockKnockFCCVerifier");
    await expect(VerifierFactory.deploy(ethers.ZeroAddress, await machineRegistry.getAddress())).to.be.revertedWith(
      "TEE extension registry cannot be zero"
    );
    await expect(VerifierFactory.deploy(await registry.getAddress(), ethers.ZeroAddress)).to.be.revertedWith(
      "TEE machine registry cannot be zero"
    );
  });

  it("emits a verification request when extension ID is set", async function () {
    await verifier.connect(owner).setExtensionId(1);
    const latestBlock = await ethers.provider.getBlock("latest");
    const deadline = latestBlock.timestamp + SEVEN_DAYS;
    const mailbox = ethers.Wallet.createRandom().address;

    await expect(
      verifier.connect(sender).requestVerification(receiver.address, "hello", deadline, mailbox)
    )
      .to.emit(verifier, "VerificationRequested")
      .withArgs(receiver.address, ethers.keccak256(
        ethers.solidityPacked(["address", "string", "uint256"], [receiver.address, "hello", deadline])
      ), 1);

    expect((await registry.getLastTeeIds()).length).to.equal(1);
    expect(await registry.lastOpType()).to.equal(await verifier.OP_TYPE_KNOCKKNOCK());
    expect(await registry.lastOpCommand()).to.equal(await verifier.OP_COMMAND_VERIFY_SENDER());

    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "address", "string", "uint256", "uint256", "address"],
      await registry.lastMessage()
    );
    expect(decoded[0]).to.equal(sender.address);
    expect(decoded[1]).to.equal(receiver.address);
    expect(decoded[2]).to.equal("hello");
    expect(decoded[3]).to.equal(deadline);
    expect(decoded[5]).to.equal(mailbox);
  });

  it("reverts when extension ID is not set", async function () {
    const latestBlock = await ethers.provider.getBlock("latest");
    const deadline = latestBlock.timestamp + SEVEN_DAYS;
    await expect(
      verifier.connect(sender).requestVerification(receiver.address, "hello", deadline, sender.address)
    ).to.be.revertedWith("Extension ID not set");
  });

  it("reverts when the deadline is not in the future", async function () {
    await verifier.connect(owner).setExtensionId(1);
    const latestBlock = await ethers.provider.getBlock("latest");
    const deadline = latestBlock.timestamp - 1;
    await expect(
      verifier.connect(sender).requestVerification(receiver.address, "hello", deadline, sender.address)
    ).to.be.revertedWith("Deadline must be in the future");
  });

  it("reverts when the mailbox is the zero address", async function () {
    await verifier.connect(owner).setExtensionId(1);
    const latestBlock = await ethers.provider.getBlock("latest");
    const deadline = latestBlock.timestamp + SEVEN_DAYS;
    await expect(
      verifier.connect(sender).requestVerification(receiver.address, "hello", deadline, ethers.ZeroAddress)
    ).to.be.revertedWith("Mailbox cannot be the zero address");
  });
});
