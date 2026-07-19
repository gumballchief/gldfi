# MidasFi protocol — contracts

MidasFi launches through **Bags on Robinhood Chain**. Bags charges 2% on the
WETH leg of every trade and splits it evenly — 1% to the Bags protocol, 1% to
this token's fee claimers. That 1% is what buys gold for holders.

Everything here compiles, is tested, and runs a full cycle on a local chain.
**Nothing is audited and nothing is deployed to a real network.**

---

## What Bags provides, and what we build

Bags deploys the token, the bonding curve and a per-token `BagsFeeShare`
contract. Token supply is fixed at 1e9 with 18 decimals; liquidity locks
automatically when the curve graduates to Uniswap v4. **We do not deploy a token
and we do not collect the fee** — Bags does both.

| Contract | What it does |
|---|---|
| `MidasTreasury.sol` | Claims WETH creator fees out of `BagsFeeShare`, converts them to gold, hands the gold to the distributor. No owner path to withdraw either asset. |
| `MidasDistributor.sol` | Works out who is owed what, and pays them. Where the real complexity lives. |

`MockWETH`, `MockGLD` (stands in for PAX Gold locally), `MockBagsToken`,
`MockBagsFeeShare` and `MockRouter` stand in for the real things so the whole
loop runs locally. In production the gold token is PAXG on Ethereum mainnet:
`0x45804880De22913dAFE09f4980848ECE6EcbAf78`.

### Removed when the launch moved to Bags

`MidasToken.sol` and `MidasFeeHook.sol` are gone, along with the Uniswap v4 hook
integration suite. The hook took 3% of the ETH leg inside a v4 pool and was
verified against a real `PoolManager` — but Bags collects the fee, so it had no
job left. Worth knowing it existed if the launch ever moves off Bags.

---

## The constraint that shapes everything

The obvious design — "loop over every holder and send them gold" — cannot work.
At a few thousand holders one distribution exceeds the block gas limit, and the
protocol breaks precisely when it succeeds.

**Accounting is O(1).** A distribution moves one number, `accGoldPerShare`.
Measured at ~233k gas whether there are 4 holders or 400. Entitlement is derived
on read:

```
owed(you) = your_balance × (accGoldPerShare − your_last_snapshot)
```

**Payout is batched.** A keeper walks the holder set in pages via `pushBatch`, so
holders never claim anything but no single transaction runs out of gas.
`claim()` stays open as a permissionless fallback.

Measured on 400 holders: **~62k gas each, so roughly 480 holders per 30M block.**
1,000 holders is ~2 blocks per cycle; 10,000 is ~21 transactions every 15
minutes; beyond that the threshold has to rise or payouts move to claim-only.
Raising the qualifying balance is the cheapest lever on that cost — it is
currently **50,000 MidasFi**.

## Eligibility is keeper-driven, and that is not optional

Bags deploys the token, so it cannot call into our distributor when balances
move. Nothing updates on its own. Each cycle the keeper reads `Transfer` events
since the last run and calls `resync` on just the addresses that moved —
typically a handful, not the whole holder set.

If the keeper stops, eligibility freezes at the last sync. Gold already credited
is still claimable; new buyers simply do not start earning until it runs again.
There is a test named `does NOT see a transfer until someone resyncs` that pins
this behaviour down, because it is the sharpest edge in the design.

---

## The bug that was found and fixed

`distribute()` was **insolvent by design**, and the tests caught it: after 25
cycles the contract believed it owed 2,623 wei of gold while holding 2,600, and
`pushBatch` reverted paying the last holder.

It rounded down once per cycle, while `owed()` rounds down once over the whole
accumulated total. Because `sum(floor(x)) ≤ floor(sum(x))`, the promise drifts
above the reserve a wei or two every cycle and never recovers — perfect in
testing, failing in production after a few thousand cycles. Fixed by rounding the
consumed amount **up** (`Math.ceilDiv`). Regression test is named for it.

---

## What is proven (25 tests)

- eligibility tracked purely from keeper-driven `resync`, with a plain ERC-20
  that cannot notify the distributor — the production condition
- WETH creator fees claimed out of `BagsFeeShare`; claiming is permissionless so
  fees keep flowing even if every keeper dies
- the wallet-forwards-WETH fallback also works, in case Bags will not accept a
  contract as a fee claimer
- the treasury credits what actually arrived, not what the router claimed
- it reverts rather than accept a bad price, and leaves no standing allowance
- no owner path to withdraw the gold or the WETH
- pro-rata splits exact; buying in earns nothing retroactively; falling below the
  threshold stops accrual but never claws back
- solvency holds across many awkward, indivisible cycles
- batches page correctly and never double-pay, even overlapping a `claim()`
- splitting a balance across wallets earns exactly the same (no sybil gain)

## Not proven, and it matters

- **Nothing is audited.**
- **Whether Bags accepts a contract as a fee claimer is unconfirmed.** If it does,
  register the treasury and fees are untouchable. If it does not, fees land in a
  wallet first and the trust story changes — the site copy must then say so.
- **`MockGLD` and `MockRouter` are placeholders.** Real deployment needs the actual
  gold token on Robinhood Chain and an adapter over a venue that genuinely has
  liquidity. Thin liquidity means the treasury's buys move the price against
  holders. This is the biggest external dependency.
- **The keeper passed one internal security review** (4 defects found and fixed:
  a sync-cursor deadlock under launch load, a reorg blind spot, overlapping
  cycles colliding on nonces, and no tx timeout) — but that is not an external
  audit, and an external audit has not happened.

---

## Running it

```bash
cd protocol
npm install

npx hardhat test                                     # 25 tests
npx hardhat node                                     # local chain on :8545
npx hardhat run scripts/deploy.js --network localhost
RUN_ONCE=1 node keeper/keeper.js                     # one full cycle
DRY_RUN=1 RUN_ONCE=1 node keeper/keeper.js           # simulate, send nothing
```

The keeper's cycle is: sync eligibility from Transfer events → claim WETH from
Bags → convert to gold → pay in batches. Config and env in `keeper/.env.example`.

## The airdrop path (`airdrop/`)

Because no real tokenized gold exists on Robinhood Chain yet, the launch plan
delivers gold as **PAXG on Ethereum mainnet** with a standalone runner:
`airdrop/airdrop.js`. Dry-run by default, crash-safe (`state.json` records every
send before the next starts), refuses bad recipient lists and gas spikes, and in
its default `split` mode divides only what the wallet actually holds — the
payout is earned fee income, never a promised number. The on-chain treasury
route above becomes usable the day real gold is issued on Robinhood Chain.

## Parameters

| Parameter | Value | Changeable |
|---|---|---|
| Supply | 1,000,000,000 | No — fixed by Bags |
| Trade fee | 2% (1% Bags, 1% MidasFi) | No — set by Bags |
| Qualifying balance | 50,000 MidasFi | Yes — owner, on-chain |
| Interval | ~15 min | Off-chain, keeper-driven |
| Asset bought | one gold token | No — immutable in the treasury |

## Trust assumptions

The owner **can**: change the threshold, the router, the fee-share address, and
the keeper set; exclude addresses from earning; rescue non-gold, non-WETH tokens.

The owner **cannot**: withdraw gold or WETH, mint tokens, or change what the
treasury buys.

The router is the weakest link — an owner pointing it at a malicious contract
could waste treasury WETH. A timelock on `setRouter` is the highest-value
hardening left.
