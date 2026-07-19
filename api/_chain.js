/**
 * Minimal, dependency-free chain reader.
 *
 * Deliberately no ethers import: the site deploys to Vercel as pure static
 * files with no build step, and adding a node_modules tree just to read four
 * integers would change that. Node 18+ has global fetch, and every call here is
 * a no-argument view function, so the ABI encoding is a hardcoded 4-byte
 * selector and the decoding is one BigInt.
 *
 * Selectors were generated with ethers `id(sig).slice(0,10)` — see the note in
 * protocol/README.md if a signature ever changes.
 */

const SEL = {
  totalDistributed: "0xefca2eed",
  totalPaidOut: "0x1357e1dc",
  cycles: "0x6dbe5554",
  eligibleCount: "0x630cb4dc",
  eligibleSupply: "0x6ade07b0",
  carry: "0xf02ec765",
  threshold: "0x42cde4e8",
  // MidasTreasury (Bags/WETH model). The old totalEthReceived/Converted
  // selectors died with the native-ETH treasury — querying them would revert
  // and silently pin the site to its pre-launch state.
  totalWethClaimed: "0xd6a61f65",
  totalWethConverted: "0xa5a3dcbc",
};

// event Distributed(uint256 indexed cycle, uint256 amount, uint256 eligibleSupply, uint256 carried)
const TOPIC_DISTRIBUTED =
  "0xf7576d8c2653e9d07af5ef229acf59b339e327d4e0eaddb4a96615534cf148f8";

const RPC_URL = process.env.RPC_URL || "";
const DISTRIBUTOR = process.env.DISTRIBUTOR_ADDRESS || "";
const TREASURY = process.env.TREASURY_ADDRESS || "";

/** Is the protocol actually deployed and readable? */
function isConfigured() {
  return Boolean(RPC_URL && DISTRIBUTOR);
}

async function rpc(method, params, { timeoutMs = 4000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result;
  } finally {
    clearTimeout(t);
  }
}

/** Call a no-argument view function and return the raw uint256 as a BigInt. */
async function readUint(to, selector) {
  const hex = await rpc("eth_call", [{ to, data: selector }, "latest"]);
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

/** 18-decimal fixed point -> a plain JS number, for display only. */
function toUnits(wei, decimals = 18) {
  const d = 10n ** BigInt(decimals);
  const whole = wei / d;
  const frac = wei % d;
  return Number(whole) + Number(frac) / Number(d);
}

/**
 * Everything the site needs, in one shot.
 *
 * Returns `deployed:false` when the protocol is not configured or unreachable.
 * That flag is load-bearing: the front end must keep showing its clearly
 * labelled illustrative content in that case rather than rendering zeros as if
 * they were real measurements.
 */
async function getStats() {
  if (!isConfigured()) {
    return { deployed: false, reason: "not_configured" };
  }

  try {
    const [
      totalDistributed, totalPaidOut, cycles,
      eligibleCount, eligibleSupply, carry, threshold,
    ] = await Promise.all([
      readUint(DISTRIBUTOR, SEL.totalDistributed),
      readUint(DISTRIBUTOR, SEL.totalPaidOut),
      readUint(DISTRIBUTOR, SEL.cycles),
      readUint(DISTRIBUTOR, SEL.eligibleCount),
      readUint(DISTRIBUTOR, SEL.eligibleSupply),
      readUint(DISTRIBUTOR, SEL.carry),
      readUint(DISTRIBUTOR, SEL.threshold),
    ]);

    let wethClaimed = 0n, wethConverted = 0n;
    if (TREASURY) {
      [wethClaimed, wethConverted] = await Promise.all([
        readUint(TREASURY, SEL.totalWethClaimed),
        readUint(TREASURY, SEL.totalWethConverted),
      ]);
    }

    // A protocol that has never run is deployed but has nothing to report.
    // Say so explicitly rather than shipping a wall of zeros.
    const hasRun = cycles > 0n;

    return {
      deployed: true,
      hasRun,
      goldDistributed: toUnits(totalDistributed),
      goldPaidOut: toUnits(totalPaidOut),
      cycles: Number(cycles),
      holders: Number(eligibleCount),
      eligibleSupply: toUnits(eligibleSupply),
      carryWei: carry.toString(),
      threshold: toUnits(threshold),
      wethClaimed: toUnits(wethClaimed),
      wethConverted: toUnits(wethConverted),
      readAt: new Date().toISOString(),
    };
  } catch (e) {
    return { deployed: false, reason: "unreachable", error: String(e.message || e) };
  }
}

/** The most recent distribution events, newest first. */
async function getDistributions(limit = 10) {
  if (!isConfigured()) return { deployed: false, reason: "not_configured", distributions: [] };

  try {
    const headHex = await rpc("eth_blockNumber", []);
    const head = BigInt(headHex);
    // Public RPCs commonly cap getLogs ranges; 50k blocks is a safe window.
    const from = head > 50_000n ? head - 50_000n : 0n;

    const logs = await rpc("eth_getLogs", [{
      address: DISTRIBUTOR,
      topics: [TOPIC_DISTRIBUTED],
      fromBlock: "0x" + from.toString(16),
      toBlock: "latest",
    }], { timeoutMs: 8000 });

    const rows = (logs || []).map((l) => {
      // data = amount, eligibleSupply, carried (each 32 bytes); cycle is indexed
      const d = l.data.slice(2);
      const word = (i) => BigInt("0x" + d.slice(i * 64, (i + 1) * 64));
      return {
        cycle: Number(BigInt(l.topics[1])),
        gold: toUnits(word(0)),
        eligibleSupply: toUnits(word(1)),
        block: Number(BigInt(l.blockNumber)),
        tx: l.transactionHash,
      };
    });

    rows.sort((a, b) => b.block - a.block);
    return { deployed: true, distributions: rows.slice(0, limit) };
  } catch (e) {
    return { deployed: false, reason: "unreachable", error: String(e.message || e), distributions: [] };
  }
}

module.exports = { getStats, getDistributions, isConfigured };
