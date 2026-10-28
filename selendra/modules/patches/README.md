# modules/patches — patched SDK crates

Selendra uses the Sovereign SDK from git at the rev pinned in the root `Cargo.toml`. Only the crates listed here
are replaced by a local, patched copy, through the `[patch."https://github.com/Sovereign-Labs/sovereign-sdk.git"]`
section of the root `Cargo.toml`.

| Crate | Patches | Why |
|---|---|---|
| `sov-sequencer` (in `modules/sov-sequencer`) | `0001-skip-empty-batches-while-idle.patch` (this folder) | Don't post an empty batch to Celestia on every DA block |
| `sov-evm` (in `modules/sov-evm`) | `0002-evm-rpc-block-by-synthetic-hash.patch` (this folder) | `eth_getBlockByHash` returned "block not found" for a just-sealed block |
| `sov-stf-runner` (in `modules/sov-stf-runner`) | `0003-stf-runner-restart-with-proof-backlog.patch` (this folder) | A prover node whose proofs were not accepted on-chain could not restart |

`modules/sov-sequencer/`, `modules/sov-evm/` and `modules/sov-stf-runner/` are **generated** by `scripts/vendor_sdk_crates.py` (the crate list
and each crate's patches are in `CRATES` at the top of the script). Don't edit them by hand: edit, then regenerate
the `.patch` (see below).

## 0001 — skip empty batches while idle

**Problem.** Upstream, the preferred sequencer publishes a batch on every DA block once the rollup's visible slot is
`ideal_lag_behind_finalized_slot` (10) slots behind, even when the batch has no transactions. Each of those is a
Celestia blob transaction. Measured on the local chain: a 13-byte blob every 6 s with zero users, roughly 2–4 TIA/day
on Celestia just to keep the chain alive.

**Fix** (`trigger_batch_production_if_convenient` in `src/preferred/sync_sequencer_state/inner.rs`). When the open
batch has **no transactions** and **no proof blobs are in flight**, the sequencer waits until the visible slot is
`ideal_lag + max_idle_slots` behind. Then it publishes **one** empty batch that advances the visible slot by up to
`MAX_VISIBLE_HEIGHT_INCREASE_PER_SLOT` (20 in `constants.toml`) at once. Batches with transactions are closed and
published exactly as before.

| Setting | Default | Effect |
|---|---|---|
| `SOV_SEQUENCER_MAX_IDLE_SLOTS` (env var) | `MAX_VISIBLE_HEIGHT_INCREASE_PER_SLOT` = 20 | Extra slots allowed while idle. `0` = upstream behaviour (empty batch every block). Values above the cap are clamped |

**Safety.** The patch changes only the sequencer's local decision of *when* to publish, not consensus or the STF.
Nodes and provers verify the same rules as before:
- The visible slot never lags more than `ideal_lag + 20 = 30` slots, far below `DEFERRED_SLOTS_COUNT = 100000`, the
  point where the node would force-advance and soft confirmations could be lost. Recovery thresholds are ~90,000 slots.
- A transaction arriving while idle opens a batch that catches up immediately (up to 20 slots), so users see no
  added latency. Soft confirmation is unchanged (~50 ms).
- Proofs: while proof blobs are in flight, empty batches are produced as before, so proofs are not delayed.

**Side effects to know.** While idle, the rollup's visible slot / height and the chain clock (`chain-state/time`,
EVM `block.timestamp`) advance in steps of ~20 DA blocks (~2 min at 6 s blocks) instead of every block. They catch
up as soon as a transaction or the next empty batch arrives.

**Saving more.** One batch can advance at most `MAX_VISIBLE_HEIGHT_INCREASE_PER_SLOT` slots (consensus constant,
u8, max 255). Raising it to e.g. 200 would mean one empty batch per ~200 blocks (~99.5% fewer). It is compiled into
the STF and changes the chain, so it needs a rebuild and `make clean-db` (new genesis) — do it before a public launch,
not on a running network.

## 0002 — eth_getBlockByHash for a just-sealed block

**Problem.** Soft-confirmed EVM blocks have a synthetic hash (`0x73796e746865746963…`, "synthetic"). Looking one up
with `eth_getBlockByHash` failed with "block not found" for several seconds after the block was sealed: measured on
the local chain, 6 of 10 lookups at +3 s and +10 s failed, while `eth_getBlockByNumber` for the same block worked.

**Cause** (`get_maybe_sealed_block_by_id` in `src/rpc/block_resolution.rs`). For a synthetic hash whose block number
equals `block_env.number`, the RPC rebuilt the block from the pending transactions. Between `finalize_hook` (which
seals the block and clears the pending txs) and the next `begin_rollup_block_hook`, `block_env` still has that
number, so the pending list was empty and the lookup failed.

**Fix.** Use the pending path only while the block is not sealed yet; otherwise rebuild it from the sealed block (the
existing "Case 2"), which is the order `get_maybe_sealed_block` already uses.

**Safety.** RPC-only code (`native` feature): no change to the STF, state roots or the ZK guests.

## 0003 — restarting a prover node whose proofs were not accepted

**Problem.** When the chain stops accepting a node's proofs (measured: the prover unbonded with
`prover_incentives.exit`, or its bond ran out), the node keeps proving and its proofs are rejected. The proving data
(STF infos) piles up past `max_number_of_transitions_in_db`, or is pruned after use. On restart the node resumes from
the last *accepted* proof and panicked: `Too many STF infos in the db` (`src/processes/stf_info_manager.rs`), a missing
STF info, or `Slot number discontinuity` in the aggregation circuit.

**Fix, in two parts.**
- This patch: the startup check on the number of stored STF infos warns instead of panicking (the running node only
  warns about the same condition), so a node that still has all the data resumes the proof chain.
- `chain/node` (not a patch): before proving starts, `create_prover_service` checks that every STF info from the last
  accepted proof up to the head is stored. If one is missing the node cannot extend the proof chain, so the binary
  logs `Cannot resume proving: …` and re-executes itself with proving disabled: the node (and its sequencer) keeps
  running.

**Not done on purpose.** Starting a fresh outer proof from the stored data gets the prover **slashed**
(`IncorrectGenesisHash`, measured), so the node never does that on its own.

**Recovering proving.** Make sure the prover is bonded (`npm run prover-bond -- register <amount>` in
`clients/starter-js`), then resync the node from genesis with `SOV_PROVER_MODE=prove` (empty `storage.path`). Measured:
proofs accepted again, no slashing.

## Updating after an SDK upgrade

```bash
./scripts/update_rev.sh <new-sdk-rev>
python3 scripts/vendor_sdk_crates.py            # re-vendor from the new rev and re-apply the patches
cargo build && make selendra-evm-compat           # then check idle behaviour (see docs/LocalSelendra.md)
```

If a patch no longer applies, the script stops and says which one. Re-apply the change by hand in
`modules/<crate>`, then regenerate the patch against the pristine sources (the script caches them in
`target/sdk-src/<rev>/<crate path>`). For `sov-sequencer`:

```bash
cd /tmp && rm -rf a b && cp -r ~/project/selendra/target/sdk-src/<rev>/crates/full-node/sov-sequencer/src a \
  && cp -r ~/project/selendra/modules/sov-sequencer/src b
diff -ruN a b | sed -e 's#^--- a/\([^\t]*\).*#--- a/src/\1#' -e 's#^+++ b/\([^\t]*\).*#+++ b/src/\1#' \
  > ~/project/selendra/modules/patches/0001-skip-empty-batches-while-idle.patch
```

To drop the patch entirely, remove the `[patch...]` section from the root `Cargo.toml` (or set
`SOV_SEQUENCER_MAX_IDLE_SLOTS=0` to keep the code but disable the behaviour).
