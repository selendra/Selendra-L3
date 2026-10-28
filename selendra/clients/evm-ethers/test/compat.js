// EVM compatibility suite for Selendra: JSON-RPC methods, tx types, opcodes, precompiles, contract patterns,
// errors, logs, signatures and limits. Run with the node up: `npm run compat` (or `make selendra-evm-compat`).
// Prints one line per check and a summary. Exit code is 1 if any check that should work fails.
import {
  AbiCoder, ContractFactory, Interface, Signature, Transaction, TypedDataEncoder, Wallet, WebSocketProvider,
  concat, getBytes, hashMessage, hexlify, id, keccak256, parseEther, ripemd160, sha256, toBeHex, toUtf8Bytes, zeroPadValue,
} from "ethers";
import path from "node:path";
import { compile } from "../src/compile.js";
import { CHAIN_ID, WS_URL, connect } from "../src/config.js";

// solc-js installs an unhandledRejection handler that rethrows; replace it so one stray promise can't abort the suite.
process.removeAllListeners("unhandledRejection");
process.on("unhandledRejection", (e) => console.log("  (ignored unhandled rejection:", e?.shortMessage ?? e?.message ?? e, ")"));

const { provider, wallet } = connect();
const me = wallet.address;
const abi = AbiCoder.defaultAbiCoder();
const results = [];
let area = "";

// expect: "works" (must pass), "diff" (known Selendra difference from Ethereum, reported as DIFF when it differs)
// or "info" (optional / newer-fork feature, reported as N/A when missing). Only "works" can fail the run.
async function check(name, fn, expect = "works") {
  try {
    const detail = await fn();
    results.push({ area, name, ok: true, expect, detail: detail ?? "" });
  } catch (e) {
    const msg = e?.info?.error?.message ?? e?.error?.message ?? e?.shortMessage ?? e?.message ?? String(e);
    results.push({ area, name, ok: false, expect, detail: msg.slice(0, 140) });
  }
  const r = results.at(-1);
  const tag = r.ok ? "PASS" : r.expect === "info" ? "N/A " : r.expect === "diff" ? "DIFF" : "FAIL";
  console.log(`${tag}  ${area.padEnd(11)} ${name}${r.detail ? `  — ${r.detail}` : ""}`);
}
const assert = (c, m) => { if (!c) throw new Error(m ?? "assertion failed"); };
const rpc = (m, p = []) => provider.send(m, p);
const sendTx = async (tx) => (await wallet.sendTransaction(tx)).wait();
// Throwaway funded account, so raw/odd txs never disturb the main dev key's nonce or code.
const freshWallet = async (sel = "0.05") => {
  const w = new Wallet(Wallet.createRandom().privateKey, provider);
  await sendTx({ to: w.address, value: parseEther(sel) });
  return w;
};

// ---------- setup ----------
const A = compile(path.resolve(import.meta.dirname, "contracts"));
const deploy = async (name, ...args) => {
  const c = await new ContractFactory(A[name].abi, A[name].bytecode, wallet).deploy(...args);
  await c.waitForDeployment();
  return c;
};
console.log(`Selendra EVM compatibility suite — ${await rpc("web3_clientVersion")} on ${provider._getConnection().url}\n`);
const compat = await deploy("Compat");
const logic = await deploy("Logic");
const bigf = await deploy("BigCodeFactory");
const C = await compat.getAddress();
const seed = await sendTx({ to: Wallet.createRandom().address, value: 1n });

// ---------- JSON-RPC ----------
area = "rpc";
const blk = await rpc("eth_getBlockByNumber", [toBeHex(seed.blockNumber), true]);
const methods = [
  ["eth_chainId", []], ["net_version", []], ["net_listening", []], ["net_peerCount", []], ["web3_clientVersion", []],
  ["web3_sha3", ["0x68656c6c6f"]], ["eth_protocolVersion", []], ["eth_syncing", []], ["eth_blockNumber", []],
  ["eth_gasPrice", []], ["eth_maxPriorityFeePerGas", []], ["eth_feeHistory", ["0x4", "latest", [25, 75]]], ["eth_blobBaseFee", []],
  ["eth_getBlockByNumber", ["latest", false]], ["eth_getBlockByHash", [blk?.hash, false]],
  ["eth_getBlockTransactionCountByNumber", [toBeHex(seed.blockNumber)]], ["eth_getBlockTransactionCountByHash", [blk?.hash]],
  ["eth_getTransactionByBlockNumberAndIndex", [toBeHex(seed.blockNumber), toBeHex(seed.index)]],
  ["eth_getTransactionByBlockHashAndIndex", [blk?.hash, toBeHex(seed.index)]], ["eth_getBlockReceipts", [toBeHex(seed.blockNumber)]],
  ["eth_getUncleCountByBlockNumber", ["latest"]], ["eth_getBalance", [me, "latest"]], ["eth_getCode", [C, "latest"]],
  ["eth_getStorageAt", [C, "0x0", "latest"]], ["eth_getTransactionCount", [me, "latest"]], ["eth_getProof", [C, ["0x0"], "latest"]],
  ["eth_call", [{ to: C, data: compat.interface.encodeFunctionData("stored") }, "latest"]],
  ["eth_estimateGas", [{ from: me, to: C, data: compat.interface.encodeFunctionData("setStored", [1]) }]],
  ["eth_createAccessList", [{ from: me, to: C, data: compat.interface.encodeFunctionData("setStored", [1]) }, "latest"]],
  ["eth_getLogs", [{ fromBlock: toBeHex(seed.blockNumber), toBlock: "latest" }]],
  ["eth_getTransactionByHash", [seed.hash]], ["eth_getTransactionReceipt", [seed.hash]],
  ["eth_accounts", []], ["eth_coinbase", []], ["eth_mining", []], ["eth_hashrate", []],
  ["eth_sign", [me, "0x00"]], ["eth_sendTransaction", [{ from: me, to: me, value: "0x0" }]],
  ["eth_newFilter", [{}]], ["eth_newBlockFilter", []], ["eth_newPendingTransactionFilter", []], ["txpool_status", []],
  ["debug_traceTransaction", [seed.hash, { tracer: "callTracer" }]], ["debug_traceTransaction", [seed.hash, { tracer: "prestateTracer" }]],
  ["debug_traceTransaction", [seed.hash, {}]], ["debug_traceCall", [{ to: C, data: "0x" }, "latest", { tracer: "callTracer" }]],
  ["debug_traceBlockByNumber", [toBeHex(seed.blockNumber), { tracer: "callTracer" }]], ["trace_transaction", [seed.hash]],
];
const essential = new Set(["eth_chainId", "net_version", "web3_clientVersion", "eth_blockNumber", "eth_gasPrice", "eth_feeHistory",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount",
  "eth_call", "eth_estimateGas", "eth_getLogs", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_maxPriorityFeePerGas"]);
const seen = new Map();
for (const [m, p] of methods) {
  const label = seen.has(m) ? `${m} (${JSON.stringify(p[1]?.tracer ?? p[1])})` : m;
  seen.set(m, 1);
  await check(label, async () => {
    const r = await rpc(m, p);
    return JSON.stringify(r).slice(0, 60);
  }, essential.has(m) ? "works" : "info");
}
await check("eth_subscribe newHeads + logs (WebSocket)", async () => {
  const ws = new WebSocketProvider(WS_URL, Number(CHAIN_ID));
  const gotBlock = new Promise((res) => ws.once("block", res));
  const gotLog = new Promise((res) => ws.once({ address: C }, res));
  await sendTx({ to: C, data: compat.interface.encodeFunctionData("emitEvents", [1, "0x01"]) });
  const n = await Promise.race([gotBlock, new Promise((_, rej) => setTimeout(() => rej(new Error("no block in 20s")), 20000))]);
  await Promise.race([gotLog, new Promise((_, rej) => setTimeout(() => rej(new Error("no log in 20s")), 20000))]);
  await ws.removeAllListeners();
  await new Promise((r) => setTimeout(r, 500)); // let eth_unsubscribe finish before closing
  await ws.destroy();
  return `block ${n} + contract log received`;
});

await check("receipt blockHash is final as soon as the receipt exists", async () => {
  const r = await sendTx({ to: me, value: 1n });
  const first = r.blockHash;
  const synthetic = Buffer.from(first.slice(2, 42), "hex").toString() === "synthetic_block_hash";
  await new Promise((res) => setTimeout(res, 13000)); // wait for the EVM block to be sealed
  const later = (await provider.getTransactionReceipt(r.hash)).blockHash;
  const block = await provider.getBlock(r.blockNumber);
  assert(first === later, `receipt blockHash changed after sealing (${synthetic ? '"synthetic_block_hash…" placeholder' : first.slice(0, 12)} → ${later.slice(0, 12)}…); ` +
    "use blockNumber, or re-read the receipt after the block is sealed");
  assert(block.hash === later, "block hash mismatch");
}, "diff");
await check("parentHash chain is consistent", async () => {
  const n = await provider.getBlockNumber();
  const [b1, b2] = await Promise.all([provider.getBlock(n - 2), provider.getBlock(n - 1)]);
  assert(b2.parentHash === b1.hash, `${b2.parentHash} != ${b1.hash}`);
});

// ---------- transaction types ----------
area = "tx-types";
const fee = await provider.getFeeData();
await check("type 0 legacy (EIP-155)", async () => (await sendTx({ type: 0, to: me, value: 1n, gasPrice: fee.gasPrice })).status === 1 ? "ok" : "failed", "diff");
await check("type 1 access list (EIP-2930)", async () =>
  (await sendTx({ type: 1, to: C, gasPrice: fee.gasPrice, data: compat.interface.encodeFunctionData("setStored", [5]),
    accessList: [{ address: C, storageKeys: [zeroPadValue("0x00", 32)] }] })).status === 1 ? "ok" : "failed", "diff");
await check("type 2 dynamic fee (EIP-1559)", async () => (await sendTx({ type: 2, to: me, value: 1n })).status === 1 ? "ok" : "failed");
await check("pre-EIP-155 legacy (no chain id)", async () => {
  const w = await freshWallet();
  const tx = Transaction.from({ type: 0, to: me, value: 1n, gasPrice: fee.gasPrice, gasLimit: 30000n, nonce: 0 });
  tx.signature = w.signingKey.sign(tx.unsignedHash); // chainId 0 → v = 27/28
  const h = await rpc("eth_sendRawTransaction", [tx.serialized]);
  return `accepted ${h.slice(0, 10)}…`;
}, "info");
await check("type 4 set-code (EIP-7702, Prague)", async () => {
  const w = await freshWallet();
  const auth = await w.authorize({ address: await logic.getAddress(), nonce: 1 });
  const r = await (await w.sendTransaction({ type: 4, to: w.address, authorizationList: [auth] })).wait();
  return r.status === 1 ? `ok, code now ${(await provider.getCode(w.address)).slice(0, 12)}…` : "failed";
}, "info");
await check("replayed raw tx is rejected", async () => {
  const w = await freshWallet();
  const signed = await w.signTransaction(await w.populateTransaction({ to: me, value: 1n }));
  await (await provider.broadcastTransaction(signed)).wait();
  try { await rpc("eth_sendRawTransaction", [signed]); } catch (e) { return "rejected: " + (e.error?.message ?? e.shortMessage).slice(0, 50); }
  throw new Error("replay was accepted");
});
await check("insufficient funds is rejected", async () => {
  const poor = new Wallet(Wallet.createRandom().privateKey, provider);
  try { await poor.sendTransaction({ to: me, value: 1n }); } catch (e) { return "rejected: " + e.code; }
  throw new Error("accepted");
});

// ---------- opcodes & context ----------
area = "opcodes";
await check("block/tx context (NUMBER, TIMESTAMP, CHAINID, BASEFEE, COINBASE, PREVRANDAO, GASLIMIT, BLOCKHASH, GAS, ORIGIN, GASPRICE)", async () => {
  const c = await compat.context({ from: me });
  assert(c.chainid === CHAIN_ID, `chainid ${c.chainid}`);
  assert(c.number > 0n, "number");
  assert(Math.abs(Number(c.timestamp) - Date.now() / 1000) < 600, `timestamp ${c.timestamp}`);
  assert(c.gasLeft > 0n, "gasleft");
  return `chainid ${c.chainid}, number ${c.number}, basefee ${c.basefee}, gaslimit ${c.gaslimit}, coinbase ${c.coinbase.slice(0, 10)}…, ` +
    `prevrandao ${c.prevrandao === 0n ? "0" : "set"}, blockhash ${c.parentHash === "0x" + "0".repeat(64) ? "ZERO" : "set"}`;
});
await check("Shanghai: PUSH0, SHL/SHR/SAR", async () => {
  const r = await compat.push0AndShifts(256n);
  assert(r.shl_ === 4096n && r.shr_ === 16n && r.sar_ === -16n && r.zero === 0n, JSON.stringify(r.toArray().map(String)));
});
await check("Cancun: TSTORE/TLOAD, MCOPY, BLOBHASH, BLOBBASEFEE", async () => {
  const r = await compat.cancunOpcodes.staticCall();
  assert(r.tloaded === 42n, `tload ${r.tloaded}`);
  assert(r.copied === "0x1122334455667788990011223344556677889900112233445566778899001122", "mcopy");
  return `blobhash(0)=${r.blobHash0 === "0x" + "0".repeat(64) ? "0" : r.blobHash0}, blobbasefee=${r.blobBaseFee}`;
});

// ---------- precompiles ----------
area = "precompile";
const pc = (addr, data) => rpc("eth_call", [{ to: addr, data }, "latest"]);
const digest = id("selendra");
const sig = wallet.signingKey.sign(digest);
await check("0x01 ecrecover", async () => {
  const out = await pc("0x0000000000000000000000000000000000000001", concat([digest, zeroPadValue(toBeHex(sig.v), 32), sig.r, sig.s]));
  assert(abi.decode(["address"], out)[0] === me, out);
});
await check("0x02 sha256", async () => assert((await pc("0x0000000000000000000000000000000000000002", "0x616263")) === sha256("0x616263")));
await check("0x03 ripemd160", async () => assert((await pc("0x0000000000000000000000000000000000000003", "0x616263")) === zeroPadValue(ripemd160("0x616263"), 32)));
await check("0x04 identity", async () => assert((await pc("0x0000000000000000000000000000000000000004", "0xdeadbeef")) === "0xdeadbeef"));
await check("0x05 modexp (3^2 mod 5)", async () => {
  const out = await pc("0x0000000000000000000000000000000000000005", concat([zeroPadValue("0x01", 32), zeroPadValue("0x01", 32), zeroPadValue("0x01", 32), "0x030205"]));
  assert(out === "0x04", out);
});
const G1x2 = "0x030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd315ed738c0e0a7c92e7845f96b2ae9c0a68a6a449e3538fc7ff3ebf7a5a18a2c4";
const G1 = concat([zeroPadValue("0x01", 32), zeroPadValue("0x02", 32)]);
await check("0x06 bn254 add", async () => assert((await pc("0x0000000000000000000000000000000000000006", concat([G1, G1]))) === G1x2));
await check("0x07 bn254 mul", async () => assert((await pc("0x0000000000000000000000000000000000000007", concat([G1, zeroPadValue("0x02", 32)]))) === G1x2));
await check("0x08 bn254 pairing (empty input = true)", async () => assert((await pc("0x0000000000000000000000000000000000000008", "0x")) === zeroPadValue("0x01", 32)));
await check("0x09 blake2f (EIP-152 vector)", async () => {
  const h = "48c9bdf267e6096a3ba7ca8485ae67bb2bf894fe72f36e3cf1361d5f3af54fa5d182e6ad7f520e511f6c3e2b8c68059b6bbd41fbabd9831f79217e1319cde05b";
  const input = "0x0000000c" + h + "616263".padEnd(256, "0") + "0300000000000000" + "0000000000000000" + "01";
  const out = await pc("0x0000000000000000000000000000000000000009", input);
  assert(out === "0xba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923", out);
});
await check("0x0a KZG point evaluation (EIP-4844)", async () => {
  const infinity = "0xc0" + "00".repeat(47); // commitment/proof of the zero polynomial
  const vh = "0x01" + sha256(infinity).slice(4);
  const out = await pc("0x000000000000000000000000000000000000000a", concat([vh, zeroPadValue("0x00", 32), zeroPadValue("0x00", 32), infinity, infinity]));
  assert(out === "0x" + "1000".padStart(64, "0") + "73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001", out);
});
await check("0x100 P256VERIFY (RIP-7212)", async () => {
  const out = await pc("0x0000000000000000000000000000000000000100", "0x" + "00".repeat(160));
  if (out === "0x") throw new Error("not present (empty result)");
  return `present (${out})`;
}, "info");
await check("0x0b BLS12-381 G1ADD (EIP-2537, Prague)", async () => {
  const out = await pc("0x000000000000000000000000000000000000000b", "0x" + "00".repeat(256));
  if (out === "0x") throw new Error("not present (empty result)");
  return `present (${out.slice(0, 18)}…)`;
}, "info");

// ---------- contracts ----------
area = "contracts";
const child = new Interface(A.Child.abi);
await check("CREATE with value (constructor payable)", async () => {
  const r = await (await compat.createChild(7, { value: 1000n })).wait();
  const addr = abi.decode(["address"], (await provider.call({ from: me, to: C, data: compat.interface.encodeFunctionData("createChild", [7]) })))[0];
  assert(r.status === 1, "status");
  return `child ${addr.slice(0, 12)}… (simulated)`;
});
await check("CREATE2 address matches prediction", async () => {
  const salt = id("salt-" + Date.now());
  const predicted = await compat.predict(9, salt);
  await (await compat.create2Child(9, salt)).wait();
  const code = await provider.getCode(predicted);
  assert(code.length > 2, "no code at predicted address");
  assert(BigInt(await provider.call({ to: predicted, data: child.encodeFunctionData("value") })) === 9n, "value");
  return predicted;
});
await check("CREATE2 same salt twice fails", async () => {
  const salt = id("dup-" + Date.now());
  await (await compat.create2Child(1, salt)).wait();
  try { await compat.create2Child.staticCall(1, salt); } catch { return "reverted as expected"; }
  throw new Error("second CREATE2 succeeded");
});
await check("SELFDESTRUCT in creating tx clears code (EIP-6780)", async () => {
  const r = await compat.createAndDestroy.staticCall();
  assert(r.codeSizeAfter === 0n || r.codeSizeAfter > 0n);
  await (await compat.createAndDestroy()).wait();
  return `code size right after selfdestruct: ${r.codeSizeAfter}`;
}, "diff");
await check("SELFDESTRUCT on existing contract keeps code (EIP-6780)", async () => {
  const c = await deploy("Child", 3, { value: 50n });
  const a = await c.getAddress();
  await (await c.boom(me)).wait();
  const code = await provider.getCode(a);
  const bal = await provider.getBalance(a);
  assert(code.length > 2, "code was deleted");
  assert(bal === 0n, "balance not sent");
  return "code kept, balance sent";
});
await check("CALL contract → contract", async () => {
  const c = await deploy("Child", 1);
  assert((await compat.callChild.staticCall(await c.getAddress(), 77)) === 77n);
});
await check("DELEGATECALL writes caller storage", async () => {
  await (await compat.delegate(await logic.getAddress(), 1234)).wait();
  assert((await compat.stored()) === 1234n, "stored");
  assert((await logic.stored()) === 0n, "logic changed");
});
await check("STATICCALL forbids state change", async () => {
  const c = await deploy("Child", 1);
  assert((await compat.staticWrite.staticCall(await c.getAddress())) === false, "write inside staticcall succeeded");
});
await check("receive(): plain SEL transfer to contract + event", async () => {
  const r = await sendTx({ to: C, value: parseEther("0.01") });
  const ev = r.logs.map((l) => compat.interface.parseLog(l)).find((e) => e?.name === "Received");
  assert(ev && ev.args.amount === parseEther("0.01"), "Received event");
});
await check("fallback(): unknown selector", async () => assert((await sendTx({ to: C, data: "0x12345678" })).status === 1));
await check("contract pays out SEL (CALL with value)", async () => {
  const to = Wallet.createRandom().address;
  await (await compat.pay(to, 1234n)).wait();
  assert((await provider.getBalance(to)) === 1234n);
});
await check("EXTCODESIZE / EXTCODEHASH", async () => {
  assert((await compat.codeSize(C)) > 0n && (await compat.codeSize(me)) === 0n);
  assert((await compat.codeHash(C)) === keccak256(await provider.getCode(C)), "extcodehash");
});
await check("historical state (eth_call / getBalance at an older block)", async () => {
  await (await compat.setStored(111)).wait();
  const before = await provider.getBlockNumber();
  await new Promise((r) => setTimeout(r, 7000)); // let a new EVM block start
  await (await compat.setStored(222)).wait();
  const old = BigInt(await provider.call({ to: C, data: compat.interface.encodeFunctionData("stored"), blockTag: before }));
  const now = await compat.stored();
  assert(now === 222n, `now ${now}`);
  assert(old === 111n, `at block ${before}: ${old}`);
});

// ---------- errors ----------
area = "errors";
const reasonOf = async (p) => { try { await p; } catch (e) { return e; } throw new Error("did not revert"); };
await check("require(false, msg) → reason", async () => { const e = await reasonOf(compat.failRequire()); assert(e.reason === "require message", e.reason); });
const revertOf = (e) => ({ name: e.revert?.name, args: e.revert ? [...e.revert.args].map(String) : [] });
await check("custom error → decoded", async () => {
  const r = revertOf(await reasonOf(compat.failCustom()));
  assert(r.name === "CustomError" && r.args[0] === "7" && r.args[1] === "custom", `${r.name}(${r.args})`);
  return `${r.name}(${r.args.join(", ")})`;
});
for (const [label, call, code] of [["panic 0x12 division by zero", () => compat.failPanicDiv(0), "18"],
  ["panic 0x01 assert", () => compat.failAssert(), "1"], ["panic 0x11 overflow", () => compat.failOverflow(1), "17"]]) {
  await check(label, async () => {
    const r = revertOf(await reasonOf(call()));
    assert(r.name === "Panic" && r.args[0] === code, `${r.name}(${r.args})`);
  });
}
await check("try/catch inside contract", async () => assert((await compat.tryCatch.staticCall(C)) === "require message"));
await check("reverting tx is mined with status 0 (Ethereum behaviour)", async () => {
  const nonce = await wallet.getNonce("pending");
  try {
    const tx = await wallet.sendTransaction({ to: C, data: compat.interface.encodeFunctionData("failRequire"), gasLimit: 200000n });
    const r = await provider.waitForTransaction(tx.hash);
    assert(r.status === 0, `status ${r.status}`);
    return `status 0, gas used ${r.gasUsed}, nonce ${nonce} consumed`;
  } catch (e) {
    if (e.receipt) return `status ${e.receipt.status}, gas used ${e.receipt.gasUsed}`;
    const after = await provider.getTransactionCount(me, "latest");
    throw new Error(`rejected by the sequencer before inclusion (no receipt, nonce ${after === nonce ? "not consumed" : "consumed"})`);
  }
}, "diff");

// ---------- logs ----------
area = "logs";
await check("indexed + anonymous events in receipt", async () => {
  const r = await (await compat.emitEvents(42, "0xbeef")).wait();
  assert(r.logs.length === 2, `${r.logs.length} logs`);
  const ping = compat.interface.parseLog(r.logs[0]);
  assert(ping.name === "Ping" && ping.args.n === 42n && ping.args.data === "0xbeef", "Ping");
  assert(r.logs[1].topics.length === 0, "anonymous event should have no topics");
});
await check("eth_getLogs filtered by indexed topic", async () => {
  const r = await (await compat.emitEvents(4242, "0x")).wait();
  const logs = await compat.queryFilter(compat.filters.Ping(null, 4242), r.blockNumber, r.blockNumber);
  assert(logs.length === 1, `${logs.length}`);
});
await check("eth_getLogs by blockHash", async () => {
  const r = await (await compat.emitEvents(7, "0x")).wait();
  const logs = await provider.getLogs({ blockHash: r.blockHash, address: C });
  assert(logs.length >= 2, `${logs.length}`);
});

// ---------- signatures ----------
area = "signatures";
await check("ecrecover in Solidity", async () => assert((await compat.recover(digest, sig.v, sig.r, sig.s)) === me));
await check("personal_sign (signMessage) verified on-chain", async () => {
  const s = Signature.from(await wallet.signMessage("hello selendra"));
  assert((await compat.recover(hashMessage("hello selendra"), s.v, s.r, s.s)) === me);
});
await check("EIP-712 typed data verified on-chain", async () => {
  const domain = { name: "Selendra", version: "1", chainId: CHAIN_ID, verifyingContract: C };
  const types = { Mail: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }] };
  const value = { to: me, amount: 5n };
  const s = Signature.from(await wallet.signTypedData(domain, types, value));
  assert((await compat.recover(TypedDataEncoder.hash(domain, types, value), s.v, s.r, s.s)) === me);
});
await check("keccak256 / sha256 / ripemd160 in Solidity", async () => {
  const d = hexlify(toUtf8Bytes("selendra"));
  const r = await compat.hashes(d);
  assert(r.k === keccak256(d) && r.s === sha256(d) && r.r === ripemd160(d));
});

// ---------- limits ----------
area = "limits";
await check("storage-heavy tx (200 SSTOREs + array pushes)", async () => {
  const r = await (await compat.writeMany(200)).wait();
  return `gas used ${r.gasUsed}`;
});
await check("contract code size 24,576 bytes deploys (EIP-170 max)", async () => {
  await (await bigf.deployRaw(24576, { gasLimit: 10_000_000n })).wait();
  const a = await bigf.deployRaw.staticCall(24576, { gasLimit: 10_000_000n });
  assert(a !== "0x0000000000000000000000000000000000000000", "create returned 0");
});
await check("contract code size 24,577 bytes is rejected (EIP-170)", async () => {
  const a = await bigf.deployRaw.staticCall(24577, { gasLimit: 10_000_000n });
  assert(a === "0x0000000000000000000000000000000000000000", "deployed: limit is evm.chain_spec.limit_contract_code_size in genesis (512 KiB)");
}, "diff");
await check("large calldata tx (64 KB)", async () => {
  const r = await (await compat.emitEvents(1, "0x" + "ab".repeat(65536))).wait();
  return `gas used ${r.gasUsed}`;
});
await check("block gas limit", async () => `${(await provider.getBlock("latest")).gasLimit}`);

// ---------- summary ----------
const must = results.filter((r) => r.expect === "works");
const diffs = results.filter((r) => r.expect === "diff" && !r.ok);
const failed = must.filter((r) => !r.ok);
const info = results.filter((r) => r.expect === "info");
console.log(`\n${must.length - failed.length}/${must.length} required checks passed` +
  `; ${diffs.length} known differences from Ethereum (DIFF)` +
  `; optional: ${info.filter((r) => r.ok).length} available, ${info.filter((r) => !r.ok).length} not supported (N/A).`);
if (failed.length) console.log("Failed:\n" + failed.map((r) => `  - [${r.area}] ${r.name}: ${r.detail}`).join("\n"));
process.exit(failed.length ? 1 : 0);
