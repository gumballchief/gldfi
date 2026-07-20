// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IGoldDistributor {
    function distribute(uint256 amount) external;
    function eligibleSupply() external view returns (uint256);
}

/// @notice The per-token fee-share contract Bags deploys with each launch.
///         Creator fees accrue here in WETH and must be pulled with `claim`.
interface IBagsFeeShare {
    function claim() external;
}

/// @notice Minimal swap surface: WETH in, gold out. A thin adapter wraps
///         whatever venue actually holds gold liquidity on Robinhood Chain.
interface IWethToGoldRouter {
    function swapExactWethForGold(uint256 amountIn, uint256 minGoldOut, address recipient)
        external
        returns (uint256 goldOut);
}

/**
 * @title GoldTreasury
 * @notice Collects the protocol's WETH fee share and turns it into gold for holders.
 *
 * WHY WETH AND NOT NATIVE ETH
 * ---------------------------
 * Gold launches through Bags on Robinhood Chain. Bags charges 2% on the WETH
 * leg of every trade and splits it evenly — 1% to the Bags protocol, 1% to the
 * token's registered fee claimers — accrued as WETH inside a per-token
 * `BagsFeeShare` contract. The money therefore arrives as an ERC-20, not as
 * ether, and only when somebody calls `claim`.
 *
 * TWO WAYS FEES CAN REACH THIS CONTRACT
 * -------------------------------------
 * 1. This contract is itself a registered Bags fee claimer. `claimFees()` pulls
 *    straight from BagsFeeShare and nobody can intercept it.
 * 2. A wallet is the registered claimer and forwards WETH here.
 *
 * Both are supported on purpose, because whether Bags accepts a contract as a
 * claimer is still unconfirmed. Route 1 is strictly better and should be used if
 * it is available: under route 2 the fees sit in a human-controlled wallet
 * first, and the protocol is then only as trustworthy as whoever holds that key.
 *
 * WHAT THIS CONTRACT CANNOT DO
 * ----------------------------
 * It cannot choose what to buy, cannot send gold anywhere except the
 * distributor, and has no owner path to withdraw the WETH or the gold. The only
 * discretion an operator has is *when* to convert, and what slippage to accept.
 */
contract GoldTreasury is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable weth;
    IERC20 public immutable gold;
    IGoldDistributor public immutable distributor;

    /// @notice The Bags fee-share contract for this token. Set after launch,
    ///         because Bags deploys it and its address is not known in advance.
    IBagsFeeShare public feeShare;

    /// @notice Swap venue used to turn WETH into gold.
    IWethToGoldRouter public router;

    /// @notice Addresses allowed to trigger a conversion.
    mapping(address => bool) public keepers;

    uint256 public totalWethClaimed;
    uint256 public totalWethConverted;
    uint256 public totalGoldDistributed;

    event FeesClaimed(uint256 amount);
    event Converted(uint256 wethIn, uint256 goldOut, uint256 wethRemaining);
    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    event FeeShareUpdated(address indexed oldFeeShare, address indexed newFeeShare);
    event KeeperUpdated(address indexed keeper, bool allowed);

    error NotKeeper();
    error ZeroAddress();
    error NoWeth();
    error NoGoldReceived();
    error RouterNotSet();
    error FeeShareNotSet();
    error NotRescuable();

    modifier onlyKeeper() {
        if (!keepers[msg.sender] && msg.sender != owner()) revert NotKeeper();
        _;
    }

    constructor(address _weth, address _gold, address _distributor, address _owner) Ownable(_owner) {
        if (_weth == address(0) || _gold == address(0) || _distributor == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        weth = IERC20(_weth);
        gold = IERC20(_gold);
        distributor = IGoldDistributor(_distributor);
    }

    /**
     * @notice Pull this token's accrued creator fees out of Bags.
     * @dev Permissionless on purpose: claiming can only move WETH INTO this
     *      contract, so there is nothing to gate, and leaving it open means fees
     *      keep flowing even if every keeper goes offline. The amount is
     *      measured from the balance change rather than trusting BagsFeeShare.
     */
    function claimFees() external nonReentrant returns (uint256 claimed) {
        if (address(feeShare) == address(0)) revert FeeShareNotSet();

        uint256 before = weth.balanceOf(address(this));
        feeShare.claim();
        claimed = weth.balanceOf(address(this)) - before;

        totalWethClaimed += claimed;
        emit FeesClaimed(claimed);
    }

    /**
     * @notice Convert held WETH into gold and credit every eligible holder.
     * @param wethAmount How much to spend. Zero means the whole balance.
     * @param minGoldOut Slippage floor — the swap reverts below this.
     *
     * @dev Gold credited is measured as the change in this contract's own
     *      balance, never the router's return value. A router that lies, or
     *      quietly takes a cut, cannot inflate what holders are told they own.
     */
    function convertAndDistribute(uint256 wethAmount, uint256 minGoldOut)
        external
        onlyKeeper
        nonReentrant
        returns (uint256 goldOut)
    {
        if (address(router) == address(0)) revert RouterNotSet();

        uint256 available = weth.balanceOf(address(this));
        if (available == 0) revert NoWeth();
        if (wethAmount == 0 || wethAmount > available) wethAmount = available;

        uint256 before = gold.balanceOf(address(this));

        weth.forceApprove(address(router), wethAmount);
        router.swapExactWethForGold(wethAmount, minGoldOut, address(this));
        // Leave no standing allowance behind if the router under-spent.
        weth.forceApprove(address(router), 0);

        goldOut = gold.balanceOf(address(this)) - before;
        if (goldOut == 0) revert NoGoldReceived();

        totalWethConverted += wethAmount;
        totalGoldDistributed += goldOut;

        gold.forceApprove(address(distributor), goldOut);
        distributor.distribute(goldOut);

        emit Converted(wethAmount, goldOut, weth.balanceOf(address(this)));
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setFeeShare(address _feeShare) external onlyOwner {
        if (_feeShare == address(0)) revert ZeroAddress();
        emit FeeShareUpdated(address(feeShare), _feeShare);
        feeShare = IBagsFeeShare(_feeShare);
    }

    function setRouter(address _router) external onlyOwner {
        if (_router == address(0)) revert ZeroAddress();
        emit RouterUpdated(address(router), _router);
        router = IWethToGoldRouter(_router);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        keepers[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    /**
     * @notice Rescue a token that is neither the gold nor the WETH.
     * @dev Both are deliberately excluded. Allowing either would hand the owner
     *      a path to drain money belonging to holders, which is exactly the
     *      trust assumption this design exists to remove.
     */
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(gold) || token == address(weth)) revert NotRescuable();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
