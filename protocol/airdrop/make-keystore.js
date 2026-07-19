"use strict";

/**
 * Create an ENCRYPTED keystore for the airdrop wallet — so the private key
 * never sits readable on disk. You paste the key once, it is encrypted with a
 * password you choose (scrypt, the same format geth uses), and only the
 * encrypted file is saved. The airdrop asks for the password at runtime and
 * holds the key in memory only.
 *
 *   node make-keystore.js
 *
 * Both prompts hide what you type. The plaintext key is never written anywhere.
 */

const { Wallet } = require("ethers");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const OUT = path.join(__dirname, "airdrop.keystore.json");

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const orig = rl._writeToOutput.bind(rl);
    rl.question(question, (ans) => { rl._writeToOutput = orig; rl.close(); process.stdout.write("\n"); resolve(ans.trim()); });
    rl._writeToOutput = (str) => { orig(str.includes(question) ? str : "*"); };
  });
}

async function main() {
  if (fs.existsSync(OUT)) throw new Error(`${OUT} already exists — delete it first if you really mean to replace it`);

  const key = await promptHidden("wallet private key (hidden): ");
  const wallet = new Wallet(key); // throws on an invalid key before anything is saved

  const pw = await promptHidden("password to encrypt it with (hidden): ");
  const pw2 = await promptHidden("same password again (hidden): ");
  if (pw !== pw2) throw new Error("passwords do not match — nothing saved");
  if (pw.length < 8) throw new Error("use at least 8 characters — nothing saved");

  console.log("encrypting (takes a few seconds)...");
  fs.writeFileSync(OUT, await wallet.encrypt(pw), { mode: 0o600 });
  console.log(`\nsaved ${OUT}`);
  console.log(`wallet address: ${wallet.address}`);
  console.log("The airdrop will ask for this password each run. The key itself is not on disk.");
}

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
