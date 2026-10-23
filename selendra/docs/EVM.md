# Selendra as an EVM chain

Selendra runs an EVM (Sovereign SDK `sov-evm` module, Cancun hardfork) next to its native modules. Any Ethereum tool
that speaks JSON-RPC can use it: ethers.js, viem, Hardhat, Foundry, MetaMask and others. You don't need to enable anything;
it is part of the runtime.

| Setting | Local testnet value |
|---|---|
| HTTP RPC | `http://127.0.0.1:12346/rpc` |
| WebSocket RPC (subscriptions) | `ws://127.0.0.1:12346/rpc` |
| Chain ID | `19610` (`0x4c9a`), from `CHAIN_ID` in `constants.toml` |
| Native currency | `SEL`, 18 decimals. It is the same token as the native gas token, so one balance serves both |
| Client version | `sov-evm/0.3.0` |
| Solidity target | `evmVersion: "cancun"` (tested with solc 0.8.28) |
| Explorer | <http://127.0.0.1:8080> (`make selendra-explorer`). It shows EVM txs, receipts, logs and contracts |

**Accounts.** An EVM address *is* a Selendra address: the same key signs EVM transactions and native Sovereign
transactions, and holds one SEL balance. The dev keys in `testing/test-data/keys/` work in every tool.
`token_deployer_private_key.json` (`0xA6ed…aC085`) is the rich genesis admin. **Use these keys only on a local testnet.**

---

## 1. ethers.js — ready-made project (`clients/evm-ethers/`)

```bash
make selendra-evm-demo                                   # full walkthrough (below)
make selendra-evm-deploy                                 # deploy SelendraToken, address saved to deployments/selendra-local.json
make selendra-evm-deploy CONTRACT=SelendraToken ARGS='"My Token" MTK 1000000000000000000000'
make selendra-evm-watch TOKEN=0x...                      # live blocks + Transfer events over WebSocket
make selendra-evm-compat                                 # full compatibility suite (see below)
```

| File | What it does |
|---|---|
| `contracts/*.sol` | Your Solidity contracts (`SelendraToken.sol` is a minimal ERC-20). Add more files here |
| `src/config.js` | RPC/WS URLs, chain ID, dev key, `connect()` / `connectWs()` and `SelendraWallet` |
| `src/compile.js` | Compiles `contracts/*.sol` with solc-js and writes `artifacts/<Name>.json` (abi + bytecode). No Foundry or Hardhat needed |
| `src/deploy.js` | Deploys a contract by name with constructor args |
| `src/demo.js` | Network info → deploy ERC-20 → `eth_call` reads → transfer + receipt events → `eth_getLogs` → revert reason → native SEL send |
| `test/compat.js`, `test/contracts/Compat.sol` | Compatibility suite: RPC methods, tx types, opcodes, precompiles, contracts, errors, logs, signatures, limits |
| `src/watch.js` | `WebSocketProvider` subscriptions: `provider.on("block")`, `contract.on("Transfer")` |

Use it in your own code:

```js
import { connect } from "./src/config.js";
const { provider, wallet } = connect();   // wallet is a SelendraWallet (an ethers Wallet)
const token = new Contract(address, abi, wallet);
await (await token.transfer(to, amount)).wait();
```

Environment overrides: `SELENDRA_RPC`, `SELENDRA_WS`, `PRIVATE_KEY`.

## 2. viem

```js
import { defineChain, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const selendraLocal = defineChain({
  id: 19610,
  name: "Selendra Local",
  nativeCurrency: { name: "Selendra", symbol: "SEL", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:12346/rpc"], webSocket: ["ws://127.0.0.1:12346/rpc"] } },
});

const publicClient = createPublicClient({ chain: selendraLocal, transport: http() });
const walletClient = createWalletClient({ account: privateKeyToAccount("0x<dev key>"), chain: selendraLocal, transport: http() });
```

## 3. Hardhat

```js
// hardhat.config.js
module.exports = {
  solidity: { version: "0.8.28", settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 } } },
  networks: {
    selendraLocal: {
      url: "http://127.0.0.1:12346/rpc",
      chainId: 19610,
      accounts: ["0x<dev key>"],          // the node does not manage keys (no eth_accounts)
    },
  },
};
```

```bash
npx hardhat run scripts/deploy.js --network selendraLocal
```

## 4. Foundry

```bash
forge create contracts/SelendraToken.sol:SelendraToken --rpc-url http://127.0.0.1:12346/rpc \
  --private-key 0x<dev key> --broadcast --constructor-args "My Token" MTK 1000000000000000000000
cast call <address> "symbol()(string)" --rpc-url http://127.0.0.1:12346/rpc
cast send <address> "transfer(address,uint256)" 0x… 1000 --rpc-url http://127.0.0.1:12346/rpc --private-key 0x<dev key>
```

`testing/foundry-tests/` contains the SDK's Foundry compatibility suite (`run.sh`). It covers calldata, context,
CREATE2, events, memory, precompiles and storage.

## 5. MetaMask

Add a network: name `Selendra Local`, RPC `http://127.0.0.1:12346/rpc`, chain ID `19610`, symbol `SEL`.
Then import a dev key. To move SEL between MetaMask and native accounts, use the same address; no bridge is needed.

---

## Compatibility — what works and what doesn't

Run the full suite yourself at any time (for example after an SDK upgrade):

```bash
make selendra-evm-compat      # clients/evm-ethers/test/compat.js + test/contracts/Compat.sol
```

Result on 2026-10-23 (local mock DA, SDK rev `f1a2dc3`): **65/65 required checks pass, 6 known differences from
Ethereum, and 24 optional or newer-fork features not available.**

### ✅ Works like Ethereum

| Area | Checked |
|---|---|
| Opcodes | All block/tx context opcodes (`NUMBER`, `TIMESTAMP`, `CHAINID`, `BASEFEE`, `COINBASE`, `PREVRANDAO`, `GASLIMIT`, `BLOCKHASH`, `GAS`, `ORIGIN`, `GASPRICE`). Shanghai `PUSH0`, shifts. Cancun `TSTORE/TLOAD`, `MCOPY`, `BLOBHASH` (0), `BLOBBASEFEE` (0) |
| Precompiles | All 10 Cancun precompiles, verified with known test vectors: `0x01` ecrecover, `0x02` sha256, `0x03` ripemd160, `0x04` identity, `0x05` modexp, `0x06/07/08` bn254 add/mul/pairing, `0x09` blake2f, `0x0a` KZG point evaluation |
| Contracts | `CREATE` with value, `CREATE2` (address matches prediction; a duplicate salt fails), contract → contract `CALL`, `DELEGATECALL`, `STATICCALL` write protection, `receive()`, `fallback()`, paying SEL out of a contract, `EXTCODESIZE/EXTCODEHASH`, `SELFDESTRUCT` on an existing contract (sends balance, keeps code — EIP-6780), contracts up to 24 KB and beyond |
| Errors | `require` reasons, custom errors (decoded), `Panic` codes (0x01 assert, 0x11 overflow, 0x12 div by zero), `try/catch` |
| Logs | Indexed and anonymous events, `eth_getLogs` by address/topic/block range/blockHash, WebSocket `eth_subscribe` (`newHeads`, `logs`) |
| Signatures | `ecrecover`, `personal_sign` (signMessage), EIP-712 typed data — all verified on-chain |
| State | `eth_call` and `getBalance` at older blocks (historical state), `eth_getStorageAt`, `eth_createAccessList` |
| Limits | Storage-heavy tx (200 SSTOREs ≈ 9.8M gas), 64 KB calldata, block gas limit 1,000,000,000 |
| Tx | Type 2 (EIP-1559) txs; replayed raw txs and txs without funds are rejected |

### ⚠️ Differences from Ethereum (DIFF)

| # | Difference | What to do |
|---|---|---|
| 1 | **Only type 2 (EIP-1559) transactions.** Type 0 (legacy), type 1 (EIP-2930), pre-EIP-155 and type 4 (EIP-7702) are rejected: `Only EIP-1559 is currently supported`. | ethers, viem, Hardhat, Foundry and MetaMask send type 2 by default. Don't force `type: 0`/`gasPrice`-only txs. Some old tools or wallets that only send legacy txs won't work. |
| 2 | **Reverting transactions are never mined.** The sequencer runs each tx first and rejects any that revert or run out of gas, with HTTP 400 `Transaction execution unsuccessful`. You get no receipt with `status: 0`, and the nonce is **not** used up. | Handle the error when you *send*, not on the receipt. In ethers, `sendTransaction` throws (estimateGas usually throws even earlier with the revert reason). |
| 3 | **Receipt `blockHash` is a placeholder at first.** Right after soft confirmation, the receipt's `blockHash` is `0x73796e7468657469635f626c6f636b5f68617368…` (ASCII "synthetic_block_hash"). It becomes the real hash once the EVM block is sealed, about one DA block later. `blockNumber`, `transactionHash` and logs are final immediately. | Key data by `transactionHash` or `blockNumber`, not by `blockHash`. If you need the hash, re-read the receipt after the next block. |
| 4 | **Contract size limit is 512 KiB, not 24 KB (EIP-170).** It is set in genesis: `evm.chain_spec.limit_contract_code_size = 524288`. | Set it to `24576` in `configs/*/genesis.json` for strict Ethereum parity. That is a genesis change, so run `make clean-db`. The admin can also change it later through the EVM module's `ChainSpecUpdate`. |
| 5 | **`SELFDESTRUCT` of a contract created in the same tx fails** (`selfdestruct unsupported`), where Ethereum would delete it. `SELFDESTRUCT` on older contracts works (EIP-6780 behaviour). | The opcode is deprecated; avoid factory patterns that create and destroy in one tx. |
| 6 | **Nonce lag right after a confirmation** (described below). | Use `SelendraWallet` (ethers) or keep the nonce in your client. |

### ❌ Not available (N/A)

| Feature | Notes |
|---|---|
| Hardfork | The EVM runs **Cancun** (`evm.chain_spec.hardforks = [[0, "CANCUN"]]`). Prague features are absent: EIP-7702 (type 4), BLS12-381 precompiles (EIP-2537). P256VERIFY (RIP-7212) is also absent. |
| RPC: node-held keys | `eth_accounts`, `eth_sendTransaction`, `eth_sign` → sign in the client (every library does) |
| RPC: filters | `eth_newFilter`, `eth_newBlockFilter`, `eth_newPendingTransactionFilter` → use WebSocket subscriptions or `eth_getLogs` |
| RPC: tracing | `debug_traceTransaction` and `debug_traceBlockByNumber` work with `{"tracer":"callTracer"}` only. The default struct logger, `prestateTracer`, `debug_traceCall` and `trace_*` are not supported |
| RPC: misc | `eth_getProof`, `eth_syncing`, `eth_protocolVersion`, `eth_blobBaseFee`, `net_peerCount`, `eth_coinbase`, `eth_mining`, `eth_hashrate`, `eth_getUncleCount*`, `txpool_*` |

### All JSON-RPC methods that work

`eth_chainId`, `net_version`, `net_listening`, `web3_clientVersion`, `web3_sha3`, `eth_blockNumber`, `eth_gasPrice`,
`eth_maxPriorityFeePerGas`, `eth_feeHistory`, `eth_getBlockByNumber`, `eth_getBlockByHash`,
`eth_getBlockTransactionCountByNumber/Hash`, `eth_getTransactionByBlockNumberAndIndex`,
`eth_getTransactionByBlockHashAndIndex`, `eth_getBlockReceipts`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`,
`eth_getTransactionCount`, `eth_call`, `eth_estimateGas`, `eth_createAccessList`, `eth_getLogs`,
`eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_sendRawTransaction`,
`eth_subscribe`/`eth_unsubscribe` (WebSocket), `debug_traceTransaction` + `debug_traceBlockByNumber` (callTracer).

### Libraries and tools

| Tool | Result |
|---|---|
| ethers 6.15 (`clients/evm-ethers`) | ✅ everything above, plus `make selendra-evm-demo` |
| ethers stress: 30 back-to-back txs (deploy + call + send, ×10) | ✅ 0 failures in 2.1 s with `SelendraWallet` |
| viem 2.21 | ✅ `defineChain`, reads, `sendTransaction`, `waitForTransactionReceipt` |
| Hardhat 2.22 + hardhat-ethers | ✅ compile, deploy, call, transfer |
| Foundry | not installed on the test machine; standard flags above. See `testing/foundry-tests/` |

---

## The nonce lag in detail

Selendra soft-confirms a tx in about 50 ms. For a short moment after that, `eth_getTransactionCount` can still return
the old nonce, because the RPC reads committed state while the sequencer is already ahead. Selendra's
`eth_estimateGas` also rejects a stale nonce, so a script that sends txs back-to-back can fail with `nonce too low`.

**Fix:** track the nonce in the client. `SelendraWallet` in `clients/evm-ethers/src/config.js` does this. It is an
ethers `Wallet` that uses `max(network nonce, last sent + 1)`. ethers' own `NonceManager` is **not** enough here: it
sets the nonce only after gas was estimated with the stale one. Wallets used by people (MetaMask) aren't affected in
practice.

## Other things to know

- **No filters**, so ethers `contract.on(...)` over HTTP won't work. Use `WebSocketProvider` (`connectWs()`) or poll with `getLogs`.
- **Gas numbers differ from Ethereum mainnet.** For example, an ERC-20 transfer used ~170k gas here, and the base fee
  is currently 7 wei. Always use `estimateGas`; don't hard-code gas limits from Ethereum. Fees go through the rollup's
  gas metering, so `COINBASE` is `0x0`.
- **Block numbers.** The EVM RPC block number and the explorer's "block" (DA slot / rollup height) are counted
  separately, so they won't match.
- **EVM txs don't emit Sovereign ledger events.** The explorer reads their details and logs from the EVM RPC instead.
- **Contract deployment is open to everyone** (`evm.contract_creation_policy = "everyone"` in genesis). It can be
  restricted to an allowlist.
