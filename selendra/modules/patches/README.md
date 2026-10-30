# modules/patches — patched SDK crates

Selendra uses the Sovereign SDK from git at the rev pinned in the root `Cargo.toml`. Only the crates listed here
are replaced by a local, patched copy, through the `[patch."https://github.com/Sovereign-Labs/sovereign-sdk.git"]`
section of the root `Cargo.toml`.

| Crate | Patches | Why |
|---|---|---|
| `sov-sequencer` (in `modules/sov-sequencer`) | `0001-skip-empty-batches-while-idle.patch`, `0006-sequencer-skip-replaying-included-batches.patch` (this folder) | Don't post an empty batch to Celestia on every DA block; a restarted node could die replaying a batch it already had |
| `sov-evm` (in `modules/sov-evm`) | `0002-evm-rpc-block-by-synthetic-hash.patch` (this folder) | `eth_getBlockByHash` returned "block not found" for a just-sealed block |
| `sov-stf-runner` (in `modules/sov-stf-runner`) | `0003-stf-runner-restart-with-proof-backlog.patch`, `0005-stf-runner-skip-proofs-already-accepted.patch` (this folder) | A prover node whose proofs were not accepted on-chain could not restart; a restarted prover was penalized for re-posting proofs |
| `sov-chain-state` (in `modules/sov-chain-state`) | `0004-chain-state-record-charged-gas-price.patch` (this folder) | Valid proofs were rejected because the prover reward exceeded the fees paid in. **Consensus change** |

`modules/sov-sequencer/`, `modules/sov-evm/`, `modules/sov-stf-runner/` and `modules/sov-chain-state/` are **generated** by `scripts/vendor_sdk_crates.py` (the crate list
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
- `chain/node` (not a patch): at startup, when the ledger DB is opened (`create_ledger_db`, before the sequencer
  starts), the node checks that every STF info from the last accepted proof up to the head is stored. If one is
  missing the node cannot extend the proof chain, so the binary logs `Cannot resume proving: …` and re-executes itself
  with proving disabled: the node (and its sequencer) keeps running. The check runs before the sequencer so that
  nothing it started (batches, blob submissions) is torn down mid-startup by the re-exec.

**Not done on purpose.** Starting a fresh outer proof from the stored data gets the prover **slashed**
(`IncorrectGenesisHash`, measured), so the node never does that on its own.

**Recovering proving.** Make sure the prover is bonded (`npm run prover-bond -- register <amount>` in
`clients/starter-js`), then resync the node from genesis with `SOV_PROVER_MODE=prove` (empty `storage.path`). Measured:
proofs accepted again, no slashing.

## 0004 — prover reward computed at the price actually charged (consensus change)

**Problem.** Valid aggregated proofs were rejected with `Error occurred when rewarding the prover … Underflow`.
Measured on a fresh local chain after the compat suite: the reward owed for a slot was 150,681,772 but the prover
pool held 137,598,825.

**Cause.** Transactions in a slot are charged the base fee of the *rollup block* being built
(`base_fee_per_gas` in `sov-modules-stf-blueprint`), but the slot record (`SlotInformation`) keeps the base fee set
when the true (DA) slot began. With soft confirmations the two differ (measured: charged 7, recorded 8). The prover
and attester rewards are `gas_used * gas_price` of the slot record, so whenever the recorded price is higher the
reward exceeds the fees that were paid into the pool.

**Fix** (`finalize_chain_state` in `src/capabilities.rs`). When the slot's gas used is recorded, also record the
price actually charged in that slot. Only the prover and attester rewards read that price.

**Consensus.** This changes the stored slot records and therefore state roots: every node and the ZK guest programs
must run it, and the chain must start from genesis (or use an activation height on a live network). The guest
workspaces (`chain/provers/*/guest-*/Cargo.toml`) patch `sov-chain-state` too; rebuild the guest ELFs (the
committed SP1 ELFs predate this and the EVM gas-limit check in `chain/stf`).

**Measured after the fix.** Same workload on a fresh chain: all slots proven, 0 reward failures, and the slot records
carry the charged price (7).

## 0005 — a restarted prover no longer re-posts proofs (no duplicate penalty)

**Problem.** After every restart the prover was penalized for duplicate proofs (measured: 4 per restart, ~280-560 of
a 200,000 bond). The node resumes from the last proof *accepted* on-chain and re-proves the slots after it, but proofs
for those slots were already posted before the restart: the preferred sequencer re-dispatches them at startup
(measured landing up to 13 DA blocks later).

**Fix.**
- The runner records the final slot of every aggregated proof accepted on-chain.
- The aggregator records the final slot of each proof it posts in `<storage.path>/selendra-last-posted-proof`
  (path set by `chain/node`; a resync from genesis clears it with the storage directory).
- It does not post a window whose final slot is at or below the latest accepted proof or the last proof it posted
  before the restart. Those proofs land anyway: the preferred sequencer persists proof blobs and re-dispatches them at
  startup. The proof is still created, so the outer proof chain stays intact.
- It never waits for them: waiting stalled the runner through back-pressure (it may advance only
  `max_number_of_transitions_in_memory` slots ahead of the prover), so they were never processed and 25 duplicates
  were posted in a test with a small limit. After 120 s it only warns if they are still not accepted.

**Measured.** 4 duplicate penalties per restart before; after: 0 in 6 restarts (production limits) and 0 in a restart
with `max_number_of_transitions_in_db = 6` and proofs pending. Bond unchanged, proofs accepted continuously.

**Limit.** `max_number_of_transitions_in_db` must stay above the number of proofs posted but not yet finalized
(~10 locally). Below that, the proving data for them is pruned before a restart and the node starts with proving
disabled (`Cannot resume proving`, see 0003), as seen with the test limit of 6.

## 0006 — a restarted node could die replaying a batch it already had

**Problem.** Seen twice in restarts of a proving node with proof blobs still in flight (both times the node then fell
back to proving disabled, see 0003): the node died about a second after starting, with 3 panics, the first being
`Sanity check failed: visible slot number calculation was incorrect` (`left: 93, right: 91`). The node had just applied
the first DA block (batch 123, visible slot 92). At the same moment the sequencer's startup replay (soft confirmations
on top of the node state) began at an older sequence number, so it re-applied batch 121 (target visible slot 91), which
that state already included. The sequencer DB itself was consistent (checked with a dump: batches 121/123/125 with
visible slots 91/92/93, proofs in between). Why the node's next sequence number was read behind the state used for
the replay was not established: it happens only when the first DA block lands inside the sequencer's startup window,
and could not be reproduced on demand.

**Fix** (`replay_soft_confirmations_on_top_of_node_state` in `src/preferred/update_state.rs`). The visible slot
strictly increases with every batch, so a stored batch whose target visible slot is at or below the replay checkpoint's
is already part of the node state. The replay skips it, and the proofs before it, with a warning:
`Not replaying a batch that the node state already includes`. Any other mismatch still hits the original assertion.

**Tested** by making the replay start 4 sequence numbers early (a temporary test hack, not in the patch): without the
fix the node dies with the same 3 panics (`left: 297, right: 291`); with it the node skips the 2 included batches, keeps
proving (proofs accepted, no penalties) and serves 20/20 transactions. The node also restarts cleanly from the state
left by the original crash.

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

(`sov-sequencer` has two patches: keep the `src/preferred/update_state.rs` hunk in 0006 and the rest in 0001.)

To drop the patch entirely, remove the `[patch...]` section from the root `Cargo.toml` (or set
`SOV_SEQUENCER_MAX_IDLE_SLOTS=0` to keep the code but disable the behaviour).
