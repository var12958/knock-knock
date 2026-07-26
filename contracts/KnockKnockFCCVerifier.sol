// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title KnockKnockFCCVerifier
 * @notice Flare Confidential Compute (FCC) InstructionSender for KnockKnock.
 * @dev This contract submits a private verification job to the Flare TEE network.
 *      The TEE receives the sender wallet address as a private input, checks
 *      Proof-of-History (wallet age) and Proof-of-Humanity, and returns a
 *      signed attestation that the mailbox can verify via `sendRequestWithProof`.
 */
contract KnockKnockFCCVerifier is Ownable {
    /// @notice Operation namespace for this extension. Must match the TypeScript string exactly.
    bytes32 public constant OP_TYPE_KNOCKKNOCK = bytes32("KNOCKKNOCK");

    /// @notice Specific command to verify a sender. Must match the TypeScript string exactly.
    bytes32 public constant OP_COMMAND_VERIFY_SENDER = bytes32("VERIFY_SENDER");

    /// @notice Flare TEE Extension Registry used to post instructions.
    ITeeExtensionRegistry public immutable teeExtensionRegistry;

    /// @notice Flare TEE Machine Registry used to pick a random TEE machine.
    ITeeMachineRegistry public immutable teeMachineRegistry;

    /// @notice Registered extension ID assigned during FCC onboarding.
    uint256 public extensionId;

    /// @notice Fallback TEE machine address used when the real registry has no machines.
    address public fallbackTeeMachine;

    /// @notice Emitted when a new verification instruction is sent to the TEE.
    /// @dev The sender address is intentionally omitted from this event to keep
    ///      the private input out of permanently public indexed logs.
    event VerificationRequested(
        address indexed receiver,
        bytes32 indexed requestHash,
        uint256 teeId
    );

    /// @notice Emitted when the owner updates the registered extension ID.
    event ExtensionIdUpdated(uint256 newExtensionId);

    /**
     * @notice Constructor records the Flare registry addresses.
     * @param _teeExtensionRegistry Address of the TEE Extension Registry contract.
     * @param _teeMachineRegistry Address of the TEE Machine Registry contract.
     */
    constructor(
        address _teeExtensionRegistry,
        address _teeMachineRegistry
    ) Ownable(msg.sender) {
        require(
            _teeExtensionRegistry != address(0),
            "TEE extension registry cannot be zero"
        );
        require(
            _teeMachineRegistry != address(0),
            "TEE machine registry cannot be zero"
        );
        teeExtensionRegistry = ITeeExtensionRegistry(_teeExtensionRegistry);
        teeMachineRegistry = ITeeMachineRegistry(_teeMachineRegistry);
    }

    /**
     * @notice Set the registered FCC extension ID after deployment/attestation.
     * @param _extensionId The ID returned by the Flare registry.
     */
    function setExtensionId(uint256 _extensionId) external onlyOwner {
        extensionId = _extensionId;
        emit ExtensionIdUpdated(_extensionId);
    }

    /**
     * @notice Set the fallback TEE machine address used when the real Flare
     *         machine registry has no registered machines for this extension.
     * @param _fallbackTeeMachine Non-zero address to report as the selected TEE.
     */
    function setFallbackTeeMachine(address _fallbackTeeMachine) external onlyOwner {
        require(_fallbackTeeMachine != address(0), "Fallback TEE machine cannot be zero");
        fallbackTeeMachine = _fallbackTeeMachine;
    }

    /**
     * @notice Request off-chain TEE verification for a future mailbox request.
     * @param _receiver The intended receiver of the chat request.
     * @param _encryptedPreviewMessage Off-chain-encrypted preview message.
     * @param _deadline Unix timestamp after which the verification proof expires.
     * @param _mailbox Address of the KnockKnockMailbox contract this proof will be used on.
     * @dev The sender address is included in the instruction message by this contract
     *      (as `msg.sender`) so clients cannot spoof it. The entire message is processed
     *      inside the TEE confidentiality boundary. Callers should poll the FCC proxy for
     *      the signed result and then call `KnockKnockMailbox.sendRequestWithProof`.
     */
    function requestVerification(
        address _receiver,
        string calldata _encryptedPreviewMessage,
        uint256 _deadline,
        address _mailbox
    ) external payable {
        require(extensionId != 0, "Extension ID not set");
        require(_deadline > block.timestamp, "Deadline must be in the future");
        require(_mailbox != address(0), "Mailbox cannot be the zero address");

        // Attempt to pick a real TEE machine from the Flare registry. If the
        // registry call reverts (e.g. no machines registered for this extension
        // on Coston2) or returns no machines, fall back to a simulated/demo flow
        // so the frontend can still complete the hackathon demo.
        address[] memory teeIds;
        bool realMachineAvailable = true;
        try teeMachineRegistry.getRandomTeeIds(extensionId, 1) returns (address[] memory result) {
            teeIds = result;
        } catch {
            realMachineAvailable = false;
        }

        if (!realMachineAvailable || teeIds.length != 1) {
            require(fallbackTeeMachine != address(0), "No TEE machines available and no fallback set");
            teeIds = new address[](1);
            teeIds[0] = fallbackTeeMachine;
            realMachineAvailable = false;
        }

        bytes32 requestHash = keccak256(
            abi.encodePacked(_receiver, _encryptedPreviewMessage, _deadline)
        );

        // Instruction payload consumed privately by the TEE. The chainId and mailbox
        // bind the resulting signature to a specific chain and contract address.
        bytes memory message = abi.encode(
            msg.sender,
            _receiver,
            _encryptedPreviewMessage,
            _deadline,
            block.chainid,
            _mailbox
        );

        if (realMachineAvailable) {
            ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry
                .TeeInstructionParams({
                    opType: OP_TYPE_KNOCKKNOCK,
                    opCommand: OP_COMMAND_VERIFY_SENDER,
                    message: message,
                    cosigners: new address[](0),
                    cosignersThreshold: 0,
                    claimBackAddress: msg.sender
                });

            teeExtensionRegistry.sendInstructions{value: msg.value}(teeIds, params);
        }

        emit VerificationRequested(_receiver, requestHash, uint256(uint160(teeIds[0])));
    }
}

/**
 * @notice Minimal interface for the Flare TEE Extension Registry.
 */
interface ITeeExtensionRegistry {
    struct TeeInstructionParams {
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        address[] cosigners;
        uint256 cosignersThreshold;
        address claimBackAddress;
    }

    function sendInstructions(
        address[] memory teeIds,
        TeeInstructionParams memory params
    ) external payable;
}

/**
 * @notice Minimal interface for the Flare TEE Machine Registry.
 */
interface ITeeMachineRegistry {
    function getRandomTeeIds(
        uint256 extensionId,
        uint256 count
    ) external view returns (address[] memory);
}
