// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Stand-in for tokenized SPDR Gold Shares in local tests.
contract MockGLD is ERC20 {
    constructor() ERC20("Tokenized SPDR Gold Shares", "GLD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
