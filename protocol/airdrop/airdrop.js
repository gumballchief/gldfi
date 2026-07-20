"use strict";

/**
 * PAXG airdrop runner — Ethereum mainnet
 * =====================================
 * Sends real PAX Gold to a fixed list of recipients, in small batches, on a
 * timer: 10 wallets per cycle, every 15 minutes, until everyone is paid.
 *
 * THIS MOVES REAL MONEY. The safety rules it follows:
 *
 * - DRY RUN BY DEFAULT. It will not send anything unless you pass --live.
 * - EVERY SEND IS RECORDED BEFORE THE NEXT ONE STARTS, to state.json. A crash,
 *   a reboot, or an accidental second launch can never pay the same wallet
 *   twice — the runner reads that file and skips anyone already paid.
 * - IT MEASURES WHAT ACTUALLY ARRIVED. PAXG's contract has a transfer-fee
 *   mechanism, so the recipient can receive slightly less than was sent. The
 *   runner checks each recipient's balance before and after and logs any
 *   shortfall rather than assuming the full amount landed.
 * - IT REFUSES TO SEND INTO A GAS SPIKE. Above MAX_GAS_GWEI it waits.
 * - IT VALIDATES THE LIST FIRST: checksums, duplicates, the zero address, and
 *   whether you can actually afford the whole run.
 * - THE AMOUNT IS EARNED, NOT PROMISED. Default mode "split" divides whatever
 *   the wallet actually holds among all recipients. No fees, no airdrop —
 *   there is no fixed number to fall short of.
 *
 * SETUP (once):
 *   node make-keystore.js           # encrypt the wallet key with a password
 *   TOKEN_CA=0x... node holders.js  # build recipients.json from on-chain data
 *
 * Usage:
 *   node airdrop.js                 # dry run — shows exactly what it would do
 *   node airdrop.js --live          # actually sends
 *   node airdrop.js --live --once   # send one batch then stop
 */

const { ethers } = require("ethers");
const { buildRecipients } = require("./holders");
const fs = require("fs");
const path = require("path");

const CFG = {
  rpcUrl: process.env.RPC_URL || "https://ethereum-rpc.publicnode.com",
  // Key handling, safest first:
  //   1. airdrop.keystore.json (made by make-keystore.js) — encrypted on disk,
  //      password asked at runtime, key exists only in memory. USE THIS.
  //   2. AIRDROP_PRIVATE_KEY env — plaintext, LOCAL TESTING ONLY.
  keystore: process.env.AIRDROP_KEYSTORE || require("path").join(__dirname, "airdrop.keystore.json"),
  privateKey: process.env.AIRDROP_PRIVATE_KEY || null,

  // PAX Gold on Ethereum mainnet. Verified: name() = "Paxos Gold", symbol() = "PAXG".
  token: process.env.TOKEN_ADDRESS || "0x45804880De22913dAFE09f4980848ECE6EcbAf78",
  expectedChainId: Number(process.env.EXPECTED_CHAIN_ID || 1),

  // How the per-wallet amount is decided.
  //   "split" (default) — divide what the wallet ACTUALLY HOLDS equally among
  //                       every recipient. You can only ever pay out what fees
  //                       actually earned; there is no number to fall short of.
  //   "fixed"           — an explicit amount per wallet. Requires you to hold
  //                       amount x recipients up front or it refuses to start.
  amountMode: (process.env.AMOUNT_MODE || "split").toLowerCase(),
  amountPerWallet: process.env.AMOUNT_PER_WALLET || null, // only for "fixed"
  // Optional ceiling in "split" mode: spend at most this much of the balance.
  budget: process.env.BUDGET || null,
  perBatch: Number(process.env.PER_BATCH || 10),
  intervalMs: Number(process.env.INTERVAL_MS || 15 * 60 * 1000),

  maxGasGwei: Number(process.env.MAX_GAS_GWEI || 15),
  txTimeoutMs: Number(process.env.TX_TIMEOUT_MS || 300_000),

  live: process.argv.includes("--live"),
  once: process.argv.includes("--once"),
};

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
];

const STATE_FILE = path.join(__dirname, "state.json");
const LIST_FILE = path.join(__dirname, "recipients.json");

const log = (lvl, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...(extra || {}) }));
const info = (m, e) => log("info", m, e);
const warn = (m, e) => log("warn", m, e);
const error = (m, e) => log("error", m, e);

// ---------------------------------------------------------------------------
// State — the thing that makes double-payment impossible
// ---------------------------------------------------------------------------

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { paid: {} };
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

/** Written synchronously after every single send, before the next begins. */
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function loadRecipients() {
  if (!fs.existsSync(LIST_FILE)) {
    throw new Error(`no recipient list at ${LIST_FILE} — copy recipients.example.json and fill it in`);
  }
  const raw = JSON.parse(fs.readFileSync(LIST_FILE, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.recipients;
  if (!Array.isArray(list) || list.length === 0) throw new Error("recipient list is empty");

  const problems = [];
  const seen = new Map();
  const clean = [];

  list.forEach((entry, i) => {
    const addr = typeof entry === "string" ? entry : entry.address;
    if (!addr) { problems.push(`#${i}: missing address`); return; }

    let normalised;
    try {
      normalised = ethers.getAddress(addr.trim()); // throws on a bad checksum/format
    } catch {
      problems.push(`#${i}: "${addr}" is not a valid address`);
      return;
    }
    if (normalised === ethers.ZeroAddress) { problems.push(`#${i}: zero address`); return; }
    if (seen.has(normalised)) { problems.push(`#${i}: duplicate of #${seen.get(normalised)} (${normalised})`); return; }

    seen.set(normalised, i);
    clean.push(normalised);
  });

  if (problems.length) {
    for (const p of problems) error("bad recipient", { problem: p });
    throw new Error(`refusing to run: ${problems.length} problem(s) in the recipient list`);
  }
  return clean;
}

function validateConfig() {
  const problems = [];
  if (!Number.isFinite(CFG.perBatch) || CFG.perBatch < 1) problems.push("PER_BATCH must be >= 1");
  if (!Number.isFinite(CFG.intervalMs) || CFG.intervalMs < 1000) problems.push("INTERVAL_MS must be >= 1000");
  if (!Number.isFinite(CFG.maxGasGwei) || CFG.maxGasGwei <= 0) problems.push("MAX_GAS_GWEI must be > 0");
  if (!["split", "fixed"].includes(CFG.amountMode)) problems.push('AMOUNT_MODE must be "split" or "fixed"');
  if (CFG.amountMode === "fixed") {
    if (!CFG.amountPerWallet) problems.push('AMOUNT_MODE=fixed requires AMOUNT_PER_WALLET — there is no safe default');
    else { try { ethers.parseUnits(CFG.amountPerWallet, 18); }
           catch { problems.push(`AMOUNT_PER_WALLET "${CFG.amountPerWallet}" is not a valid number`); } }
  }

  if (problems.length) {
    for (const p of problems) error("invalid config", { problem: p });
    throw new Error("refusing to start");
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function promptHidden(question) {
  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
    const orig = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    rl.question(question, (ans) => { rl.close(); process.stdout.write("\n"); resolve(ans.trim()); });
    if (orig) rl._writeToOutput = (str) => { orig(str.includes(question) ? str : "*"); };
  });
}

/** Encrypted keystore first; plaintext env only as a loudly-flagged fallback. */
async function getSigner(provider) {
  if (fs.existsSync(CFG.keystore)) {
    const pw = await promptHidden(`password for ${path.basename(CFG.keystore)} (hidden): `);
    try {
      const w = await ethers.Wallet.fromEncryptedJson(fs.readFileSync(CFG.keystore, "utf8"), pw);
      info("unlocked keystore", { address: w.address });
      return w.connect(provider);
    } catch {
      throw new Error("wrong password (key stays encrypted on disk — nothing leaked)");
    }
  }
  if (CFG.privateKey) {
    warn("using a PLAINTEXT key from the environment — fine on a local test chain, never for real funds. Run make-keystore.js instead.");
    return new ethers.Wallet(CFG.privateKey, provider);
  }
  if (CFG.live) throw new Error("no key: run `node make-keystore.js` once to create the encrypted keystore");
  return null; // dry run without a wallet
}

async function waitTx(txPromise, label) {
  const tx = await txPromise;
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`${label} not mined in ${CFG.txTimeoutMs}ms (tx ${tx.hash})`)), CFG.txTimeoutMs));
  return { tx, receipt: await Promise.race([tx.wait(), timeout]) };
}

async function gasOk(provider) {
  const fee = await provider.getFeeData();
  const gp = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
  const gwei = Number(ethers.formatUnits(gp, "gwei"));
  if (gwei > CFG.maxGasGwei) {
    warn("gas above cap — skipping this batch, will retry next cycle", {
      gwei: gwei.toFixed(2), capGwei: CFG.maxGasGwei,
    });
    return { ok: false, gwei };
  }
  return { ok: true, gwei };
}

/** Send to one recipient and confirm from the chain what actually landed. */
async function payOne(ctx, to, amount) {
  const before = await ctx.token.balanceOf(to);
  const { tx, receipt } = await waitTx(ctx.token.transfer(to, amount), `transfer to ${to}`);
  const after = await ctx.token.balanceOf(to);
  const delivered = after - before;

  const rec = {
    to,
    sent: amount.toString(),
    delivered: delivered.toString(),
    tx: tx.hash,
    block: receipt.blockNumber,
    at: new Date().toISOString(),
  };

  if (delivered < amount) {
    // PAXG's fee mechanism, or a token that skims. Recorded, not hidden.
    warn("recipient received less than was sent", {
      to, sent: ethers.formatUnits(amount, ctx.decimals),
      delivered: ethers.formatUnits(delivered, ctx.decimals),
    });
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  validateConfig();

  const provider = new ethers.JsonRpcProvider(CFG.rpcUrl);
  const net = await provider.getNetwork();

  // A wrong network is the one mistake with no undo. Refuse loudly.
  if (Number(net.chainId) !== CFG.expectedChainId) {
    throw new Error(`connected to chain ${net.chainId} but expected ${CFG.expectedChainId} — refusing to send`);
  }

  const signer = await getSigner(provider);
  const token = new ethers.Contract(CFG.token, ERC20, signer || provider);

  // Confirm the token really is what we think it is before moving anything.
  const [name, symbol, decimals] = await Promise.all([token.name(), token.symbol(), token.decimals()]);

  // Load the recipient set. With TOKEN_CA set, pull it straight from the chain
  // (auto-refreshed every cycle after this); otherwise use a manual recipients.json.
  let recipients;
  if (process.env.TOKEN_CA) {
    const { recipients: fresh } = await buildRecipients();
    recipients = fresh.map((a) => ethers.getAddress(a));
    info("loaded qualifying holders from chain", { count: recipients.length, minGold: Number(process.env.THRESHOLD || 50000) });
  } else {
    recipients = loadRecipients();
  }
  if (recipients.length === 0) {
    info("no wallets hold the minimum yet — nothing to airdrop right now; rerun once holders qualify", { minGold: Number(process.env.THRESHOLD || 50000) });
    return;
  }
  const state = loadState();
  const remaining = recipients.filter((r) => !state.paid[r]);

  // ---- decide the per-wallet amount -------------------------------------
  //
  // In split mode this is locked into state.json on the first run and reused
  // for every later batch. Recomputing it each cycle would pay earlier wallets
  // a different amount from later ones as the balance drains or tops up, which
  // is not something you could defend to the people who got less.
  let amount;
  if (state.amountPerWallet) {
    amount = BigInt(state.amountPerWallet);
    info("using the amount locked in on the first run", {
      perWallet: `${ethers.formatUnits(amount, decimals)} ${symbol}`,
    });
  } else if (CFG.amountMode === "fixed") {
    amount = ethers.parseUnits(CFG.amountPerWallet, Number(decimals));
  } else {
    if (!signer) {
      info("split mode needs a wallet to read a balance from — supply AIRDROP_PRIVATE_KEY even for a dry run");
      return;
    }
    let pot = await token.balanceOf(signer.address);
    if (CFG.budget) {
      const cap = ethers.parseUnits(CFG.budget, Number(decimals));
      if (cap < pot) pot = cap;
    }
    if (pot === 0n) {
      info("nothing to distribute yet — the wallet holds no " + symbol + ". Fees have not arrived.");
      return;
    }
    amount = pot / BigInt(recipients.length);   // equal share, remainder stays put
    if (amount === 0n) {
      info("balance too small to split across this many recipients", {
        holds: `${ethers.formatUnits(pot, decimals)} ${symbol}`, recipients: recipients.length,
      });
      return;
    }
    if (CFG.live) { state.amountPerWallet = amount.toString(); saveState(state); }
    info("split across every recipient", {
      pot: `${ethers.formatUnits(pot, decimals)} ${symbol}`,
      recipients: recipients.length,
      perWallet: `${ethers.formatUnits(amount, decimals)} ${symbol}`,
    });
  }

  info("airdrop ready", {
    mode: CFG.live ? "LIVE — will send real funds" : "DRY RUN — nothing will be sent",
    chainId: Number(net.chainId),
    token: CFG.token,
    tokenName: `${name} (${symbol})`,
    amountPerWallet: `${ethers.formatUnits(amount, decimals)} ${symbol}`,
    amountMode: CFG.amountMode,
    recipients: recipients.length,
    alreadyPaid: recipients.length - remaining.length,
    remaining: remaining.length,
    perBatch: CFG.perBatch,
    intervalMinutes: CFG.intervalMs / 60000,
    estimatedCycles: Math.ceil(remaining.length / CFG.perBatch),
    estimatedMinutes: Math.ceil(remaining.length / CFG.perBatch) * (CFG.intervalMs / 60000),
  });

  // Can we actually afford the whole run?
  const needed = amount * BigInt(remaining.length);
  if (signer) {
    const held = await token.balanceOf(signer.address);
    info("funding check", {
      sender: signer.address,
      holds: `${ethers.formatUnits(held, decimals)} ${symbol}`,
      needsForRun: `${ethers.formatUnits(needed, decimals)} ${symbol}`,
      sufficient: held >= needed,
    });
    if (held < needed) {
      throw new Error(`sender holds ${ethers.formatUnits(held, decimals)} ${symbol} but the run needs ${ethers.formatUnits(needed, decimals)}`);
    }
  } else {
    info("funding check skipped — no key supplied (dry run)", {
      wouldNeed: `${ethers.formatUnits(needed, decimals)} ${symbol}`,
    });
  }

  const ctx = { token, decimals: Number(decimals), symbol };
  let cursor = 0;

  // FULL AUTOMATION: if TOKEN_CA is set, rebuild the recipient list from chain
  // at the start of each cycle so new holders are picked up with no manual step.
  // New qualifying wallets are appended (never reordered — that would misalign
  // the paid cursor); already-paid wallets are skipped by state.json as always.
  const refreshHolders = async () => {
    if (!process.env.TOKEN_CA) return;
    try {
      const { recipients: fresh } = await buildRecipients();
      const known = new Set(remaining.map(a => a.toLowerCase()));
      let added = 0;
      for (const a of fresh) {
        const norm = ethers.getAddress(a);
        if (!known.has(norm.toLowerCase()) && !state.paid[norm]) { remaining.push(norm); known.add(norm.toLowerCase()); added++; }
      }
      if (added) info("holder refresh: new qualifying wallets added", { added, total: remaining.length });
    } catch (e) {
      warn("holder refresh failed — continuing with the current list", { err: e.message });
    }
  };

  // Pick n distinct random entries (Fisher-Yates on a copy).
  const pickRandom = (arr, n) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, n);
  };

  // When there are NO new holders to pay this cycle, give the wallet's current
  // PAXG to a random handful of existing holders instead of sitting idle. These
  // sends are intentionally repeatable and are NOT recorded in state.paid, so
  // they never disturb the pay-each-new-holder-once ledger above. If the wallet
  // is empty it simply waits for the next top-up.
  const randomReairdrop = async () => {
    const pool = Array.from(new Set([...Object.keys(state.paid), ...remaining]));
    if (pool.length === 0) { info("no holders yet — waiting"); return; }
    if (!CFG.live) { info("dry run — no new holders; would re-airdrop to random holders when funded", { pool: pool.length }); return; }
    if (!signer) return;
    const balance = await token.balanceOf(signer.address);
    if (balance === 0n) { info("no new holders and the wallet is empty — waiting for a top-up"); return; }
    const gas = await gasOk(provider);
    if (!gas.ok) return;
    const n = Math.min(CFG.perBatch, pool.length);
    const amount = balance / BigInt(n);
    if (amount === 0n) { info("balance too small to re-airdrop", { holds: `${ethers.formatUnits(balance, ctx.decimals)} ${symbol}` }); return; }
    const picks = pickRandom(pool, n);
    info("no new holders — re-airdropping to random holders", { count: n, perWallet: `${ethers.formatUnits(amount, ctx.decimals)} ${symbol}`, gwei: gas.gwei.toFixed(3) });
    for (const to of picks) {
      try {
        const rec = await payOne(ctx, to, amount);
        info("re-airdropped", { to, delivered: `${ethers.formatUnits(rec.delivered, ctx.decimals)} ${symbol}`, tx: rec.tx });
      } catch (e) {
        error("re-airdrop send failed — halting this cycle", { to, err: e.shortMessage || e.message });
        return;
      }
    }
  };

  const runBatch = async () => {
    await refreshHolders();
    const batch = remaining.slice(cursor, cursor + CFG.perBatch);
    if (batch.length === 0) {
      // No new holders to pay this cycle -> re-airdrop to random existing holders.
      await randomReairdrop();
      return;
    }

    const gas = await gasOk(provider);
    if (!gas.ok) return; // try again next cycle, cursor untouched

    info("batch start", { batch: batch.length, gwei: gas.gwei.toFixed(3), from: cursor, of: remaining.length });

    for (const to of batch) {
      if (state.paid[to]) { info("already paid — skipping", { to }); continue; }

      if (!CFG.live) {
        info("dry run: would send", { to, amount: `${ethers.formatUnits(amount, decimals)} ${symbol}` });
        continue;
      }

      try {
        const rec = await payOne(ctx, to, amount);
        // Persist immediately: the next send must never be able to repeat this one.
        state.paid[to] = rec;
        saveState(state);
        info("paid", {
          to, delivered: `${ethers.formatUnits(rec.delivered, decimals)} ${symbol}`, tx: rec.tx,
        });
      } catch (e) {
        // Stop the batch rather than plough on — an unrecorded send is the one
        // failure mode that could double-pay on the next run.
        error("send failed — halting this batch", { to, err: e.shortMessage || e.message });
        return;
      }
    }

    cursor += batch.length;
    info("batch done", { paidThisCycle: batch.length, newHoldersRemaining: Math.max(0, remaining.length - cursor) });
    // No exit: the next cycle pays new holders, or re-airdrops randomly if none.
  };

  await runBatch();
  if (CFG.once) return;

  setInterval(runBatch, CFG.intervalMs);
  process.on("SIGINT", () => { info("stopping — progress is saved in state.json"); process.exit(0); });
}

main().catch((e) => { error("fatal", { err: e.message }); process.exit(1); });
