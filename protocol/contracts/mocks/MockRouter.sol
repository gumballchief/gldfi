// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockGLD} from "./MockGLD.sol";

/// @notice Deterministic WETH -> gold venue for local tests.
/// @dev Real deployments plug in a thin adapter over whatever venue actually
///      holds gold liquidity. The treasury measures what it received rather
///      than trusting the return value, so a hostile router cannot inflate
///      the accounting — `skimBps` exists to prove exactly that.
contract MockRouter {
    IERC20 public immutable weth;
    MockGLD public immutable gold;

    /// @notice Gold minted per 1 WETH, in gold wei. Settable to simulate price moves.
    uint256 public goldPerWeth;

    /// @notice Basis points of the output silently withheld.
    uint256 public skimBps;

    error Slippage(uint256 got, uint256 min);

    constructor(IERC20 _weth, MockGLD _gold, uint256 _goldPerWeth) {
        weth = _weth;
        gold = _gold;
        goldPerWeth = _goldPerWeth;
    }

    function setGoldPerWeth(uint256 v) external { goldPerWeth = v; }
    function setSkimBps(uint256 v) external { skimBps = v; }

    function swapExactWethForGold(uint256 amountIn, uint256 minGoldOut, address recipient)
        external
        returns (uint256 goldOut)
    {
        weth.transferFrom(msg.sender, address(this), amountIn);

        goldOut = (amountIn * goldPerWeth) / 1 ether;
        if (skimBps > 0) goldOut -= (goldOut * skimBps) / 10_000;
        if (goldOut < minGoldOut) revert Slippage(goldOut, minGoldOut);

        gold.mint(recipient, goldOut);
    }
}
