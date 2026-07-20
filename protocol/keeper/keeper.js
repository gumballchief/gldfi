"use strict";

/**
 * Gold keeper — Bags launch model
 * ==================================
 * The off-chain service that actually runs the protocol. The contracts are
 * passive: they hold fee WETH forever unless something tells them to convert it
 * and pay people. That something is this.
 *
 * One cycle, in order:
 *
 *   1. SYNC    read Transfer events since the last cycle and resync only the
 *              wallets that moved. Bags deploys the token, so it cannot notify
 *              the distributor — without this step nobody's eligibility ever
 *              changes and payouts go to a stale holder set.
 *   2. CLAIM   pull accrued creator fees (WETH) out of the BagsFeeShare contract.
 *   3. CONVERT treasury buys gold with that WETH and credits holders. O(1).
 *   4. PAY     walk the eligible set in gas-bounded pages until drained.
 *
 * DESIGN RULES
 * ------------
 * - Simulate before sending. Every write is staticCall'd first, so a
 *   transaction that would revert is never paid for.
 * - Fail closed on price. minGoldOut comes from a live simulation minus a
 *   slippage bound. A bad quote reverts the swap and the WETH waits for the next
 *   cycle. Never widen the bound to "make it go through".
 * - Crash-safe. Every step is idempotent. pushBatch zeroes a holder's accrual
 *   before transferring, so a keeper that dies mid-run cannot double-pay.
 * - Resync is bounded per cycle. A viral launch can produce more transfers than
 *   fit in one transaction; the remainder rolls into the next cycle rather than
 *   blowing the gas limit.
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CFG = {
  rpcUrl: process.env.RPC_URL || "http://127.0.0.1:8545",
  privateKey: process.env.KEEPER_PRIVATE_KEY || null,
  chainId: Number(process.env.CHAIN_ID || 31337),

  intervalMs: Number(process.env.CYCLE_INTERVAL_MS || 15 * 60 * 1000),

  // Holders paid per transaction. ~62k gas each, so 75 is ~4.6M gas.
  batchSize: Number(process.env.BATCH_SIZE || 75),
  maxBatchesPerCycle: Number(process.env.MAX_BATCHES || 200),

  // Wallets resynced per transaction, and the cap per cycle.
  syncBatchSize: Number(process.env.SYNC_BATCH_SIZE || 100),
  maxSyncBatches: Number(process.env.MAX_SYNC_BATCHES || 20),
  // How far back to look on a cold start, in blocks.
  syncLookback: Number(process.env.SYNC_LOOKBACK || 50_000),
  // Blocks left unscanned at the head so a reorg cannot bury transfers we have
  // already marked as seen. Without this, a reorged block's transfers are never
  // re-queried and those holders' eligibility silently goes stale forever.
  confirmations: Number(process.env.CONFIRMATIONS || 5),

  slippageBps: Number(process.env.SLIPPAGE_BPS || 100), // 1.00%
  minConvertWei: BigInt(process.env.MIN_CONVERT_WEI || ethers.parseEther("0.01")),

  // A transaction that never mines must not hang the keeper forever.
  txTimeoutMs: Number(process.env.TX_TIMEOUT_MS || 180_000),

  dryRun: process.env.DRY_RUN === "1",
  once: process.env.RUN_ONCE === "1",
};

/**
 * Refuse to start on a configuration that would misbehave silently.
 * BATCH_SIZE=0 in particular is nasty: Math.ceil(n/0) is Infinity, so the
 * payout loop would run its full budget of pushBatch(start, 0) calls, pay
 * nobody, and report success.
 */
function validateConfig() {
  const problems = [];
  const positive = (k, v) => { if (!Number.isFinite(v) || v < 1) problems.push(`${k} must be >= 1 (got ${v})`); };

  positive("BATCH_SIZE", CFG.batchSize);
  positive("MAX_BATCHES", CFG.maxBatchesPerCycle);
  positive("SYNC_BATCH_SIZE", CFG.syncBatchSize);
  positive("MAX_SYNC_BATCHES", CFG.maxSyncBatches);
  positive("CYCLE_INTERVAL_MS", CFG.intervalMs);
  positive("TX_TIMEOUT_MS", CFG.txTimeoutMs);

  if (!Number.isFinite(CFG.confirmations) || CFG.confirmations < 0) {
    problems.push(`CONFIRMATIONS must be >= 0 (got ${CFG.confirmations})`);
  }
  // 10000 bps would set the floor to zero, which is the same as swapping with
  // no slippage protection at all — the exact thing the floor exists to prevent.
  if (!Number.isFinite(CFG.slippageBps) || CFG.slippageBps < 1 || CFG.slippageBps >= 10_000) {
    problems.push(`SLIPPAGE_BPS must be between 1 and 9999 (got ${CFG.slippageBps})`);
  }

  if (problems.length) {
    for (const p of problems) error("invalid config", { problem: p });
    throw new Error(`refusing to start: ${problems.length} config problem(s)`);
  }
}

/** Await a transaction, but never wait forever on one that will not mine. */
async function waitTx(txPromise, label) {
  const tx = await txPromise;
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`${label} not mined within ${CFG.txTimeoutMs}ms (tx ${tx.hash})`)), CFG.txTimeoutMs)
  );
  return Promise.race([tx.wait(), timeout]);
}

const ABI = {
  distributor: [
    "function eligibleCount() view returns (uint256)",
    "function eligibleSupply() view returns (uint256)",
    "function totalDistributed() view returns (uint256)",
    "function totalPaidOut() view returns (uint256)",
    "function cycles() view returns (uint256)",
    "function carry() view returns (uint256)",
    "function owed(address) view returns (uint256)",
    "function resync(address[]) external",
    "function pushBatch(uint256,uint256) returns (uint256,uint256)",
  ],
  treasury: [
    "function claimFees() returns (uint256)",
    "function convertAndDistribute(uint256,uint256) returns (uint256)",
    "function totalWethClaimed() view returns (uint256)",
    "function totalGoldDistributed() view returns (uint256)",
  ],
  router: ["function swapExactWethForGold(uint256,uint256,address) returns (uint256)"],
  erc20: [
    "function balanceOf(address) view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ],
};

const log = (lvl, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...(extra || {}) }));
const info = (m, e) => log("info", m, e);
const warn = (m, e) => log("warn", m, e);
const error = (m, e) => log("error", m, e);
const fmt = (v) => ethers.formatEther(v);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function loadDeployment() {
  const p = path.join(__dirname, "..", "deployments", `${CFG.chainId}.json`);
  if (!fs.existsSync(p)) throw new Error(`no deployment for chainId ${CFG.chainId} at ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function connect() {
  const provider = new ethers.JsonRpcProvider(CFG.rpcUrl);
  const d = loadDeployment();

  let signer;
  if (CFG.privateKey) {
    signer = new ethers.Wallet(CFG.privateKey, provider);
  } else {
    // Only ever fall back to an unlocked node account on a local chain.
    // Doing it silently against a real RPC would sign with whatever key that
    // node happens to hold, which is not a decision to make by default.
    const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(CFG.rpcUrl);
    if (!isLocal) {
      throw new Error("KEEPER_PRIVATE_KEY is required for any non-local RPC");
    }
    const accounts = await provider.send("eth_accounts", []);
    if (!accounts.length) throw new Error("no unlocked accounts and no KEEPER_PRIVATE_KEY");
    signer = await provider.getSigner(d.keeper || accounts[1] || accounts[0]);
    warn("local chain: using an unlocked node account");
  }

  const c = d.contracts;
  return {
    provider,
    signer,
    deployment: d,
    dist: new ethers.Contract(c.GoldDistributor, ABI.distributor, signer),
    treasury: new ethers.Contract(c.GoldTreasury, ABI.treasury, signer),
    token: new ethers.Contract(c.GoldToken || c.BagsToken, ABI.erc20, provider),
    weth: new ethers.Contract(c.WETH || c.MockWETH, ABI.erc20, provider),
    router: c.Router || c.MockRouter
      ? new ethers.Contract(c.Router || c.MockRouter, ABI.router, signer)
      : null,
    treasuryAddr: c.GoldTreasury,
  };
}

// ---------------------------------------------------------------------------
// 1. Sync eligibility from Transfer events
// ---------------------------------------------------------------------------

/**
 * The Bags token cannot call into the distributor, so eligibility is only ever
 * as fresh as the last resync. This reads Transfer logs since `fromBlock` and
 * resyncs the distinct addresses involved — typically a handful per cycle, not
 * the whole holder set, which is what keeps it affordable.
 */
async function syncHolders(ctx, state) {
  const head = await ctx.provider.getBlockNumber();

  // Stay a few blocks behind the tip. A reorg near the head would otherwise
  // replace blocks we had already marked as scanned, and the transfers on the
  // new chain at those heights would never be queried again.
  const safeHead = head - CFG.confirmations;
  if (safeHead < state.nextSyncBlock) {
    info("waiting for confirmations", { head, safeHead, nextSyncBlock: state.nextSyncBlock });
  } else {
    let logs;
    try {
      logs = await ctx.token.queryFilter(ctx.token.filters.Transfer(), state.nextSyncBlock, safeHead);
    } catch (e) {
      warn("could not read Transfer logs — will retry the same range next cycle", {
        fromBlock: state.nextSyncBlock, toBlock: safeHead, err: e.shortMessage || e.message,
      });
      logs = null;
    }

    if (logs) {
      for (const l of logs) {
        if (l.args.from !== ethers.ZeroAddress) state.pending.add(l.args.from);
        if (l.args.to !== ethers.ZeroAddress) state.pending.add(l.args.to);
      }
      // The cursor advances as soon as the range has been READ, not once every
      // address has been resynced. Anything unprocessed lives in `state.pending`
      // and drains over later cycles.
      //
      // Tying the cursor to completed resyncs instead deadlocks: when movers
      // exceed one cycle's budget the cursor never moves, so the next cycle
      // re-reads the same range against a newer head, the mover set grows, and
      // it falls further behind every cycle while re-syncing the same first
      // addresses forever. That happens precisely at launch, when volume peaks.
      state.nextSyncBlock = safeHead + 1;
    }
  }

  if (state.pending.size === 0) {
    info("no holders to sync");
    return;
  }

  const queue = [...state.pending];
  const capacity = CFG.syncBatchSize * CFG.maxSyncBatches;
  if (queue.length > capacity) {
    warn("sync backlog exceeds one cycle's budget — draining over multiple cycles", {
      pending: queue.length, capacityPerCycle: capacity,
    });
  }

  if (CFG.dryRun) {
    info("dry-run: would resync", { pending: queue.length });
    return;
  }

  let synced = 0;
  for (let i = 0; i < CFG.maxSyncBatches && synced < queue.length; i++) {
    const slice = queue.slice(synced, synced + CFG.syncBatchSize);
    try {
      await ctx.dist.resync.staticCall(slice);
    } catch (e) {
      error("resync would revert — leaving the rest queued for next cycle", {
        err: e.shortMessage || e.message,
      });
      break;
    }
    const rc = await waitTx(ctx.dist.resync(slice), "resync");
    // Only drop addresses once their transaction has actually mined.
    for (const a of slice) state.pending.delete(a);
    synced += slice.length;
    info("resynced holders", { count: slice.length, gas: rc.gasUsed.toString(), tx: rc.hash });
  }

  info("eligibility refreshed", {
    synced, stillPending: state.pending.size, nextSyncBlock: state.nextSyncBlock,
  });
}

// ---------------------------------------------------------------------------
// 2. Claim creator fees from Bags
// ---------------------------------------------------------------------------

async function claimFees(ctx) {
  if (CFG.dryRun) {
    info("dry-run: would claim Bags fees");
    return 0n;
  }
  try {
    const quoted = await ctx.treasury.claimFees.staticCall();
    if (quoted === 0n) {
      info("nothing to claim from Bags this cycle");
      return 0n;
    }

    // claimFees is permissionless, so someone else can claim between the quote
    // and the send. Report the balance actually gained rather than the quote —
    // a money log that prints a number the chain never moved is worse than no
    // log at all.
    const before = await ctx.weth.balanceOf(ctx.treasuryAddr);
    const rc = await waitTx(ctx.treasury.claimFees(), "claimFees");
    const claimed = (await ctx.weth.balanceOf(ctx.treasuryAddr)) - before;

    if (claimed === 0n) {
      info("claim landed empty — another caller claimed first", { quoted: fmt(quoted), tx: rc.hash });
      return 0n;
    }
    info("claimed Bags creator fees", { weth: fmt(claimed), gas: rc.gasUsed.toString(), tx: rc.hash });
    return claimed;
  } catch (e) {
    warn("claim skipped", { err: e.shortMessage || e.message });
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// 3. Convert WETH to gold
// ---------------------------------------------------------------------------

async function convert(ctx) {
  const wethBal = await ctx.weth.balanceOf(ctx.treasuryAddr);

  if (wethBal < CFG.minConvertWei) {
    info("skipping convert — below floor", { weth: fmt(wethBal), floor: fmt(CFG.minConvertWei) });
    return 0n;
  }
  if ((await ctx.dist.eligibleSupply()) === 0n) {
    info("skipping convert — no eligible holders yet", { weth: fmt(wethBal) });
    return 0n;
  }

  // Quote by simulating the REAL call path, not the router directly.
  //
  // Simulating the router from here always reverts: it pulls WETH with
  // transferFrom(msg.sender) and the keeper holds neither the WETH nor an
  // allowance — the treasury does, and it approves the router inside
  // convertAndDistribute. Simulating that function instead exercises the exact
  // sequence that will run, and returns the gold it would actually receive.
  let expected = 0n;
  try {
    expected = await ctx.treasury.convertAndDistribute.staticCall(wethBal, 0);
  } catch (e) {
    warn("convert simulation failed — skipping rather than swapping blind", {
      weth: fmt(wethBal), err: e.shortMessage || e.message,
    });
    return 0n;
  }

  const minOut = expected > 0n ? (expected * BigInt(10_000 - CFG.slippageBps)) / 10_000n : 0n;
  if (minOut === 0n) {
    warn("computed a zero slippage floor — refusing to swap", { expectedGold: fmt(expected) });
    return 0n;
  }

  if (CFG.dryRun) {
    info("dry-run: would convert", { weth: fmt(wethBal), expectedGold: fmt(expected), minGoldOut: fmt(minOut) });
    return expected;
  }

  // Re-simulate with the real bound, so a price move between the quote and the
  // send is caught here rather than costing gas on a reverting transaction.
  try {
    await ctx.treasury.convertAndDistribute.staticCall(wethBal, minOut);
  } catch (e) {
    warn("convert would revert at the slippage bound — leaving WETH for next cycle", {
      weth: fmt(wethBal), minGoldOut: fmt(minOut), err: e.shortMessage || e.message,
    });
    return 0n;
  }

  const rc = await waitTx(ctx.treasury.convertAndDistribute(wethBal, minOut), "convertAndDistribute");
  info("converted and credited holders", {
    weth: fmt(wethBal), minGoldOut: fmt(minOut), gas: rc.gasUsed.toString(), tx: rc.hash,
  });
  return expected;
}

// ---------------------------------------------------------------------------
// 4. Pay everyone, in gas-bounded pages
// ---------------------------------------------------------------------------

async function payout(ctx) {
  const count = Number(await ctx.dist.eligibleCount());
  if (count === 0) {
    info("nothing to pay — no eligible holders");
    return { batches: 0, holders: 0 };
  }

  const pages = Math.ceil(count / CFG.batchSize);
  const limit = Math.min(pages, CFG.maxBatchesPerCycle);
  if (pages > CFG.maxBatchesPerCycle) {
    warn("holder count exceeds one cycle's batch budget — remainder rolls forward", {
      holders: count, pagesNeeded: pages, budget: CFG.maxBatchesPerCycle,
    });
  }

  if (CFG.dryRun) {
    info("dry-run: would pay", { holders: count, batches: limit });
    return { batches: limit, holders: count };
  }

  let batches = 0, holdersPaid = 0, paid = 0n, gas = 0n;

  for (let i = 0; i < limit; i++) {
    const start = i * CFG.batchSize;
    let sim;
    try {
      sim = await ctx.dist.pushBatch.staticCall(start, CFG.batchSize);
    } catch (e) {
      error("batch would revert — stopping this cycle", { start, err: e.shortMessage || e.message });
      break;
    }
    const [n, amount] = sim;
    if (n === 0n) continue;

    const rc = await waitTx(ctx.dist.pushBatch(start, CFG.batchSize), "pushBatch");
    batches++; holdersPaid += Number(n); paid += amount; gas += rc.gasUsed;
    info("paid batch", { start, holders: Number(n), gold: fmt(amount), gas: rc.gasUsed.toString(), tx: rc.hash });
  }

  info("payout complete", { batches, holdersPaid, gold: fmt(paid), gas: gas.toString() });
  return { batches, holders: holdersPaid };
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

async function runCycle(ctx, state) {
  const started = Date.now();
  info("cycle start", { dryRun: CFG.dryRun, syncFrom: state.nextSyncBlock, pending: state.pending.size });

  await syncHolders(ctx, state);
  await claimFees(ctx);
  await convert(ctx);
  const res = await payout(ctx);

  const [cycles, dist_, paid, eligible, carry] = await Promise.all([
    ctx.dist.cycles(), ctx.dist.totalDistributed(), ctx.dist.totalPaidOut(),
    ctx.dist.eligibleCount(), ctx.dist.carry(),
  ]);

  info("cycle done", {
    ms: Date.now() - started,
    cycles: cycles.toString(),
    eligibleHolders: eligible.toString(),
    totalDistributedGold: fmt(dist_),
    totalPaidOutGold: fmt(paid),
    carryWei: carry.toString(),
    batchesThisCycle: res.batches,
  });
}

async function main() {
  validateConfig();
  const ctx = await connect();
  const net = await ctx.provider.getNetwork();
  const head = await ctx.provider.getBlockNumber();

  const state = { nextSyncBlock: Math.max(0, head - CFG.syncLookback), pending: new Set() };

  info("keeper online", {
    chainId: Number(net.chainId),
    keeper: await ctx.signer.getAddress(),
    distributor: await ctx.dist.getAddress(),
    treasury: ctx.treasuryAddr,
    intervalMs: CFG.intervalMs,
    batchSize: CFG.batchSize,
    slippageBps: CFG.slippageBps,
    syncFromBlock: state.nextSyncBlock,
    dryRun: CFG.dryRun,
  });

  let running = false;
  const tick = async () => {
    if (running) {
      warn("previous cycle still running — skipping this tick");
      return;
    }
    running = true;
    try {
      await runCycle(ctx, state);
    } catch (e) {
      // One bad cycle must never kill the process; the next retries from
      // whatever on-chain state actually exists.
      error("cycle failed", { err: e.shortMessage || e.message });
    } finally {
      running = false;
    }
  };

  await tick();
  if (CFG.once) return;

  setInterval(tick, CFG.intervalMs);
  process.on("SIGINT", () => { info("keeper stopping"); process.exit(0); });
  process.on("SIGTERM", () => { info("keeper stopping"); process.exit(0); });
}

if (require.main === module) {
  main().catch((e) => { error("fatal", { err: e.message }); process.exit(1); });
}

module.exports = { runCycle, syncHolders, claimFees, convert, payout, connect, CFG };
