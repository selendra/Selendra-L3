# Selendra

Selendra is a rollup chain built on the [Sovereign SDK](https://github.com/Sovereign-Labs/sovereign-sdk). It posts its data to Celestia.

- **Run it locally:** [docs/LocalSelendra.md](docs/LocalSelendra.md)
- **Use it as an EVM chain (ethers.js, viem, Hardhat, Foundry, MetaMask):** [docs/EVM.md](docs/EVM.md)
- **Upgrade the SDK:** [docs/LocalSelendra.md#10-updating-selendra](docs/LocalSelendra.md#10-updating-selendra) and [docs/UPGRADE.md](docs/UPGRADE.md)

## Quick start

```bash
make selendra-mock      # terminal 1: run the chain on a local mock DA
make selendra-tx        # terminal 2: send a test transaction
make selendra-value     #             read module state
make selendra-explorer  # block explorer at http://127.0.0.1:8080
make selendra-evm-demo  # deploy + use an ERC-20 with ethers.js
make help               # all commands

# API: http://127.0.0.1:12346 (Swagger UI at /swagger-ui/, EVM RPC at /rpc, chain ID 19610)
```

## Layout

| Folder | What it holds |
|---|---|
| `chain/` | **Main code**: `node/` (binary), `runtime/` (module list), `stf/`, `provers/`, `node-discovery/` |
| `modules/` | Custom modules, one folder per module (`value-setter` is the example), plus `sov-sequencer`: the SDK sequencer patched to skip empty batches while idle (see `modules/patches/README.md`) |
| `configs/` | Node config and genesis per DA layer: `mock/` and `celestia/` |
| `constants.toml` | Chain ID, name, namespaces and gas. These are compiled in and must stay at the root |
| `explorer/` | Block explorer: one static page that reads the node API |
| `clients/` | Apps that talk to the chain: `starter-js` (TypeScript), `evm-ethers` (ethers.js + Solidity), `metamask`, `privy` |
| `testing/` | `test-data/` (dev keys), `acceptance-test/`, `soak-test/`, `foundry-tests/` |
| `devnet/` | Local Docker infrastructure: Celestia devnet, Postgres, Hyperlane, rollup Dockerfile |
| `scripts/` | Helper shell scripts (`update_rev.sh`, observability, soak runner) |
| `docs/` | Guides |

Based on [rollup-starter](https://github.com/Sovereign-Labs/rollup-starter) `972e5cd` (SDK rev `f1a2dc3`). License: see [LICENSE.md](LICENSE.md). It includes a revenue-share requirement for commercial use.
