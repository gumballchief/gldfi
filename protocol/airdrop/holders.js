"use strict";

/**
 * Build recipients.json from ON-CHAIN data, not a hand-typed list.
 *
 *   TOKEN_CA=0x... node holders.js
 *
 * Reads every holder of the token from the chain explorer, keeps wallets at or
 * above the threshold, drops contracts (pools, lockers — they are not people),
 * drops anything in EXCLUDE, caps at MAX_RECIPIENTS, and writes recipients.json
 * in exactly the format airdrop.js consumes.
 *
 * Env:
 *   TOKEN_CA        (required) the token contract on Robinhood Chain
 *   THRESHOLD       min balance to qualify, default 50000
 *   EXCLUDE         comma-separated addresses to skip (deployer, treasury...)
 *   MAX_RECIPIENTS  default 1000
 *   EXPLORER        default https://robinhoodchain.blockscout.com/api/v2
 */

const fs = require("fs");
const path = require("path");

const CFG = {
  token: process.env.TOKEN_CA || "",
  threshold: Number(process.env.THRESHOLD || 50_000),
  exclude: new Set((process.env.EXCLUDE || "").split(",").map(a => a.trim().toLowerCase()).filter(Boolean)),
  max: Number(process.env.MAX_RECIPIENTS || 1000),
  explorer: (process.env.EXPLORER || "https://robinhoodchain.blockscout.com/api/v2").replace(/\/$/, ""),
};

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json();
}

async function main() {
  if (!/^0x[0-9a-fA-F]{40}$/.test(CFG.token)) {
    throw new Error("set TOKEN_CA to the token contract address");
  }

  // Confirm the token exists and read its decimals — a typo'd CA must fail
  // loudly here, not produce an empty airdrop list.
  const tok = await getJSON(`${CFG.explorer}/tokens/${CFG.token}`);
  if (tok.message === "Not found") throw new Error(`no token at ${CFG.token} on this chain`);
  const decimals = BigInt(tok.decimals || 18);
  const thresholdWei = BigInt(CFG.threshold) * 10n ** decimals;
  console.log(`token: ${tok.name} (${tok.symbol}), ${tok.holders || "?"} holders on chain`);
  console.log(`threshold: ${CFG.threshold.toLocaleString()} ${tok.symbol}`);

  const qualifying = [];
  let url = `${CFG.explorer}/tokens/${CFG.token}/holders`;
  let dropped = { belowThreshold: 0, contracts: 0, excluded: 0 };

  // Holders come back sorted by balance descending, paginated.
  for (let page = 0; page < 200; page++) {
    const data = await getJSON(url);
    let belowFound = false;

    for (const item of data.items || []) {
      const bal = BigInt(item.value || "0");
      if (bal < thresholdWei) { dropped.belowThreshold++; belowFound = true; continue; }

      const a = item.address || {};
      const addr = (a.hash || "").toLowerCase();
      if (!addr) continue;
      if (a.is_contract) { dropped.contracts++; continue; }        // pools, lockers, curves
      if (CFG.exclude.has(addr)) { dropped.excluded++; continue; } // deployer, team wallets

      qualifying.push(a.hash);
    }

    // Sorted descending, so once we see a balance under threshold we are done.
    if (belowFound || !data.next_page_params) break;
    const q = new URLSearchParams(data.next_page_params).toString();
    url = `${CFG.explorer}/tokens/${CFG.token}/holders?${q}`;
  }

  let list = qualifying;
  if (list.length > CFG.max) {
    console.log(`NOTE: ${list.length} qualify but MAX_RECIPIENTS=${CFG.max} — keeping the ${CFG.max} largest`);
    list = list.slice(0, CFG.max);
  }
  if (list.length === 0) throw new Error("zero qualifying wallets — check TOKEN_CA and THRESHOLD");

  const out = path.join(__dirname, "recipients.json");
  fs.writeFileSync(out, JSON.stringify({
    _source: { token: CFG.token, chainExplorer: CFG.explorer, threshold: CFG.threshold, generatedAt: new Date().toISOString() },
    recipients: list,
  }, null, 2));

  console.log(`\nrecipients.json written: ${list.length} wallets`);
  console.log(`dropped: ${dropped.belowThreshold} below threshold, ${dropped.contracts} contracts, ${dropped.excluded} excluded`);
}

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
