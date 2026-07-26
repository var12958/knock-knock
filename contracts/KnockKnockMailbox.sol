// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// OpenZeppelin utilities for access control, reentrancy protection, and signature verification.
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title KnockKnockMailbox
 * @notice A privacy-first on-chain mailbox for Web3 messaging on Flare.
 * @dev Users send encrypted chat previews to receivers. Receivers can accept
 *      (which reveals the sender and clears the request from the pending list)
 *      or reject (which removes the request from active storage). Because all
 *      blockchain data is public by nature, this contract can hide the active
 *      state but cannot erase historical events or archive data. For stronger
 *      privacy, store only a content hash on-chain and keep the ciphertext off-chain.
 */
contract KnockKnockMailbox is Ownable, ReentrancyGuard {
    using ECDSA for bytes32;

    /// @notice Default lifetime of a chat request before it expires.
    uint256 public constant DEFAULT_EXPIRATION = 7 days;

    /// @notice Minimum allowed expiration duration for new requests.
    uint256 public constant MIN_EXPIRATION = 1 hours;

    /// @notice Maximum allowed expiration duration for new requests.
    uint256 public constant MAX_EXPIRATION = 90 days;

    /// @notice Maximum number of pending (unexpired, unaccepted) requests a single receiver can have.
    uint256 public constant MAX_PENDING_PER_RECEIVER = 100;

    /// @notice Maximum number of pending requests returned in a single `getPendingRequests` call.
    uint256 public constant MAX_PAGE_SIZE = 20;

    /// @notice Maximum length of the encrypted preview message in bytes.
    uint256 public constant MAX_PREVIEW_LENGTH = 1024;

    /// @notice Current expiration duration used for new requests.
    /// @dev The owner can adjust this value within [MIN_EXPIRATION, MAX_EXPIRATION].
    uint256 public requestExpirationDuration = DEFAULT_EXPIRATION;

    /// @notice Monotonically increasing ID for the next request.
    /// @dev Request IDs start at 1 so that 0 can be used as a sentinel for
    ///      "no active request" in `senderReceiverRequestId`.
    uint256 public nextRequestId = 1;

    /**
     * @notice A single chat request between two addresses.
     * @param sender The address that created the request.
     * @param receiver The address that receives the request.
     * @param encryptedPreviewMessage Off-chain-encrypted preview message (opaque to the contract).
     * @param isVerifiedHuman Whether the sender claims to have passed a human verification check.
     * @param isOldEnoughWallet Whether the sender claims their wallet meets an age heuristic.
     * @param accepted Whether the receiver has accepted the request.
     * @param isRevealed Whether the sender's identity is revealed to the receiver.
     * @param expirationTime Unix timestamp after which the request is considered expired.
     */
    struct ChatRequest {
        address sender;
        address receiver;
        string encryptedPreviewMessage;
        bool isVerifiedHuman;
        bool isOldEnoughWallet;
        bool accepted;
        bool isRevealed;
        uint256 expirationTime;
    }

    /// @notice All chat requests indexed by their stable request ID.
    mapping(uint256 => ChatRequest) public requests;

    /// @notice Whether a given request ID currently exists in active storage.
    mapping(uint256 => bool) public requestExists;

    /// @notice Maps a receiver address to the IDs of requests targeting them.
    /// @dev This array may contain accepted or expired IDs; getters filter them out.
    mapping(address => uint256[]) private receiverToRequestIds;

    /// @notice Maps a receiver + request ID to its 1-based index in `receiverToRequestIds`.
    /// @dev A value of 0 means the request ID is not currently in the receiver's list.
    mapping(address => mapping(uint256 => uint256)) private receiverRequestIndex;

    /// @notice Maps a sender-receiver pair to the active request ID, or 0 if none.
    /// @dev This is used to enforce one active request per pair and to detect expired requests.
    mapping(address => mapping(address => uint256)) public senderReceiverRequestId;

    /// @notice Address of the trusted TEE signer that attests to verification results.
    /// @dev In production this should be derived from on-chain attestation/registry data,
    ///      not set manually by the owner.
    address public teeSigner;

    /// @notice Tracks verification signatures that have already been consumed.
    /// @dev Prevents replay of a valid TEE attestation across multiple requests.
    mapping(bytes => bool) public usedSignatures;

    /// @notice Emitted when a new chat request is sent.
    /// @dev Events are permanent on-chain history and cannot be deleted.
    event RequestSent(
        uint256 indexed requestId,
        address indexed sender,
        address indexed receiver
    );

    /// @notice Emitted when a receiver accepts a chat request.
    event RequestAccepted(uint256 indexed requestId, address indexed receiver);

    /// @notice Emitted when a receiver rejects a chat request.
    event RequestRejected(uint256 indexed requestId, address indexed receiver);

    /// @notice Emitted when the owner changes the request expiration duration.
    event ExpirationDurationUpdated(uint256 newDuration);

    /// @notice Emitted when an expired request is automatically cleaned up by a new send.
    event ExpiredRequestCleaned(uint256 indexed requestId, address indexed sender, address indexed receiver);

    /// @notice Emitted when the owner updates the trusted TEE signer address.
    event TEESignerUpdated(address indexed newSigner);

    /**
     * @notice Ensures the caller is the receiver of the given request.
     * @param _requestId The ID of the request to check.
     */
    modifier onlyReceiver(uint256 _requestId) {
        require(requestExists[_requestId], "Request does not exist");
        require(
            msg.sender == requests[_requestId].receiver,
            "Only the receiver can perform this action"
        );
        _;
    }

    /**
     * @notice Contract constructor. Passes the deployer as the initial owner.
     */
    constructor() Ownable(msg.sender) {}

    /**
     * @notice Send a new chat request to a receiver.
     * @param _receiver The address that should receive the request.
     * @param _encryptedPreviewMessage Off-chain-encrypted preview message.
     * @param _isVerifiedHuman Whether the sender claims to be a verified human.
     * @param _isOldEnoughWallet Whether the sender claims their wallet is old enough.
     * @return requestId The stable ID of the newly created request.
     * @dev Expiration time is computed as `block.timestamp + requestExpirationDuration`.
     *      To prevent spam and DoS:
     *      - each sender-receiver pair can have at most one active (unaccepted, unexpired) request,
     *      - each receiver is capped at MAX_PENDING_PER_RECEIVER pending requests,
     *      - the preview message length is capped at MAX_PREVIEW_LENGTH bytes.
     *      If an existing request for the pair has expired, it is automatically cleaned up
     *      so the sender is not permanently blocked.
     *      The booleans are self-reported claims; the contract does not verify them.
     */
    function sendRequest(
        address _receiver,
        string memory _encryptedPreviewMessage,
        bool _isVerifiedHuman,
        bool _isOldEnoughWallet
    ) external nonReentrant returns (uint256 requestId) {
        requestId = _createRequest(
            _receiver,
            _encryptedPreviewMessage,
            _isVerifiedHuman,
            _isOldEnoughWallet
        );
    }

    /**
     * @notice Send a new chat request with a TEE attestation for both verification checks.
     * @param _receiver The address that should receive the request.
     * @param _encryptedPreviewMessage Off-chain-encrypted preview message.
     * @param _isVerifiedHuman TEE-attested humanity flag.
     * @param _isOldEnoughWallet TEE-attested wallet-age flag.
     * @param _deadline Unix timestamp after which the verification proof expires.
     * @param _requestHash Hash binding this proof to the receiver, preview, and deadline.
     * @param _teeSignature ECDSA signature from the trusted TEE signer over
     *        `keccak256(abi.encodePacked(chainId, mailbox, msg.sender, isVerifiedHuman, isOldEnoughWallet, requestHash))`.
     * @return requestId The stable ID of the newly created request.
     * @dev The signature binds the attestation to `msg.sender`, this contract address, and
     *      the current chain so a proof cannot be replayed across wallets, contracts, or chains.
     *      The wallet address itself is not emitted in the public output; it is only used as
     *      the transaction origin and in the signed hash verification.
     */
    function sendRequestWithProof(
        address _receiver,
        string memory _encryptedPreviewMessage,
        bool _isVerifiedHuman,
        bool _isOldEnoughWallet,
        uint256 _deadline,
        bytes32 _requestHash,
        bytes memory _teeSignature
    ) external nonReentrant returns (uint256 requestId) {
        require(teeSigner != address(0), "TEE signer not configured");
        require(!usedSignatures[_teeSignature], "Proof already used");
        require(
            block.timestamp <= _deadline,
            "Proof deadline expired"
        );

        bytes32 expectedHash = keccak256(
            abi.encodePacked(_receiver, _encryptedPreviewMessage, _deadline)
        );
        require(expectedHash == _requestHash, "Request hash mismatch");

        bytes32 signedHash = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                msg.sender,
                _isVerifiedHuman,
                _isOldEnoughWallet,
                _requestHash
            )
        );
        address signer = signedHash.recover(_teeSignature);
        require(signer == teeSigner, "Invalid TEE signature");

        usedSignatures[_teeSignature] = true;
        requestId = _createRequest(
            _receiver,
            _encryptedPreviewMessage,
            _isVerifiedHuman,
            _isOldEnoughWallet
        );
    }

    /**
     * @notice Owner-only function to set the trusted TEE signer address.
     * @param _newSigner The address derived from the TEE attestation/public key.
     * @dev In a production deployment this should be initialized from the Flare
     *      TEE registry/attestation rather than passed by the owner.
     */
    function setTEESigner(address _newSigner) external onlyOwner {
        require(_newSigner != address(0), "Signer cannot be the zero address");
        teeSigner = _newSigner;
        emit TEESignerUpdated(_newSigner);
    }

    /**
     * @notice Internal helper that creates a chat request after all checks have passed.
     * @param _receiver The address that should receive the request.
     * @param _encryptedPreviewMessage Off-chain-encrypted preview message.
     * @param _isVerifiedHuman Whether the sender is a verified human.
     * @param _isOldEnoughWallet Whether the sender's wallet is old enough.
     * @return requestId The stable ID of the newly created request.
     */
    function _createRequest(
        address _receiver,
        string memory _encryptedPreviewMessage,
        bool _isVerifiedHuman,
        bool _isOldEnoughWallet
    ) internal returns (uint256 requestId) {
        require(_receiver != address(0), "Receiver cannot be the zero address");
        require(
            bytes(_encryptedPreviewMessage).length > 0,
            "Preview message cannot be empty"
        );
        require(
            bytes(_encryptedPreviewMessage).length <= MAX_PREVIEW_LENGTH,
            "Preview message too long"
        );

        // If the pair already has an active request, overwrite it. This allows
        // onboarding flows to resubmit self-to-self proofs without waiting for the
        // previous proof to expire or be accepted.
        uint256 existingId = senderReceiverRequestId[msg.sender][_receiver];
        if (existingId > 0 && requestExists[existingId]) {
            _cleanupRequest(existingId);
        }

        require(
            _pendingCount(_receiver) < MAX_PENDING_PER_RECEIVER,
            "Receiver has too many pending requests"
        );

        requestId = nextRequestId;
        nextRequestId++;

        requests[requestId] = ChatRequest({
            sender: msg.sender,
            receiver: _receiver,
            encryptedPreviewMessage: _encryptedPreviewMessage,
            isVerifiedHuman: _isVerifiedHuman,
            isOldEnoughWallet: _isOldEnoughWallet,
            accepted: false,
            isRevealed: false,
            expirationTime: block.timestamp + requestExpirationDuration
        });

        requestExists[requestId] = true;
        senderReceiverRequestId[msg.sender][_receiver] = requestId;
        _addReceiverRequestId(_receiver, requestId);

        emit RequestSent(requestId, msg.sender, _receiver);
    }

    /**
     * @notice Accept a pending chat request.
     * @param _requestId The ID of the request to accept.
     * @dev Only the receiver may accept. Sets `accepted` and `isRevealed` to true,
     *      marks the sender-receiver pair as no longer active, removes the request
     *      from the receiver's pending list, and deletes the encrypted preview from
     *      storage to reduce the on-chain data footprint.
     */
    function acceptRequest(uint256 _requestId)
        external
        onlyReceiver(_requestId)
        nonReentrant
    {
        ChatRequest storage request = requests[_requestId];
        require(!request.accepted, "Request has already been accepted");
        require(
            block.timestamp <= request.expirationTime,
            "Request has expired"
        );

        request.accepted = true;
        request.isRevealed = true;

        // Clear the encrypted preview to reduce long-term storage of ciphertext.
        delete request.encryptedPreviewMessage;

        senderReceiverRequestId[request.sender][request.receiver] = 0;
        _removeReceiverRequestId(request.receiver, _requestId);

        emit RequestAccepted(_requestId, msg.sender);
    }

    /**
     * @notice Reject and remove a chat request from active storage.
     * @param _requestId The ID of the request to reject.
     * @dev Only the receiver may reject. Clears the request struct and removes it
     *      from the receiver's pending list. Because blockchain events and archive
     *      data are permanent, this hides the active state but cannot fully erase
     *      historical evidence that the request existed.
     */
    function rejectRequest(uint256 _requestId)
        external
        onlyReceiver(_requestId)
        nonReentrant
    {
        ChatRequest storage request = requests[_requestId];
        require(
            !request.accepted,
            "Cannot reject an already accepted request"
        );

        _cleanupRequest(_requestId);

        emit RequestRejected(_requestId, msg.sender);
    }

    /**
     * @notice Return a paginated list of pending, unexpired, unaccepted requests for a receiver.
     * @param _receiver The address whose pending requests should be listed.
     * @param _offset The number of pending requests to skip (for pagination).
     * @param _limit The maximum number of pending requests to return (capped at MAX_PAGE_SIZE).
     * @return pendingRequests Array of pending `ChatRequest` structs.
     * @dev Only the receiver may call this function. Filtering happens in memory
     *      inside this view function. Pagination prevents oversized RPC responses.
     */
    function getPendingRequests(address _receiver, uint256 _offset, uint256 _limit)
        external
        view
        returns (ChatRequest[] memory pendingRequests)
    {
        require(
            msg.sender == _receiver,
            "Only the receiver can view their pending requests"
        );

        uint256[] storage receiverRequestIds = receiverToRequestIds[_receiver];

        // Collect pending IDs up to the requested page size.
        if (_limit > MAX_PAGE_SIZE) {
            _limit = MAX_PAGE_SIZE;
        }

        uint256[] memory pendingIds = new uint256[](_limit);
        uint256 pendingFound = 0;
        uint256 skipped = 0;
        for (uint256 i = 0; i < receiverRequestIds.length; i++) {
            uint256 requestId = receiverRequestIds[i];
            if (!_isPending(requestId)) {
                continue;
            }

            if (skipped < _offset) {
                skipped++;
                continue;
            }

            pendingIds[pendingFound] = requestId;
            pendingFound++;
            if (pendingFound == _limit) {
                break;
            }
        }

        pendingRequests = new ChatRequest[](pendingFound);
        for (uint256 i = 0; i < pendingFound; i++) {
            pendingRequests[i] = requests[pendingIds[i]];
        }
    }

    /**
     * @notice Return only the pending request IDs for a receiver.
     * @param _receiver The address whose pending request IDs should be listed.
     * @param _offset The number of pending requests to skip (for pagination).
     * @param _limit The maximum number of pending request IDs to return (capped at MAX_PAGE_SIZE).
     * @return ids Array of pending request IDs.
     * @dev Only the receiver may call this function. Use the returned IDs with
     *      the `requests` mapping or `acceptRequest` / `rejectRequest`.
     */
    function getPendingRequestIds(address _receiver, uint256 _offset, uint256 _limit)
        external
        view
        returns (uint256[] memory ids)
    {
        require(
            msg.sender == _receiver,
            "Only the receiver can view their pending requests"
        );

        uint256[] storage receiverRequestIds = receiverToRequestIds[_receiver];

        if (_limit > MAX_PAGE_SIZE) {
            _limit = MAX_PAGE_SIZE;
        }

        uint256[] memory pendingIds = new uint256[](_limit);
        uint256 pendingFound = 0;
        uint256 skipped = 0;
        for (uint256 i = 0; i < receiverRequestIds.length; i++) {
            uint256 requestId = receiverRequestIds[i];
            if (!_isPending(requestId)) {
                continue;
            }

            if (skipped < _offset) {
                skipped++;
                continue;
            }

            pendingIds[pendingFound] = requestId;
            pendingFound++;
            if (pendingFound == _limit) {
                break;
            }
        }

        ids = new uint256[](pendingFound);
        for (uint256 i = 0; i < pendingFound; i++) {
            ids[i] = pendingIds[i];
        }
    }

    /**
     * @notice Owner-only function to update the default request expiration duration.
     * @param _newDuration The new duration in seconds.
     * @dev Only the contract owner can change this value, and it must remain
     *      within the [MIN_EXPIRATION, MAX_EXPIRATION] range.
     */
    function setRequestExpirationDuration(uint256 _newDuration)
        external
        onlyOwner
    {
        require(
            _newDuration >= MIN_EXPIRATION && _newDuration <= MAX_EXPIRATION,
            "Duration out of bounds"
        );
        requestExpirationDuration = _newDuration;
        emit ExpirationDurationUpdated(_newDuration);
    }

    /**
     * @notice Get the total number of requests ever created (including rejected ones).
     * @return The current value of `nextRequestId`.
     */
    function getTotalRequestCount() external view returns (uint256) {
        return nextRequestId;
    }

    /**
     * @notice Internal helper to count actually pending requests for a receiver.
     * @param _receiver The receiver whose pending requests should be counted.
     * @return count The number of unexpired, unaccepted, existing requests.
     */
    function _pendingCount(address _receiver) internal view returns (uint256 count) {
        uint256[] storage receiverRequestIds = receiverToRequestIds[_receiver];
        for (uint256 i = 0; i < receiverRequestIds.length; i++) {
            if (_isPending(receiverRequestIds[i])) {
                count++;
            }
        }
    }

    /**
     * @notice Internal helper to determine whether a request is still pending.
     * @param _requestId The ID of the request to check.
     * @return True if the request exists, is unaccepted, and has not expired.
     */
    function _isPending(uint256 _requestId) internal view returns (bool) {
        if (!requestExists[_requestId]) {
            return false;
        }
        ChatRequest storage request = requests[_requestId];
        return
            !request.accepted &&
            block.timestamp <= request.expirationTime;
    }

    /**
     * @notice Internal helper to add a request ID to a receiver's list.
     * @param _receiver The receiver whose list should be updated.
     * @param _requestId The request ID to append.
     * @dev Stores the 1-based index to enable O(1) removal later.
     */
    function _addReceiverRequestId(address _receiver, uint256 _requestId) internal {
        receiverToRequestIds[_receiver].push(_requestId);
        receiverRequestIndex[_receiver][_requestId] =
            receiverToRequestIds[_receiver].length;
    }

    /**
     * @notice Internal helper to remove a request ID from a receiver's list.
     * @param _receiver The receiver whose list should be updated.
     * @param _requestId The request ID to remove.
     * @dev Uses swap-and-pop with an index mapping for O(1) removal.
     */
    function _removeReceiverRequestId(address _receiver, uint256 _requestId) internal {
        uint256 indexPlusOne = receiverRequestIndex[_receiver][_requestId];
        require(indexPlusOne > 0, "Request not in receiver list");

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = receiverToRequestIds[_receiver].length - 1;
        uint256 lastRequestId = receiverToRequestIds[_receiver][lastIndex];

        receiverToRequestIds[_receiver][index] = lastRequestId;
        receiverRequestIndex[_receiver][lastRequestId] = indexPlusOne;
        receiverToRequestIds[_receiver].pop();
        delete receiverRequestIndex[_receiver][_requestId];
    }

    /**
     * @notice Internal helper to fully remove a request from active storage.
     * @param _requestId The ID of the request to clean up.
     * @dev Clears the request struct, existence flag, sender-receiver mapping,
     *      and removes the ID from the receiver's list.
     */
    function _cleanupRequest(uint256 _requestId) internal {
        ChatRequest storage request = requests[_requestId];
        address sender = request.sender;
        address receiver = request.receiver;

        senderReceiverRequestId[sender][receiver] = 0;
        _removeReceiverRequestId(receiver, _requestId);

        delete requests[_requestId];
        requestExists[_requestId] = false;

        emit ExpiredRequestCleaned(_requestId, sender, receiver);
    }
}
