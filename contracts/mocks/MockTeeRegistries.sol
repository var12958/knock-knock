// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockTeeExtensionRegistry
 * @notice In-memory recorder for Flare TEE Extension Registry calls used in tests.
 */
contract MockTeeExtensionRegistry {
    struct TeeInstructionParams {
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        address[] cosigners;
        uint256 cosignersThreshold;
        address claimBackAddress;
    }

    address[] public lastTeeIds;
    bytes32 public lastOpType;
    bytes32 public lastOpCommand;
    bytes public lastMessage;
    address[] public lastCosigners;
    uint256 public lastCosignersThreshold;
    address public lastClaimBackAddress;

    function sendInstructions(address[] memory teeIds, TeeInstructionParams memory params) external payable {
        lastTeeIds = teeIds;
        lastOpType = params.opType;
        lastOpCommand = params.opCommand;
        lastMessage = params.message;
        lastCosigners = params.cosigners;
        lastCosignersThreshold = params.cosignersThreshold;
        lastClaimBackAddress = params.claimBackAddress;
    }

    function getLastTeeIds() external view returns (address[] memory) {
        return lastTeeIds;
    }

    function getLastCosigners() external view returns (address[] memory) {
        return lastCosigners;
    }
}

/**
 * @title MockTeeMachineRegistry
 * @notice Returns a deterministic TEE machine address for tests.
 */
contract MockTeeMachineRegistry {
    function getRandomTeeIds(uint256 /* extensionId */, uint256 count) external pure returns (address[] memory) {
        address[] memory ids = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            ids[i] = address(uint160(i + 1));
        }
        return ids;
    }
}
