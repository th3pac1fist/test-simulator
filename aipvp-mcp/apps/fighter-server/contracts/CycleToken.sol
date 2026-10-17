// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Fighter Lab Test Cycles (tCYC)
/// @notice A TEST-NETWORK token with no value, for the Fighter Lab prototype on Base Sepolia.
/// Nothing is pre-minted. Tokens exist only when a player claims a voucher the game server signed
/// after taking the same number of Cycles from their game balance; depositing burns tokens and the
/// server credits Cycles back once per Deposited event.
contract CycleToken is ERC20, EIP712, Ownable {
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(address to,uint256 amount,uint256 nonce,uint256 deadline)");

    /// @notice The game server's voucher-signing address (it signs vouchers and nothing else).
    address public signer;
    /// @notice Voucher nonces already claimed; each voucher works once.
    mapping(uint256 => bool) public used;

    event SignerChanged(address indexed previous, address indexed next);
    event Claimed(address indexed to, uint256 amount, uint256 indexed nonce);
    event Deposited(address indexed from, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error VoucherExpired();
    error VoucherUsed();
    error BadSignature();

    constructor(address signer_, address owner_)
        ERC20("Fighter Lab Test Cycles", "tCYC")
        EIP712("Fighter Lab Test Cycles", "1")
        Ownable(owner_)
    {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        emit SignerChanged(address(0), signer_);
    }

    /// @notice Mint the tokens a voucher promises. Only the address the voucher names can claim it,
    /// once, before its deadline.
    function claim(uint256 amount, uint256 nonce, uint256 deadline, bytes calldata signature) external {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert VoucherExpired();
        if (used[nonce]) revert VoucherUsed();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, msg.sender, amount, nonce, deadline)));
        if (ECDSA.recover(digest, signature) != signer) revert BadSignature();
        used[nonce] = true;
        _mint(msg.sender, amount);
        emit Claimed(msg.sender, amount, nonce);
    }

    /// @notice Burn tokens to get Cycles back in the game (the server watches for this event).
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Rotate the voucher-signing key. Vouchers signed by the old key stop working.
    function setSigner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit SignerChanged(signer, next);
        signer = next;
    }
}
