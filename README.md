<div align="center">

<img src="assets/logo/mark-trim.png" width="84" alt="MidasFi logo"/>

# MidasFi

**Hold the token. Get paid in real gold.**

<img src="assets/readme/wave.svg" width="100%" alt=""/>

[![Site](https://img.shields.io/badge/live-midasfi.net-C89A5C?style=for-the-badge)](https://midasfi.net)
[![Tests](https://img.shields.io/badge/tests-25%20passing-1E7A46?style=for-the-badge)]()
[![Chain](https://img.shields.io/badge/launch-Bags%20·%20Robinhood%20Chain-14110C?style=for-the-badge)]()
[![Status](https://img.shields.io/badge/status-pre--launch-E5B23E?style=for-the-badge)]()

</div>

---

## What it does

Every MidasFi trade on [Bags](https://bags.fm) carries a 2% fee — **1% goes to holders as gold**.
The fee accrues in WETH, buys **PAX Gold** (one token = one vaulted troy ounce, issued by Paxos),
and gets sent to every wallet holding **50,000+ MidasFi**. No claiming. No staking.

```mermaid
flowchart LR
    A["Trade on Bags\n(Robinhood Chain)"] -->|"2% fee in WETH"| B["BagsFeeShare\ncontract"]
    B -->|"claimFees()"| C["MidasTreasury"]
    C -->|"buys"| D["PAX Gold\n(Ethereum)"]
    D -->|"pro-rata, batched"| E["Every holder\n≥ 50,000 MidasFi"]
```

## What's in this repo

| Piece | Where | What it is |
|---|---|---|
| 🌐 Landing site | `index.html` | Live at [midasfi.net](https://midasfi.net) — static, zero build step |
| 📡 Read API | `api/` | Dependency-free chain reader; refuses to show fake numbers |
| 📜 Contracts | `protocol/contracts/` | `MidasDistributor` + `MidasTreasury`, Solidity 0.8.26 |
| 🤖 Keeper | `protocol/keeper/` | Runs the cycle: sync holders → claim WETH → buy gold → pay |
| 🪂 Airdrop | `protocol/airdrop/` | Crash-safe PAXG sender — splits **earned** fees, never promises fixed amounts |
| ✅ Tests | `protocol/test/` | 25 passing, including the two bugs below |

## Bugs the tests caught before they cost money

**The insolvency bug.** `distribute()` rounded down per cycle while holders round down once
over the accumulated total. Since `Σ floor(x) ≤ floor(Σ x)`, the contract slowly promised
more gold than it held — and the last holder's payout reverted. Fixed with ceiling division;
a regression test is named after it.

**The sync deadlock.** The eligibility cursor only advanced when *every* moved wallet was
resynced — so a launch-day volume spike would freeze it permanently. Cursor now advances on
read; the backlog drains across cycles.

## Honest status

- ⚠️ **Pre-launch.** No token exists yet; every figure on the site is labelled illustrative.
- ⚠️ **Not audited.** One internal security review (4 defects found & fixed) ≠ an audit.
- ⚠️ Gold is delivered as **PAXG on Ethereum** — same wallet address, different network.
  The site explains where to see it.

## Run it locally

```bash
cd protocol && npm install
npx hardhat test                                  # 25 tests
npx hardhat node                                  # local chain
npx hardhat run scripts/deploy.js --network localhost
RUN_ONCE=1 node keeper/keeper.js                  # one full cycle
```

<div align="center">
<img src="assets/readme/wave.svg" width="100%" alt=""/>
<sub>Built for Robinhood Chain · PAXG: <code>0x45804880De22913dAFE09f4980848ECE6EcbAf78</code> (Ethereum mainnet)</sub>
</div>
