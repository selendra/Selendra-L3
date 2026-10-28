// Security suite for Selendra's EVM path and node API: replay, signature, chain-ID, balance, size and nonce checks,
// node-held-key RPC methods and API hardening. Run with the node up: `npm run security` (or `make selendra-security`).
// Prints one line per check and a summary. Exit code is 1 if any required check fails.
import { Signature, Transaction, Wallet, hexlify, parseEther, randomBytes, toBeHex } from "ethers";
import { CHAIN_ID, RPC_URL, SelendraWallet, connect } from "../src/config.js";

const { provider, wallet } = connect();
const API = new URL(RPC_URL).origin;
const results = [];
let area = "";

// expect: "works" (the security property must hold) or "info" (reported as WARN when it does not hold: a finding to
// review, usually a dev-genesis setting). Only "works" can fail the run.
async function check(name, fn, expect = "works") {
  try {
    const detail = await fn();
    results.push({ area, name, ok: true, expect, detail: detail ?? "" });
  } catch (e) {
    const msg = e?.info?.error?.message ?? e?.error?.message ?? e?.shortMessage ?? e?.message ?? String(e);
    results.push({ area, name, ok: false, expect, detail: msg.slice(0, 160) });
  }
  const r = results.at(-1);
  const tag = r.ok ? "PASS" : r.expect === "info" ? "WARN" : "FAIL";
  console.log(`${tag}  ${area.padEnd(9)} ${name}${r.detail ? `  — ${r.detail}` : ""}`);
}
const assert = (c, m) => { if (!c) throw new Error(m ?? "assertion failed"); };
const rpc = (m, p = []) => provider.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => e?.info?.error?.message ?? e?.error?.message ?? e?.shortMessage ?? e?.message ?? String(e);
// Runs `fn`, which must throw; returns the rejection reason so it shows up in the report.
const rejected = async (fn) => {
  let res;
  try { res = await fn(); } catch (e) { return `rejected: ${errMsg(e).slice(0, 110)}`; }
  throw new Error(`accepted (${typeof res === "string" ? res : JSON.stringify(res ?? null).slice(0, 80)})`);
};
const sendTx = async (tx) => (await wallet.sendTransaction(tx)).wait();
const freshWallet = async (sel = "0.05") => {
  const w = new SelendraWallet(Wallet.createRandom().privateKey, provider);
  if (sel) await sendTx({ to: w.address, value: parseEther(sel) });
  return w;
};
// Signs a raw tx directly with the key, so ethers can't refuse or rewrite fields (chain ID, nonce, s value).
const fees = async () => {
  const f = await provider.getFeeData();
  return { maxFeePerGas: f.maxFeePerGas * 2n, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 1n };
};
const signRaw = async (w, fields) => {
  const tx = Transaction.from({ type: 2, chainId: CHAIN_ID, gasLimit: 21000n, value: 1n, data: "0x", ...(await fees()), ...fields });
  tx.signature = w.signingKey.sign(tx.unsignedHash);
  return tx;
};
const broadcast = (raw) => rpc("eth_sendRawTransaction", [raw]);
const waitMined = async (hash, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const r = await provider.getTransactionReceipt(hash);
    if (r) return r;
  }
  throw new Error(`tx ${hash} not mined in ${ms} ms`);
};
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // secp256k1 order

console.log(`Selendra security suite — ${await rpc("web3_clientVersion")} on ${RPC_URL}\n`);
const alice = await freshWallet("0.1");
const sink = Wallet.createRandom().address;
// The RPC can briefly report a stale nonce right after inclusion (see config.js), so track alice's nonce here:
// only txs that were actually mined advance it.
let aliceNonce = 0;

// ---------- replay & signatures ----------
area = "replay";
await check("re-broadcast of an included tx is rejected", async () => {
  const tx = await signRaw(alice, { to: sink, nonce: aliceNonce });
  await waitMined(await broadcast(tx.serialized));
  aliceNonce++;
  return rejected(() => broadcast(tx.serialized));
});
await check("second tx with an already-used nonce is rejected (no double spend)", async () => {
  const nonce = aliceNonce - 1;
  return rejected(async () => waitMined(await broadcast((await signRaw(alice, { to: sink, nonce, value: 2n })).serialized), 6000));
});
await check("tx signed for another chain ID (1) is rejected", async () =>
  rejected(async () => broadcast((await signRaw(alice, { to: sink, nonce: aliceNonce, chainId: 1n })).serialized)));
await check("pre-EIP-155 legacy tx (no chain ID, cross-chain replayable) is rejected", async () => {
  const tx = Transaction.from({ type: 0, to: sink, value: 1n, gasLimit: 21000n, nonce: aliceNonce,
    gasPrice: (await fees()).maxFeePerGas });
  tx.signature = alice.signingKey.sign(tx.unsignedHash);
  assert(tx.chainId === 0n, "ethers produced a protected tx");
  return rejected(async () => waitMined(await broadcast(tx.serialized), 6000));
});
area = "sig";
await check("high-s (malleable) signature is rejected (EIP-2)", async () => {
  const tx = await signRaw(alice, { to: sink, nonce: aliceNonce });
  const s = BigInt(tx.signature.s);
  tx.signature = Signature.from({ r: tx.signature.r, s: toBeHex(N - s, 32), yParity: tx.signature.yParity ^ 1 });
  return rejected(async () => waitMined(await broadcast(tx.serialized), 6000));
});
await check("tampered tx (value changed after signing) can't spend the signer's funds", async () => {
  const before = await provider.getBalance(alice.address);
  const tx = await signRaw(alice, { to: sink, nonce: aliceNonce, value: 1n });
  const forged = Transaction.from({ ...tx.toJSON(), value: parseEther("0.09"), signature: tx.signature });
  assert(forged.from.toLowerCase() !== alice.address.toLowerCase(), "forged tx still recovers to alice");
  const reason = await rejected(async () => waitMined(await broadcast(forged.serialized), 6000));
  assert((await provider.getBalance(alice.address)) === before, "alice's balance changed");
  return reason;
});
await check("garbage raw tx bytes are rejected", async () => rejected(() => broadcast(hexlify(randomBytes(120)))));

// ---------- balances & limits ----------
area = "balance";
await check("unfunded account can't transfer value", async () => {
  const w = new SelendraWallet(Wallet.createRandom().privateKey, provider);
  return rejected(async () => waitMined(await broadcast((await signRaw(w, { to: sink, nonce: 0, value: parseEther("1") })).serialized), 6000));
});
await check("value above balance is rejected and balance is unchanged", async () => {
  const before = await provider.getBalance(alice.address);
  const reason = await rejected(async () =>
    waitMined(await broadcast((await signRaw(alice, { to: sink, nonce: aliceNonce, value: before * 10n })).serialized), 6000));
  assert((await provider.getBalance(alice.address)) <= before, "balance grew");
  return reason;
});
await check("unfunded account can't execute a zero-value tx for free (gas must be paid)", async () => {
  const w = new SelendraWallet(Wallet.createRandom().privateKey, provider);
  return rejected(async () => waitMined(await broadcast((await signRaw(w, { to: sink, nonce: 0, value: 0n })).serialized), 8000));
}, "info");
area = "limits";
await check("gas limit above the block gas limit is rejected", async () => {
  const { gasLimit } = await provider.getBlock("latest");
  let hash;
  try {
    hash = await broadcast((await signRaw(alice, { to: sink, nonce: aliceNonce, gasLimit: gasLimit + 1n })).serialized);
  } catch (e) {
    const m = errMsg(e).match(/Transaction gas limit \d+ exceeds the chain gas limit \d+/);
    assert(m, `rejected for another reason: ${errMsg(e).slice(0, 120)}`);
    return `rejected: ${m[0]}`;
  }
  throw new Error(`accepted (${hash})`);
});
await check("gas limit exactly at the block gas limit is still accepted", async () => {
  const { gasLimit } = await provider.getBlock("latest");
  const r = await waitMined(await broadcast((await signRaw(alice, { to: sink, nonce: aliceNonce, gasLimit })).serialized));
  aliceNonce++;
  assert(r.status === 1, `status ${r.status}`);
  return `mined, gas used ${r.gasUsed}`;
});
await check("tx larger than MAX_TX_SIZE (1 MiB) is rejected", async () => {
  const data = hexlify(randomBytes(1_100_000));
  return rejected(async () => broadcast((await signRaw(alice, { to: sink, nonce: aliceNonce, data, gasLimit: 40_000_000n })).serialized));
});
await check("future nonce (gap) does not execute out of order", async () => {
  const nonce = aliceNonce;
  let hash;
  try { hash = await broadcast((await signRaw(alice, { to: sink, nonce: nonce + 5 })).serialized); } catch (e) { return `rejected: ${errMsg(e).slice(0, 100)}`; }
  await sleep(6000);
  assert(!(await provider.getTransactionReceipt(hash)), "gapped tx was mined");
  assert((await provider.getTransactionCount(alice.address, "latest")) === nonce, "nonce advanced");
  return "accepted into pool but not executed";
});

// ---------- node-held keys & debug RPC ----------
area = "rpc";
await check("eth_accounts exposes no node-held accounts", async () => {
  const a = await rpc("eth_accounts").catch(() => []);
  assert(a.length === 0, `node exposes ${a.length} accounts`);
});
for (const [m, p] of [
  ["eth_sendTransaction", [{ from: wallet.address, to: sink, value: "0x1" }]],
  ["eth_sign", [wallet.address, "0xdeadbeef"]],
  ["personal_unlockAccount", [wallet.address, "", 60]],
  ["personal_sendTransaction", [{ from: wallet.address, to: sink, value: "0x1" }, ""]],
  ["admin_addPeer", ["enode://00@127.0.0.1:30303"]],
  ["miner_start", []],
  ["debug_setHead", ["0x1"]],
]) await check(`${m} is not available`, () => rejected(() => rpc(m, p)));

// ---------- HTTP API hardening ----------
area = "api";
const http = (path, init) => fetch(API + path, init);
await check("sequencer test-utils endpoints are not exposed", async () => {
  const r = await http("/sequencer/test-utils/force-close-batch", { method: "POST" });
  assert(r.status === 404 || r.status === 405, `status ${r.status}`);
  return `status ${r.status}`;
});
await check("malformed tx body to /sequencer/txs returns 4xx", async () => {
  const r = await http("/sequencer/txs", { method: "POST", headers: { "content-type": "application/json" }, body: '{"body":"not-base64!!"}' });
  assert(r.status >= 400 && r.status < 500, `status ${r.status}`);
  return `status ${r.status}`;
});
await check("oversized request body (20 MB) is refused", async () => {
  const r = await http("/sequencer/txs", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "A".repeat(20_000_000) }) }).catch((e) => ({ status: `conn closed (${e.cause?.code ?? e.message})` }));
  assert(r.status !== 200 && r.status !== 201, `status ${r.status}`);
  return `status ${r.status}`;
});
await check("oversized JSON-RPC batch (5,000 calls) doesn't crash the node", async () => {
  const batch = Array.from({ length: 5000 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_blockNumber", params: [] }));
  const r = await http("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) });
  return `status ${r.status}`;
});
await check("node is still healthy after the abuse above", async () => {
  const r = await http("/sequencer/ready");
  assert(r.ok, `status ${r.status}`);
  return `block ${await provider.getBlockNumber()}`;
});
await check("CORS does not allow arbitrary origins", async () => {
  const r = await http("/rpc", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  const allow = r.headers.get("access-control-allow-origin");
  assert(!allow || (allow !== "*" && allow !== "https://evil.example"), `Access-Control-Allow-Origin: ${allow}`);
  return `Access-Control-Allow-Origin: ${allow ?? "(none)"}`;
}, "info");

// ---------- summary ----------
const must = results.filter((r) => r.expect === "works");
const failed = must.filter((r) => !r.ok);
const warns = results.filter((r) => r.expect === "info" && !r.ok);
console.log(`\n${must.length - failed.length}/${must.length} required security checks passed; ${warns.length} warnings to review.`);
if (failed.length) console.log("Failed:\n" + failed.map((r) => `  - [${r.area}] ${r.name}: ${r.detail}`).join("\n"));
if (warns.length) console.log("Warnings:\n" + warns.map((r) => `  - [${r.area}] ${r.name}: ${r.detail}`).join("\n"));
process.exit(failed.length ? 1 : 0);
