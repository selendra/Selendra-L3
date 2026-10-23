# Selendra — Local Testnet Rollup

Selendra is a rollup chain built on the [Sovereign SDK](https://github.com/Sovereign-Labs/sovereign-sdk),
started from the official [`rollup-starter`](https://github.com/Sovereign-Labs/rollup-starter) template
(commit `972e5cd`, SDK rev `f1a2dc3`). It posts its data to **Celestia** (or to a local mock DA for fast development).

This guide shows how to run Selendra **on your own machine** as a local testnet.

| Setting | Value | Where |
|---|---|---|
| Chain name | `Selendra` | `constants.toml` → `CHAIN_NAME` |
| Chain ID | `19610` (local testnet only, change before going public) | `constants.toml` → `CHAIN_ID` |
| Gas token | `SEL` | `configs/*/genesis.json` → `bank.gas_token_config.token_name` |
| Batch namespace | `selendra-b` | `constants.toml` → `BATCH_NAMESPACE` |
| Proof namespace | `selendra-p` | `constants.toml` → `PROOF_NAMESPACE` |
| REST API / Swagger | `http://127.0.0.1:12346` / `/swagger-ui/` | `configs/*/rollup.toml` → `[runner.http_config]` |
| Data folder | `rollup-state/selendra-data-mock` or `-celestia` | `configs/*/rollup.toml` → `[storage].path` |

There are two ways to run it locally:

| Mode | DA layer | Needs Docker | Use it for |
|---|---|---|---|
| **A. Mock DA** | SQLite file (`rollup-state/mock_da.sqlite`), 6 s blocks | No | Day-to-day module development |
| **B. Celestia devnet** | Real Celestia validator + bridge node in Docker | Yes | Testing the real DA path before Mocha testnet |

---

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Rust (rustup) | the repo pins **1.93.0** in `rust-toolchain.toml`; rustup installs it automatically | `rustup --version` |
| Clang / libclang | any recent (needed to build RocksDB) | `clang --version` |
| Node.js + npm | 20+ (for the TypeScript test client) | `node --version` |
| Docker + Compose | only for mode B | `docker compose version` |
| Hardware | 4+ cores, 8 GB+ RAM, **~30 GB free disk** (the `target/` folder is ~26 GB after both builds) | |

On Ubuntu / WSL2 install the system packages once:

```bash
sudo apt update
sudo apt install -y build-essential clang libclang-dev pkg-config libssl-dev git curl
```

> **Missing `libclang`?** The build fails with
> `couldn't find any valid shared libraries matching: ['libclang.so', ...]`.
> Install `clang libclang-dev` as above. See [Troubleshooting](#7-troubleshooting).

---

## 2. Build

```bash
cd selendra

# Mock DA build (default features)
cargo build

# Celestia build (only needed for mode B)
cargo build --no-default-features --features=celestia_da,mock_zkvm
```

The first build downloads and compiles the whole SDK; later builds are incremental.

> Building with the Celestia features replaces the same `target/debug/rollup` binary.
> `make selendra-mock` / `make selendra-celestia` use `cargo run` with the right features, so they rebuild automatically when you switch.

> Proving is **off** by default (`mock_zkvm`). You don't need the Risc0/SP1 toolchains for local testing.

---

## 3. Mode A — run on mock DA (quickest)

### 3.1 Start the node

```bash
make clean-db        # optional: wipe old chain data for a fresh genesis
make selendra-mock   # = cargo run -- --rollup-config-path=configs/mock/rollup.toml --genesis-path=configs/mock/genesis.json
```

Wait until the log shows the REST server address (`rest_address`). The node is now:
- producing a mock DA block every 6 s,
- running as the **preferred sequencer** (soft-confirms transactions immediately),
- serving REST + WebSocket on port `12346`.

Leave this terminal open.

### 3.2 Check it is alive (second terminal)

```bash
make selendra-value
# {"value":null}          <- value-setter module, not set yet

curl -s http://127.0.0.1:12346/ledger/slots/latest | head -c 300; echo
```

Open the API explorer in a browser: <http://127.0.0.1:12346/swagger-ui/>

### 3.3 Send a transaction

```bash
make selendra-tx
```

This runs `clients/starter-js/src/index.ts`. It signs a `bank.create_token` call ("Selendra Test Token")
with the pre-funded dev key from `testing/test-data/keys/minter_private_key.json` and sends it to the node.
You should see `Tx sent successfully` with a `Bank/TokenCreated` event and `result: 'successful'`.

To call another module, change `callMessage` in `clients/starter-js/src/index.ts`, for example:

```ts
let callMessage: RuntimeCall = { value_setter: { set_value: 10 } };
```

Run `make selendra-tx` again, then `make selendra-value` should return `{"value":10}`.

### 3.4 Stop / reset

- Stop the node: `Ctrl+C` in its terminal.
- Reset the chain to genesis: `make clean-db` (this deletes `rollup-state/`).

---

## 4. Mode B — run on a local Celestia devnet

### 4.1 Start Celestia (Docker)

```bash
make start-celestia
# ... celestia-node-0 is healthy
#  ✔ Celestia devnet containers are ready.
```

This starts two containers from `devnet/docker-compose.celestia.yml`:

| Container | Image | Port on your machine |
|---|---|---|
| `celestia-validator` | `ghcr.io/sovereign-labs/celestia-validator-devnet:v8.0.1-mocha` | gRPC `127.0.0.1:9091` |
| `celestia-node-0` (bridge) | `ghcr.io/sovereign-labs/celestia-bridge-devnet:v0.30.1-mocha` | RPC `127.0.0.1:26658` |

The devnet already has a funded wallet, `celestia1a68m2l85zn5xh0l07clk4rfvnezhywc53g8x7s`. Its key is in
`configs/celestia/rollup.toml`, and it is registered as the sequencer in `configs/celestia/genesis.json`.
You don't need to set anything up.

### 4.2 Start Selendra on Celestia

```bash
make clean-db            # IMPORTANT when switching from mock DA → Celestia
make selendra-celestia   # = cargo run --no-default-features --features=celestia_da,mock_zkvm -- \
                         #     --rollup-config-path=configs/celestia/rollup.toml \
                         #     --genesis-path=configs/celestia/genesis.json
```

### 4.3 Test it

These are the same commands as mode A:

```bash
make selendra-value
make selendra-tx
```

Batches are now real Celestia blobs in namespace `selendra-b`. To watch the DA side:

```bash
docker compose -f devnet/docker-compose.celestia.yml logs -f celestia-node-0
```

### 4.4 Stop

```bash
# Ctrl+C the rollup, then:
make stop-celestia
make clean-db
```

Each `make start-celestia` creates a **new** Celestia chain, so always run `make clean-db` before you start Selendra again.

---

## 5. Interact with the chain: API, wallet and block explorer

When a node is running (mode A or B), it serves everything on **port 12346**:

| What | URL |
|---|---|
| REST API | `http://127.0.0.1:12346` |
| Swagger UI (try every endpoint in the browser) | <http://127.0.0.1:12346/swagger-ui/> |
| OpenAPI spec | `http://127.0.0.1:12346/openapi-v3.json` |
| EVM JSON-RPC (MetaMask, ethers, cast) | `http://127.0.0.1:12346/rpc` |
| WebSocket subscriptions | `ws://127.0.0.1:12346` (see `clients/starter-js/src/index.ts`) |

### 5.1 Block explorer

```bash
make selendra-explorer     # serves explorer/ on http://127.0.0.1:8080
```

Open <http://127.0.0.1:8080>. It is a single static page (`explorer/index.html`, no build step) that reads the node API.
It shows:
- the latest blocks and transactions, refreshed every 3 s;
- block, batch and transaction details, with events and raw JSON;
- address pages (SEL balance, token balances, activity);
- tokens with their holders, and the runtime modules.

The search box accepts a block number, a tx hash, a block or batch hash, an `0x…` address or a `token_…` id.
To point it at another node, change the API address in the top-right corner.

> "Block" in the explorer means a **DA slot** (rollup height). The EVM RPC numbers its blocks differently, so an EVM
> receipt's `blockNumber` won't match the explorer's block number. EVM transactions don't emit ledger events; their
> transaction page shows the EVM details (from, to, value) instead.

### 5.2 Read state (curl)

```bash
curl -s 127.0.0.1:12346/rollup/constants                     # {"chain_id":19610,"chain_name":"Selendra",...}
curl -s 127.0.0.1:12346/ledger/slots/latest                  # latest block
curl -s "127.0.0.1:12346/ledger/txs/<hash-or-number>?children=1"  # a tx with its events
curl -s 127.0.0.1:12346/modules/bank/tokens/gas_token        # SEL token id
curl -s 127.0.0.1:12346/modules/bank/tokens/<token_id>/balances/<0xChecksummedAddress>
curl -s -X POST 127.0.0.1:12346/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0xa6edfca3aa985dd3cc728bffb700933a986ac085","latest"]}'
```

The bank REST endpoints need the **EIP-55 checksummed** address (mixed case). The EVM RPC accepts lowercase.

### 5.3 Send transactions

```bash
make selendra-tx                                             # create a token (example call)
make selendra-transfer TO=0x1111111111111111111111111111111111111111 AMOUNT=2.5   # send 2.5 SEL
make selendra-transfer TO=0x... AMOUNT=1 TOKEN=token_...     # send another token
```

`selendra-transfer` runs `clients/starter-js/src/transfer.ts`. It signs with the dev admin key `0xA6ed…`, which holds
most of the SEL. Set `PRIVATE_KEY=<hex>` to sign with another key. To make any other call, edit `callMessage` in
`clients/starter-js/src/index.ts` (see §3.3).

### 5.4 MetaMask / EVM tools

> **Full EVM guide:** [EVM.md](EVM.md) covers ethers.js, viem, Hardhat, Foundry, the supported RPC methods and the
> differences from Ethereum. To run a ready-made ethers.js example: `make selendra-evm-demo`.

Add a network in MetaMask:

| Field | Value |
|---|---|
| Network name | Selendra Local |
| RPC URL | `http://127.0.0.1:12346/rpc` |
| Chain ID | `19610` |
| Currency symbol | `SEL` |

Import a dev key from `testing/test-data/keys/` to get funds. `token_deployer_private_key.json` is the rich admin account.
Plain EVM transfers and contract calls work. For example, with ethers:

```js
const w = new Wallet("0x<dev key>", new JsonRpcProvider("http://127.0.0.1:12346/rpc"));
await (await w.sendTransaction({ to: "0x2222…", value: parseEther("1.25") })).wait();
```

### 5.5 Keep the node running in the background

```bash
make clean-db && mkdir -p rollup-state
setsid nohup ./target/debug/rollup --rollup-config-path=configs/mock/rollup.toml \
  --genesis-path=configs/mock/genesis.json > rollup-state/node.log 2>&1 < /dev/null &
tail -f rollup-state/node.log          # watch it
pkill -INT -x rollup                   # stop it
```

## 6. What is where (files you will edit)

```
selendra/
├── Cargo.toml  Cargo.lock         # Rust workspace + SDK version (rev) — the file you bump to update the SDK
├── constants.toml                 # CHAIN_ID, CHAIN_NAME, namespaces, gas prices (compiled in; must stay at root)
├── rust-toolchain.toml  Makefile  LICENSE.md  README.md
│
├── chain/                         # MAIN CODE — the chain itself
│   ├── node/                      #   node binary: full node + sequencer + REST API   (package rollup-starter)
│   ├── runtime/                   #   the Runtime = list of modules in the chain       (package stf-starter-declaration)
│   ├── stf/                       #   state transition function built from the runtime (package stf-starter)
│   ├── provers/                   #   zk provers (risc0, sp1) — not used while proving is off
│   └── node-discovery/            #   small helper binary
├── modules/                       # YOUR CUSTOM MODULES — one folder per module
│   └── value-setter/              #   example module — copy this to make your own
├── configs/                       # CONFIGURATION (no rebuild needed, but `make clean-db` after genesis changes)
│   ├── mock/rollup.toml           #   node config for mock DA (ports, storage, sequencer)
│   ├── mock/genesis.json          #   genesis balances, sequencer, paymaster, provers
│   ├── celestia/rollup.toml       #   node config for Celestia (rpc_url, grpc_url, signer key)
│   └── celestia/genesis.json      #   genesis for Celestia (seq_da_address, genesis_da_height)
├── explorer/                      # BLOCK EXPLORER — one static page (index.html), served by `make selendra-explorer`
├── clients/                       # APPS THAT TALK TO THE CHAIN
│   ├── starter-js/                #   TypeScript client used by `make selendra-tx`
│   ├── evm-ethers/                #   ethers.js + Solidity (compile, deploy, call, events) — see docs/EVM.md
│   ├── metamask/  privy/          #   web wallet examples
├── testing/                       # TESTING
│   ├── test-data/                 #   dev keys + sample requests
│   ├── acceptance-test/           #   end-to-end / upgrade acceptance harness
│   ├── soak-test/                 #   load test
│   └── foundry-tests/             #   EVM (Solidity) tests
├── devnet/                        # LOCAL INFRASTRUCTURE (Docker): Celestia devnet, Postgres, Hyperlane, rollup Dockerfile
├── scripts/                       # helper shell scripts (update_rev.sh, observability, soak runner)
├── docs/                          # this guide, UPGRADE.md, original rollup-starter README
├── rollup-state/                  # chain data (runtime only, gitignored, deleted by `make clean-db`)
└── target/                        # build output (gitignored)
```

Unit tests for the node live in `chain/node/tests/`, and for a module in `modules/<name>/tests/`.

Important rules:
- If you change **`constants.toml`**, you must **rebuild**. Its values are compiled in, and changing them changes the chain hash.
- If you change **`genesis.json`** or **constants**, run `make clean-db`. A running chain cannot change its genesis.
- If you add a module to the Runtime, add its genesis section to **both** genesis files.

### Dev accounts (local only — never use on a public network)

| Purpose | Address | Key file |
|---|---|---|
| Sequencer / admin / paymaster | `0xA6edfca3AA985Dd3CC728BFFB700933a986aC085` | — |
| Test tx signer used by `make selendra-tx` | `0x9b08ce57a93751aE790698A2C9ebc76A78F23E25` | `testing/test-data/keys/minter_private_key.json` |
| Celestia devnet DA wallet | `celestia1a68m2l85zn5xh0l07clk4rfvnezhywc53g8x7s` | `configs/celestia/rollup.toml` |

By default the **paymaster** pays gas for transactions that come through the preferred sequencer, so test accounts
don't need SEL to send transactions. To make users pay their own gas, set `"paymaster": { "payers": [] }` in genesis.

---

## 7. Useful commands

| Command | What it does |
|---|---|
| `make help` | List all make targets |
| `make selendra-mock` | Run on mock DA |
| `make start-celestia` / `make stop-celestia` | Start / stop the Celestia devnet |
| `make selendra-celestia` | Run on the Celestia devnet |
| `make selendra-tx` | Send a test transaction |
| `make selendra-value` | Read value-setter state |
| `make selendra-transfer TO=0x… AMOUNT=1.5` | Send SEL (or `TOKEN=token_…`) from the dev admin account |
| `make selendra-explorer` | Block explorer on http://127.0.0.1:8080 |
| `make selendra-evm-demo` | ethers.js walkthrough: deploy an ERC-20, call it, read events |
| `make selendra-evm-deploy [CONTRACT=…] [ARGS=…]` | Deploy a contract from `clients/evm-ethers/contracts/` |
| `make selendra-evm-watch [TOKEN=0x…]` | Live blocks and Transfer events over WebSocket |
| `make clean-db` | Wipe all chain data (back to genesis) |
| `make start-obs` / `make stop-obs` | Grafana (`:3000`, admin/admin123) + InfluxDB metrics stack |
| `cargo test` | Run the rollup's integration tests |

---

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| `couldn't find any valid shared libraries matching: ['libclang.so'...]` | `sudo apt install -y clang libclang-dev`. **No sudo?** Download the `libclang` wheel from PyPI, unzip it, and set `LIBCLANG_PATH` and `LD_LIBRARY_PATH` to the folder containing `libclang.so`. Add a `libclang.so.18.1` symlink to it, and set `BINDGEN_EXTRA_CLANG_ARGS="-I$(dirname $(gcc -print-file-name=include/stdbool.h))"`. |
| `libclang.so.XX: cannot open shared object file` after installing clang | An old build script still points at a previous libclang. Run `cargo clean -p clang-sys -p bindgen -p librocksdb-sys`, then build again. |
| `fatal error: 'stdbool.h' file not found` (RocksDB bindgen) | Use the same `BINDGEN_EXTRA_CLANG_ARGS` as above, or install `clang` itself, not only libclang. |
| `Address already in use` on 12346 | Another node is still running. Stop it, or change `bind_port` in `configs/*/rollup.toml`. |
| Node panics at startup after a config or genesis change | `make clean-db` and start again. |
| Switched mock DA ↔ Celestia and the node errors | `make clean-db`. Each DA has its own chain history. |
| `make start-celestia` says `docker-compose.yml: no such file` | `devnet/Makefile` must use `PROJECT_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)`. This is already fixed in Selendra; the upstream file uses `git rev-parse`, which breaks when the folder is inside another git repo. |
| Celestia mode logs `WARN ... get_rollup_batch_namespace ... Request timeout` every few seconds | Normal on the devnet. The node asks the bridge for the next block before it exists, waits until timeout, then retries. Check that `curl -s 127.0.0.1:12346/ledger/slots/latest` keeps increasing; the node should stay 2–3 blocks behind the Celestia head. |
| `WARN The sequencer must pause because the node has lagged behind the DA blockchain` at startup | Normal when the Celestia devnet has been running for a while. The node catches up from `genesis_da_height`, and the sequencer resumes by itself. |
| Right after startup: `ERROR ... 503 ... The sequencer is waiting for the DA to finalize more blocks` | Normal for the first few seconds. The sequencer waits for the first DA block; the JS client retries and the tx succeeds. Wait ~10 s after start before sending transactions. |
| `buckets exhausted` | Increase `storage.user_hashtable_buckets`, then `make clean-db`. |
| `make selendra-tx` fails with module errors | `cd clients/starter-js && npm install`, Node 20+. |

---

## 9. Verified test run

Tested on 2026-10-20 on WSL2 Ubuntu 26.04 (16 cores, 11 GB RAM, Docker 29.8, Node 24):

| Check | Mock DA | Celestia devnet |
|---|---|---|
| `cargo build` (feature set) | ✅ | ✅ `celestia_da,mock_zkvm` |
| Node starts, REST on `:12346`, Swagger returns 200 | ✅ | ✅ |
| `make selendra-value` → `{"value":null}` | ✅ | ✅ |
| `bank.create_token` "Selendra Test Token" → `Bank/TokenCreated`, `result: successful` | — | ✅ gas used 17116 |
| `value_setter.set_value: 10` → `{"value":10}` | ✅ gas used 12827 | — |
| Batches posted as Celestia blobs, slots keep advancing | n/a | ✅ (2–3 blocks behind head) |
| Errors in node log | 0 | 0 (only the retry `WARN`s above) |

## 10. Updating Selendra

| You want to… | Edit | Then |
|---|---|---|
| Change ports, storage, sequencer settings | `configs/<da>/rollup.toml` | restart the node |
| Change balances, sequencer, paymaster | `configs/<da>/genesis.json` | `make clean-db`, restart (new chain) |
| Change chain ID, name, namespaces, gas | `constants.toml` | rebuild + `make clean-db` (new chain hash) |
| Change a module's logic | `modules/<name>/src/` | rebuild; on a live chain this is a hard fork (see `../../docs/sovereign-sdk-guide.md` → "Upgrading the chain") |
| Add / remove a module | `modules/<name>/`, root `Cargo.toml`, `chain/runtime/src/lib.rs`, both `genesis.json` | rebuild + `make clean-db` |
| Change the node itself (REST, CLI, wiring) | `chain/node/src/` | rebuild |

**Update the Sovereign SDK version.** Every SDK crate is pinned to one git `rev` in the root `Cargo.toml`.
The prover guest crates under `chain/provers/*/guest-*` pin it too. One script updates all of them:

```bash
./scripts/update_rev.sh <new-sovereign-sdk-commit>   # run from selendra/
cargo update -p sov-modules-api                      # refresh Cargo.lock
cargo build && cargo test -p rollup-starter          # fix compile errors, then run Mode A and Mode B again
```

Then follow `docs/UPGRADE.md` for the step-by-step checklist. To see which changes are needed in *your* code, compare
against the upstream template at the same SDK rev (<https://github.com/Sovereign-Labs/rollup-starter>). Its files map
to Selendra like this:

| rollup-starter | Selendra |
|---|---|
| `crates/rollup/` | `chain/node/` |
| `crates/stf/` | `chain/stf/` |
| `crates/stf/stf-declaration/` | `chain/runtime/` |
| `crates/provers/` | `chain/provers/` |
| `crates/utils/node-discovery/` | `chain/node-discovery/` |
| `examples/value-setter/` | `modules/value-setter/` |
| `examples/starter-js/`, `metamask/`, `privy/` | `clients/…` |
| `scripts/acceptance-test/`, `scripts/soak-test/`, `foundry-tests/`, `test-data/` | `testing/…` |
| `integrations/` | `devnet/` |
| `configs/`, `constants.toml`, `scripts/*.sh` | same place |

Package names (`rollup-starter`, `stf-starter`, …) were kept on purpose. Upstream diffs and `cargo -p` commands keep
working, and you can rename them later in one go.

## 11. Next steps

1. **Add a Selendra module.** Copy `modules/value-setter`, rename it, add it to the workspace `Cargo.toml`
   and to the Runtime in `chain/runtime/src/lib.rs`, then add its genesis to both genesis files.
   See `../../docs/sovereign-sdk-guide.md` → "Creating a custom module".
2. **Celestia Mocha testnet.** Follow `../../docs/GETTING_STARTED_WITH_CELESTIA.md` → Stage 2:
   - get an RPC provider (for example QuickNode), a new Celestia key, and TIA from the faucet (mocha.celenium.io/faucet);
   - set `rpc_url`, `grpc_url`, `grpc_auth_token`, `signer_private_key` in `configs/celestia/rollup.toml`;
   - set your `celestia1…` address in `seq_da_address` and `sequencers_to_register`;
   - set `genesis_da_height` to a recent Mocha height.
3. **Before any public network:**
   - pick a unique `CHAIN_ID`;
   - replace every dev key above;
   - review the Sovereign license (10 % revenue share, notify info@sovlabs.io).
