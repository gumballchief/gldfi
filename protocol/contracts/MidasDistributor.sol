// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title MidasDistributor
 * @notice Accrues tokenized gold (GLD) to MidasFi holders pro-rata and pays it out.
 *
 * THE CORE PROBLEM THIS SOLVES
 * ---------------------------
 * The naive design — "loop over every holder and send them gold" — cannot work.
 * With a few thousand holders a single distribution exceeds the block gas limit,
 * and the protocol bricks precisely when it succeeds in attracting users.
 *
 * So distribution is split into two halves that scale independently:
 *
 *   ACCOUNTING  is O(1). A distribution only bumps one number, `accGoldPerShare`.
 *               Ten holders or ten million, `distribute()` costs the same.
 *   PAYOUT      is O(batch). A keeper walks the holder set in bounded chunks via
 *               `pushBatch`, so holders never have to claim, but any single
 *               transaction stays well inside the gas limit. `claim()` remains
 *               open as a permissionless fallback if no keeper ever runs.
 *
 * This is the standard "accumulated reward per share" pattern. Each holder's
 * entitlement is derived on read:
 *
 *   owed(u) = accrued[u] + eligible[u] * (accGoldPerShare - snapshot[u]) / SCALE
 *
 * ELIGIBILITY
 * -----------
 * Only wallets holding >= `threshold` MidasFi accrue, and `eligibleSupply` tracks
 * the sum of exactly those balances. A wallet that falls below the threshold
 * stops accruing immediately but keeps everything it already earned — gold that
 * has been credited is never clawed back.
 *
 * WHY THIS IS NOT SNAPSHOT-GAMEABLE
 * ---------------------------------
 * Accrual is continuous rather than snapshot-based, so buying in cannot earn
 * retroactively: a wallet only shares in distributions that happen while it
 * holds. The remaining strategy is to buy immediately before a distribution and
 * sell immediately after, capturing one cycle. The 3% fee makes that a losing
 * trade — a round trip costs ~6% of position value, while one cycle pays out a
 * tiny fraction of a percent. The fee that funds the protocol also defends it.
 */
contract MidasDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Fixed-point scale for accGoldPerShare. Sized so that
    ///      amount * SCALE cannot overflow for any realistic distribution:
    ///      1e21 (1000 GLD) * 1e36 = 1e57, against a uint256 ceiling of ~1.15e77.
    uint256 private constant SCALE = 1e36;

    IERC20 public immutable midasToken; // MidasFi — the token you hold
    IERC20 public immutable gld;       // tokenized SPDR Gold Shares — what you get paid in

    /// @notice Minimum MidasFi balance for a wallet to accrue.
    uint256 public threshold;

    /// @notice Address permitted to call `distribute` (the treasury).
    address public treasury;

    /// @notice Sum of the balances of every currently-eligible wallet.
    uint256 public eligibleSupply;

    /// @notice Running gold-per-eligible-token, scaled by SCALE.
    uint256 public accGoldPerShare;

    /// @notice Gold received while nothing was eligible, plus integer-division
    ///         dust. Carried into the next distribution so no gold is ever lost.
    uint256 public carry;

    /// @notice Total gold credited to holders over all time.
    uint256 public totalDistributed;
    /// @notice Total gold actually transferred out to holders.
    uint256 public totalPaidOut;
    /// @notice Number of completed distribution cycles.
    uint256 public cycles;

    struct Holder {
        uint256 eligible; // the balance currently accruing (0 if below threshold)
        uint256 snapshot; // accGoldPerShare at this wallet's last settlement
        uint256 accrued;  // gold credited but not yet transferred out
    }

    mapping(address => Holder) public holders;

    /// @notice Wallets excluded from accrual (pool, treasury, distributor, burn).
    mapping(address => bool) public excluded;

    /// @dev Enumerable set of eligible wallets, so a keeper can walk them.
    address[] private _eligibleList;
    mapping(address => uint256) private _listIndex; // 1-based; 0 means absent

    /// @notice Payouts below this are left to accrue, so a batch never wastes
    ///         more gas on a transfer than the transfer is worth.
    uint256 public minPayout;

    event Distributed(uint256 indexed cycle, uint256 amount, uint256 eligibleSupply, uint256 carried);
    event Paid(address indexed holder, uint256 amount);
    event EligibilityChanged(address indexed holder, uint256 oldEligible, uint256 newEligible);
    event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event ExclusionUpdated(address indexed account, bool excluded);
    event MinPayoutUpdated(uint256 oldMinPayout, uint256 newMinPayout);

    error NotMidasToken();
    error NotTreasury();
    error ZeroAddress();
    error NothingToDistribute();

    modifier onlyMidasToken() {
        if (msg.sender != address(midasToken)) revert NotMidasToken();
        _;
    }

    constructor(address _midasToken, address _gld, uint256 _threshold, address _owner) Ownable(_owner) {
        if (_midasToken == address(0) || _gld == address(0) || _owner == address(0)) revert ZeroAddress();
        midasToken = IERC20(_midasToken);
        gld = IERC20(_gld);
        threshold = _threshold;
        minPayout = 0;

        // Never accrue to the zero address or to the distributor's own balance.
        excluded[address(0)] = true;
        excluded[address(this)] = true;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Gold owed to `user` right now, credited but not yet transferred.
    function owed(address user) public view returns (uint256) {
        Holder storage h = holders[user];
        return h.accrued + (h.eligible * (accGoldPerShare - h.snapshot)) / SCALE;
    }

    /// @notice Whether `user` is currently accruing.
    function isEligible(address user) external view returns (bool) {
        return _listIndex[user] != 0;
    }

    /// @notice Number of wallets currently accruing.
    function eligibleCount() public view returns (uint256) {
        return _eligibleList.length;
    }

    /// @notice Read a page of the eligible-holder set, for keepers and the UI.
    function eligibleSlice(uint256 start, uint256 count) external view returns (address[] memory page) {
        uint256 len = _eligibleList.length;
        if (start >= len) return new address[](0);
        uint256 end = start + count;
        if (end > len) end = len;
        page = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            page[i - start] = _eligibleList[i];
        }
    }

    // ---------------------------------------------------------------------
    // Accrual
    // ---------------------------------------------------------------------

    /**
     * @notice Called by the MidasFi token after every transfer so this contract
     *         can re-derive eligibility for the two wallets involved.
     * @dev Deliberately strict: if this reverts, the transfer reverts. Silently
     *      swallowing an accounting failure would let balances and
     *      `eligibleSupply` drift apart, which is unrecoverable.
     */
    function onBalanceChange(address from, address to) external onlyMidasToken {
        _sync(from);
        if (to != from) _sync(to);
    }

    /// @dev Settle a wallet's accrual, then re-derive its eligible balance.
    function _sync(address user) internal {
        if (excluded[user] || user == address(0)) {
            // An excluded wallet must not sit in the eligible set or the supply.
            _setEligible(user, 0);
            return;
        }

        Holder storage h = holders[user];

        // Crystallise everything earned up to this instant BEFORE the eligible
        // balance moves — otherwise the new balance would be retroactively
        // applied to distributions the wallet was not present for.
        h.accrued += (h.eligible * (accGoldPerShare - h.snapshot)) / SCALE;
        h.snapshot = accGoldPerShare;

        uint256 bal = midasToken.balanceOf(user);
        _setEligible(user, bal >= threshold ? bal : 0);
    }

    /// @dev Move a wallet's eligible balance and keep supply + set in step.
    function _setEligible(address user, uint256 newEligible) internal {
        Holder storage h = holders[user];
        uint256 old = h.eligible;
        if (old == newEligible) return;

        eligibleSupply = eligibleSupply - old + newEligible;
        h.eligible = newEligible;

        if (old == 0 && newEligible > 0) {
            _eligibleList.push(user);
            _listIndex[user] = _eligibleList.length; // 1-based
        } else if (old > 0 && newEligible == 0) {
            uint256 idx = _listIndex[user];
            if (idx != 0) {
                uint256 last = _eligibleList.length;
                if (idx != last) {
                    address moved = _eligibleList[last - 1];
                    _eligibleList[idx - 1] = moved;
                    _listIndex[moved] = idx;
                }
                _eligibleList.pop();
                delete _listIndex[user];
            }
        }

        emit EligibilityChanged(user, old, newEligible);
    }

    // ---------------------------------------------------------------------
    // Distribution — O(1) regardless of holder count
    // ---------------------------------------------------------------------

    /**
     * @notice Pull `amount` of gold from the caller and credit it to holders.
     * @dev The caller must have approved this contract. If nothing is eligible,
     *      the gold is held in `carry` and folded into the next cycle rather
     *      than being stranded.
     */
    function distribute(uint256 amount) external nonReentrant {
        if (msg.sender != treasury) revert NotTreasury();
        if (amount == 0) revert NothingToDistribute();

        gld.safeTransferFrom(msg.sender, address(this), amount);

        uint256 payload = amount + carry;
        uint256 supply = eligibleSupply;

        if (supply == 0) {
            // Nobody qualifies yet. Hold it; the next cycle pays it out.
            carry = payload;
            emit Distributed(cycles, 0, 0, payload);
            return;
        }

        uint256 delta = (payload * SCALE) / supply;
        accGoldPerShare += delta;

        // SOLVENCY: `consumed` must round UP, and this is not cosmetic.
        //
        // A holder's entitlement is floored once, over the whole accumulated
        // accGoldPerShare. If this line floored per cycle instead, it would
        // reserve less than holders can eventually withdraw, because
        // sum(floor(x_i)) <= floor(sum(x_i)). The gap grows by up to a wei per
        // cycle and never closes, so after enough cycles the contract owes more
        // gold than it holds and the final holder in a batch cannot be paid.
        //
        // Rounding up keeps `consumed` an upper bound on what holders can
        // collectively claim, so the contract is always solvent. The cost is at
        // most one wei of extra carry per cycle, which the next cycle pays out.
        uint256 consumed = Math.ceilDiv(delta * supply, SCALE);
        carry = payload - consumed;

        totalDistributed += consumed;
        unchecked { ++cycles; }

        emit Distributed(cycles, consumed, supply, carry);
    }

    // ---------------------------------------------------------------------
    // Payout — bounded work per call
    // ---------------------------------------------------------------------

    /**
     * @notice Push gold to a page of holders. Anyone may call it; a keeper runs
     *         it every cycle so holders never have to do anything themselves.
     * @param start Index into the eligible set.
     * @param count Maximum wallets to process this call.
     */
    function pushBatch(uint256 start, uint256 count) external nonReentrant returns (uint256 paidCount, uint256 paidAmount) {
        uint256 len = _eligibleList.length;
        if (start >= len) return (0, 0);
        uint256 end = start + count;
        if (end > len) end = len;

        uint256 floor_ = minPayout;

        for (uint256 i = start; i < end; ++i) {
            address user = _eligibleList[i];
            Holder storage h = holders[user];

            h.accrued += (h.eligible * (accGoldPerShare - h.snapshot)) / SCALE;
            h.snapshot = accGoldPerShare;

            uint256 amt = h.accrued;
            if (amt == 0 || amt < floor_) continue;

            h.accrued = 0;
            paidAmount += amt;
            unchecked { ++paidCount; }

            gld.safeTransfer(user, amt);
            emit Paid(user, amt);
        }

        totalPaidOut += paidAmount;
    }

    /// @notice Permissionless fallback: pull your own gold at any time.
    function claim() external nonReentrant returns (uint256 amount) {
        _sync(msg.sender);
        Holder storage h = holders[msg.sender];
        amount = h.accrued;
        if (amount == 0) return 0;

        h.accrued = 0;
        totalPaidOut += amount;

        gld.safeTransfer(msg.sender, amount);
        emit Paid(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, _treasury);
        if (treasury != address(0)) excluded[treasury] = false;
        treasury = _treasury;
        excluded[_treasury] = true;
    }

    /**
     * @notice Change the qualifying balance.
     * @dev Existing wallets are re-derived lazily, on their next transfer or
     *      claim. `resync` exists to force it for a known list.
     */
    function setThreshold(uint256 _threshold) external onlyOwner {
        emit ThresholdUpdated(threshold, _threshold);
        threshold = _threshold;
    }

    function setExcluded(address account, bool isExcluded) external onlyOwner {
        excluded[account] = isExcluded;
        emit ExclusionUpdated(account, isExcluded);
        _sync(account);
    }

    function setMinPayout(uint256 _minPayout) external onlyOwner {
        emit MinPayoutUpdated(minPayout, _minPayout);
        minPayout = _minPayout;
    }

    /// @notice Force re-derivation of eligibility for specific wallets.
    function resync(address[] calldata accounts) external {
        for (uint256 i = 0; i < accounts.length; ++i) {
            _sync(accounts[i]);
        }
    }
}
