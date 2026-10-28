import { createStandardRollup } from "@sovereign-sdk/web3";
import { Secp256k1Signer } from "@sovereign-sdk/signers";
import { computeAddress, getAddress } from "ethers";

// Security checks for native (non-EVM) Sovereign transactions: replay, forged signatures, token admin rights,
// supply cap, balances. Usage: npm run security   (node must be running; uses the dev keys from genesis)
const url = process.env.ROLLUP_URL ?? "http://127.0.0.1:12346";
const rollup = await createStandardRollup({ url });

// Dev keys from testing/test-data/keys: admin holds most SEL; user is a plain account with 1e9 SEL for gas.
const adminKey = "0187c12ea7c12024b3f70ac5d73587463af17c8bce2bd9e6fe87389310196c64";
const userKey = "0d87c12ea7c12024b3f70a26d735874608f17c8bce2b48e6fe87389310191264";
const admin = new Secp256k1Signer(adminKey);
const user = new Secp256k1Signer(userKey);
const adminAddr = computeAddress(`0x${adminKey}`).toLowerCase();
const userAddr = computeAddress(`0x${userKey}`).toLowerCase();

const results: { name: string; ok: boolean; detail: string; expect: string }[] = [];
async function check(name: string, fn: () => Promise<string | void>, expect = "works") {
  try {
    results.push({ name, ok: true, expect, detail: (await fn()) ?? "" });
  } catch (e: any) {
    results.push({ name, ok: false, expect, detail: String(e?.message ?? e).slice(0, 160) });
  }
  const r = results.at(-1)!;
  console.log(`${r.ok ? "PASS" : r.expect === "info" ? "WARN" : "FAIL"}  ${name}${r.detail ? `  — ${r.detail}` : ""}`);
}
const get = async (path: string) => (await fetch(url + path)).json();
// A tx "succeeded" only if the sequencer accepted it and its receipt says so.
const outcome = (res: any): string => {
  const r = res?.response ?? res;
  return r?.receipt?.result ?? r?.result ?? r?.status ?? JSON.stringify(r).slice(0, 80);
};
const errOf = (e: any) => String(e?.error?.message ?? e?.message ?? e).replace(/\s+/g, " ").slice(0, 110);
async function mustFail(fn: () => Promise<any>): Promise<string> {
  let res: any;
  try { res = await fn(); } catch (e) { return `rejected: ${errOf(e)}`; }
  const o = outcome(res);
  if (o === "successful") throw new Error("tx executed successfully");
  return `not executed: ${o}`;
}
// The bank REST API only accepts checksummed addresses.
const balance = async (addr: string, token: string) => {
  const r = await get(`/modules/bank/tokens/${token}/balances/${getAddress(addr)}`);
  if (r.amount == null) throw new Error(`balance lookup failed: ${r.message ?? JSON.stringify(r)}`);
  return BigInt(r.amount);
};
const call = (msg: any, signer: Secp256k1Signer) => rollup.call(msg, { signer });

console.log(`Selendra native-tx security checks on ${url}\n`);
const gasToken: string = (await get("/modules/bank/tokens/gas_token")).token_id;

// --- replay & forgery ---
const tx = await rollup.prepareCall({ value_setter: { set_value: 41 } } as any, { signer: user });
const first = await rollup.submitTransaction(tx);
console.log(`(setup) value_setter.set_value by user → ${outcome(first)}`);
await check("re-submitting an already executed tx is rejected (replay)", () => mustFail(() => rollup.submitTransaction(tx)));

// Flip one byte of the signature, and separately change the call under the original signature.
const flipSig = (t: any): any => {
  const c = structuredClone(t);
  const walk = (o: any): boolean => {
    for (const k of Object.keys(o ?? {})) {
      if (k === "signature" && o[k] != null) {
        const s = o[k];
        if (typeof s === "string") o[k] = s.slice(0, 10) + (s[10] === "0" ? "1" : "0") + s.slice(11);
        else if (s instanceof Uint8Array || Array.isArray(s)) s[5] ^= 0xff;
        else if (typeof s === "object") { const kk = Object.keys(s)[0]; s[kk] = flipSig({ signature: s[kk] }).signature; }
        return true;
      }
      if (typeof o[k] === "object" && walk(o[k])) return true;
    }
    return false;
  };
  if (!walk(c)) throw new Error(`no signature field found in tx: ${JSON.stringify(Object.keys(c))}`);
  return c;
};
const fresh = await rollup.prepareCall({ value_setter: { set_value: 42 } } as any, { signer: user });
await check("tx with a corrupted signature is rejected", () => mustFail(() => rollup.submitTransaction(flipSig(fresh))));
await check("tx whose call was changed after signing is rejected", () => {
  const forged = JSON.parse(JSON.stringify(fresh).replace(/("set_value":)\s*42/, "$1 1337"));
  if (JSON.stringify(forged) === JSON.stringify(fresh)) throw new Error("could not locate call payload to tamper");
  return mustFail(() => rollup.submitTransaction(forged));
});
await check("value-setter has no access control (example module: any account can set it)", async () => {
  const v = (await get("/modules/value-setter/state/value")).value;
  if (v === 41) throw new Error(`plain user ${userAddr} set value to ${v}`);
  return `value ${v}`;
}, "info");

// --- token permissions ---
const created = await call({ bank: { create_token: {
  admins: [adminAddr], token_decimals: 8, supply_cap: 1_000_000, token_name: `SecTest-${Date.now()}`,
  initial_balance: 900_000, mint_to_address: adminAddr } } }, admin);
const ev = JSON.stringify((created as any).response?.events ?? (created as any).response ?? "");
const tokenId = ev.match(/token_1[02-9ac-hj-np-z]+/)?.[0];
console.log(`(setup) admin creates token with cap 1,000,000 → ${outcome(created)} ${tokenId ?? "(token id not found in events)"}`);

if (tokenId) {
  await check("non-admin can't mint a token they don't administer", () =>
    mustFail(() => call({ bank: { mint: { coins: { amount: 10, token_id: tokenId }, mint_to_address: userAddr } } }, user)));
  await check("admin can't mint beyond the supply cap", () =>
    mustFail(() => call({ bank: { mint: { coins: { amount: 200_000, token_id: tokenId }, mint_to_address: adminAddr } } }, admin)));
  await check("can't transfer a token you don't hold", () =>
    mustFail(() => call({ bank: { transfer: { to: adminAddr, coins: { amount: 1, token_id: tokenId } } } }, user)));
  await check("can't burn someone else's balance", async () => {
    const before = await balance(adminAddr, tokenId);
    const r = await mustFail(() => call({ bank: { burn: { coins: { amount: 1_000, token_id: tokenId } } } }, user));
    if ((await balance(adminAddr, tokenId)) !== before) throw new Error("admin balance changed");
    return r;
  });
}
await check("non-admin can't mint the gas token (SEL)", () =>
  mustFail(() => call({ bank: { mint: { coins: { amount: 1, token_id: gasToken }, mint_to_address: userAddr } } }, user)));
await check("transfer above balance is rejected and balances don't move", async () => {
  const before = await balance(userAddr, gasToken);
  const r = await mustFail(() => call({ bank: { transfer: { to: adminAddr, coins: { amount: (before * 1000n).toString(), token_id: gasToken } } } }, user));
  if ((await balance(userAddr, gasToken)) > before) throw new Error("user balance grew");
  return r;
});
await check("non-admin can't freeze the gas token", () =>
  mustFail(() => call({ bank: { freeze: { token_id: gasToken } } }, user)));

const must = results.filter((r) => r.expect === "works");
const failed = must.filter((r) => !r.ok);
const warns = results.filter((r) => r.expect === "info" && !r.ok);
console.log(`\n${must.length - failed.length}/${must.length} required checks passed; ${warns.length} warnings to review.`);
process.exit(failed.length ? 1 : 0);
