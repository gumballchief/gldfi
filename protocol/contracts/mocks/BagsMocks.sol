// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice WETH stand-in. Only the ERC-20 surface matters here — the treasury
///         never wraps or unwraps, it just receives and spends the token.
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/**
 * @notice Stand-in for the token Bags deploys.
 *
 * The important detail is what it does NOT do: it has no hook into the
 * distributor. Bags mints this contract, so MidasFi cannot make it report
 * balance changes. Testing against a plain ERC-20 is the point — it proves the
 * distributor's eligibility tracking works purely from keeper-driven `resync`,
 * which is the only mechanism that will exist in production.
 */
contract MockBagsToken is ERC20 {
    constructor(address holder, uint256 supply) ERC20("MidasFi", "MIDASFI") {
        _mint(holder, supply);
    }
}

/// @notice Stand-in for the per-token BagsFeeShare contract. Accrues WETH and
///         releases it to the registered claimer when `claim` is called.
contract MockBagsFeeShare {
    IERC20 public immutable weth;
    address public claimer;

    constructor(IERC20 _weth, address _claimer) {
        weth = _weth;
        claimer = _claimer;
    }

    function setClaimer(address c) external { claimer = c; }

    /// @dev Sends the whole accrued balance, mirroring a pro-rata claim where
    ///      this claimer holds 100% of the basis points.
    function claim() external {
        uint256 bal = weth.balanceOf(address(this));
        if (bal > 0) weth.transfer(claimer, bal);
    }
}
