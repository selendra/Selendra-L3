use std::num::NonZero;
use std::sync::Arc;

use backon::{BackoffBuilder, ExponentialBuilder};
use sov_rollup_full_node_interface::DaSyncState;
use sov_rollup_interface::da::BlockHeaderTrait;
use sov_rollup_interface::node::da::DaService;
use sov_rollup_interface::node::SyncStatus;
use sov_rollup_interface::stf::ProofSender;
use sov_rollup_interface::zk::aggregated_proof::SerializedAggregatedProof;
use sov_shutdown::{
    BackgroundHandle, FutureOrShutdownOutput, PrimaryShutdownController,
    SecondaryShutdownController,
};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};
use types::{BlockProofInfo, BlockProofStatus, UnAggregatedProofList};

use self::types::AggregateProofMetadata;
use super::StateTransitionInfo;
use crate::processes::{CursorHandle, ProverService, Receiver};

mod types;

/// Selendra: final slot of the latest aggregated proof this node has seen accepted on-chain (from DA), or 0.
/// Updated by the runner; read by the aggregator to avoid re-posting proofs the chain already has.
static LATEST_ACCEPTED_PROOF_FINAL_SLOT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Records that an aggregated proof ending at `final_slot` was accepted on-chain.
pub fn record_accepted_proof_final_slot(final_slot: sov_rollup_interface::common::SlotNumber) {
    LATEST_ACCEPTED_PROOF_FINAL_SLOT.fetch_max(final_slot.get(), std::sync::atomic::Ordering::SeqCst);
}

fn latest_accepted_proof_final_slot() -> u64 {
    LATEST_ACCEPTED_PROOF_FINAL_SLOT.load(std::sync::atomic::Ordering::SeqCst)
}

/// After this long, the aggregator warns if the proofs it posted before a restart are still not accepted on-chain.
/// It does not re-post them: the preferred sequencer persists proof blobs and re-dispatches them at startup until they
/// land (measured: up to 13 DA blocks later), and waiting for them here would stall the runner through back-pressure.
const STARTUP_IN_FLIGHT_WARN_AFTER: Duration = Duration::from_secs(120);

/// Selendra: file in which the aggregator records the final slot of the last proof it posted (set by the node).
static POSTED_PROOF_RECORD: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Sets the file recording the final slot of the last aggregated proof this node posted, kept across restarts.
pub fn set_posted_proof_record_path(path: std::path::PathBuf) {
    let _ = POSTED_PROOF_RECORD.set(path);
}

fn read_last_posted_proof_final_slot() -> u64 {
    POSTED_PROOF_RECORD
        .get()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
}

fn record_posted_proof_final_slot(final_slot: u64) {
    let Some(path) = POSTED_PROOF_RECORD.get() else {
        return;
    };
    let tmp = path.with_extension("tmp");
    if let Err(error) = std::fs::write(&tmp, final_slot.to_string()).and_then(|()| std::fs::rename(&tmp, path)) {
        tracing::warn!(%error, path = %path.display(), "Failed to record the last posted aggregated proof");
    }
}

const BACKOFF_POLICY_MIN_DELAY: u64 = 1;
const BACKOFF_POLICY_MAX_DELAY: u64 = 60;
const BACKOFF_POLICY_MAX_NUM_RETRIES: usize = 5;

/// Manages the lifecycle of the `AggregatedProof`.
#[allow(clippy::type_complexity)]
pub struct ZkProofManager<Ps: ProverService> {
    prover_service: Arc<Ps>,
    proofs_to_create: UnAggregatedProofList<Ps>,
    aggregated_proof_block_jump: NonZero<usize>,
    eager_proof_submission: bool,
    max_number_of_aggregated_proofs_in_memory: NonZero<usize>,
    proof_sender: Box<dyn ProofSender>,
    backoff_policy: ExponentialBuilder,
    stf_info_receiver: Receiver<Ps::StateRoot, Ps::Witness, <Ps::DaService as DaService>::Spec>,
    da_sync_state: Arc<DaSyncState>,
    secondary_shutdown_controller: SecondaryShutdownController,
    primary_shutdown: PrimaryShutdownController,
    start_fresh_outer_proof_on_resync: bool,
}

impl<Ps: ProverService> ZkProofManager<Ps>
where
    Ps::DaService: DaService<Error = anyhow::Error>,
{
    /// Creates a new proof manager.
    #[allow(clippy::type_complexity)]
    pub fn new(
        prover_service: Ps,
        aggregated_proof_block_jump: NonZero<usize>,
        eager_proof_submission: bool,
        max_number_of_aggregated_proofs_in_memory: NonZero<usize>,
        proof_sender: Box<dyn ProofSender>,
        stf_info_receiver: Receiver<Ps::StateRoot, Ps::Witness, <Ps::DaService as DaService>::Spec>,
        da_sync_state: Arc<DaSyncState>,
        secondary_shutdown_controller: &SecondaryShutdownController,
        primary_shutdown: PrimaryShutdownController,
        start_fresh_outer_proof_on_resync: bool,
    ) -> Self {
        Self {
            prover_service: Arc::new(prover_service),
            proofs_to_create: UnAggregatedProofList::new(),
            aggregated_proof_block_jump,
            eager_proof_submission,
            max_number_of_aggregated_proofs_in_memory,
            proof_sender,
            backoff_policy: ExponentialBuilder::default()
                .with_min_delay(Duration::from_secs(BACKOFF_POLICY_MIN_DELAY))
                .with_max_delay(Duration::from_secs(BACKOFF_POLICY_MAX_DELAY))
                .with_max_times(BACKOFF_POLICY_MAX_NUM_RETRIES),
            stf_info_receiver,
            da_sync_state,
            secondary_shutdown_controller: secondary_shutdown_controller.clone(),
            primary_shutdown,
            start_fresh_outer_proof_on_resync,
        }
    }

    /// Spawns the intake and aggregator background tasks.
    ///
    /// Returns a single supervisor handle that resolves once both tasks
    /// terminate.
    pub async fn post_aggregated_proof_to_da_in_background(self) -> BackgroundHandle<()> {
        BackgroundHandle::spawn("aggregated-proof-poster", async move {
            tracing::info!("Spawning an aggregated proof posting background task");

            let (metadata_tx, metadata_rx) = mpsc::channel::<(AggregateProofMetadata<Ps>, u64)>(
                self.max_number_of_aggregated_proofs_in_memory.get(),
            );

            // Cursor handle is shared: the aggregator advances it after a
            // publish succeeds, and the intake advances it for slots that are
            // intentionally skipped (e.g. the resync window). See module-level
            // docs.
            let cursor = self.stf_info_receiver.cursor_handle();

            let aggregator = AggregatorTask {
                prover_service: self.prover_service.clone(),
                proof_sender: self.proof_sender,
                backoff_policy: self.backoff_policy,
                metadata_rx,
                cursor: cursor.clone(),
                primary_shutdown: self.primary_shutdown,
                posted_before_restart: read_last_posted_proof_final_slot(),
                warn_after: Some(tokio::time::Instant::now() + STARTUP_IN_FLIGHT_WARN_AFTER),
            };

            let aggregator_shutdown_controller = self.secondary_shutdown_controller.clone();
            let aggregator_handle = tokio::spawn(async move {
                run_task_until_shutdown(
                    "aggregator",
                    aggregator.run(),
                    &aggregator_shutdown_controller,
                )
                .await;
            });

            let intake = IntakeTask {
                prover_service: self.prover_service,
                proofs_to_create: self.proofs_to_create,
                aggregated_proof_block_jump: self.aggregated_proof_block_jump,
                eager_proof_submission: self.eager_proof_submission,
                stf_info_receiver: self.stf_info_receiver,
                da_sync_state: self.da_sync_state,
                metadata_tx,
                cursor,
                start_fresh_outer_proof_on_resync: self.start_fresh_outer_proof_on_resync,
            };

            run_task_until_shutdown(
                "aggregated proof intake",
                intake.run(),
                &self.secondary_shutdown_controller,
            )
            .await;

            if let Err(e) = aggregator_handle.await {
                tracing::error!(error = ?e, "Aggregator task panicked");
            }
        })
    }
}

/// Runs `task` until it completes or the shutdown signal fires, logging the
/// outcome. On shutdown the task is cancelled at its current await point.
async fn run_task_until_shutdown<T>(
    task_name: &str,
    task: impl std::future::Future<Output = anyhow::Result<T>>,
    secondary_shutdown_controller: &SecondaryShutdownController,
) {
    match secondary_shutdown_controller.future_or_shutdown(task).await {
        FutureOrShutdownOutput::Shutdown => {
            tracing::info!(task_name, "Shutting down task...");
        }
        FutureOrShutdownOutput::Output(Err(e)) => {
            tracing::error!(error = ?e, task_name, "Task failed");
        }
        FutureOrShutdownOutput::Output(Ok(_)) => {}
    }
}

/// Tracks the resync skip-window state machine for the proof intake.
enum ResyncState {
    /// `start_fresh_outer_proof_on_resync` is disabled; always prove.
    Disabled,
    /// Flag enabled, DA still `Syncing`. Skip-advance every slot so the runner
    /// can keep pushing transitions and sync can complete. Cutoff not yet captured.
    AwaitingSync,
    /// Flag enabled, first `Synced` observed at this DA height. Skip slots below
    /// this height (they were drained but never proved); prove slots at or above.
    SkipBelow(u64),
}

/// Per-slot intake side of [`ZkProofManager`]. See the type-level docs for
/// how it cooperates with [`AggregatorTask`].
struct IntakeTask<Ps: ProverService> {
    prover_service: Arc<Ps>,
    proofs_to_create: UnAggregatedProofList<Ps>,
    aggregated_proof_block_jump: NonZero<usize>,
    eager_proof_submission: bool,
    stf_info_receiver: Receiver<Ps::StateRoot, Ps::Witness, <Ps::DaService as DaService>::Spec>,
    da_sync_state: Arc<DaSyncState>,
    metadata_tx: mpsc::Sender<(AggregateProofMetadata<Ps>, u64)>,
    cursor: CursorHandle,
    start_fresh_outer_proof_on_resync: bool,
}

impl<Ps: ProverService> IntakeTask<Ps>
where
    Ps::DaService: DaService<Error = anyhow::Error>,
{
    /// Never returns successfully: the task runs until it errors or is
    /// cancelled by the caller's shutdown wrapper.
    async fn run(mut self) -> anyhow::Result<std::convert::Infallible> {
        let mut resync_state = if self.start_fresh_outer_proof_on_resync {
            ResyncState::AwaitingSync
        } else {
            ResyncState::Disabled
        };

        loop {
            let stf_info = match self.stf_info_receiver.read_next().await? {
                None => {
                    tracing::debug!("Received None instead of StateTransitionInfo. This can happen if the transition has already been processed by the `Receiver`. In that case, it is fine to ignore the notification.");
                    continue;
                }
                Some(stf_info) => stf_info,
            };
            tracing::trace!(
                slot_number = %stf_info.slot_number(),
                block_header = %stf_info.da_block_header().display(),
                "Received STF info"
            );

            // If still observing resync, try to capture the cutoff. Until the DA
            // layer reports `Synced` at least once, skip-advance the current slot
            // unconditionally — this drains the channel so the runner can keep
            // producing.
            if matches!(resync_state, ResyncState::AwaitingSync) {
                match self.da_sync_state.status() {
                    SyncStatus::Syncing { .. } => {
                        self.cursor.inc_next_height_to_receive_by(1);
                        continue;
                    }
                    SyncStatus::Synced { synced_da_height } => {
                        tracing::info!(
                            %synced_da_height,
                            "DA resync complete; recording skip cutoff for proof intake"
                        );
                        resync_state = ResyncState::SkipBelow(synced_da_height);
                        // fall through; this slot may still be below the cutoff.
                    }
                }
            }

            if let ResyncState::SkipBelow(skip_height) = resync_state {
                if stf_info.da_block_header().height() < skip_height {
                    // Skipped slots will never be proved, so advance
                    // the cursor manually.
                    self.cursor.inc_next_height_to_receive_by(1);
                    continue;
                }
            }

            self.process_stf_info(stf_info).await?;
        }
    }

    async fn process_stf_info(
        &mut self,
        stf_info: StateTransitionInfo<
            Ps::StateRoot,
            Ps::Witness,
            <Ps::DaService as DaService>::Spec,
        >,
    ) -> anyhow::Result<()> {
        let first_height_unproven = self.stf_info_receiver.next_height_to_receive();
        let received_slot_number = stf_info.slot_number();

        assert!(
            received_slot_number.get() >= first_height_unproven.get(),
            "Received slot {received_slot_number} is behind first unproven height {first_height_unproven}"
        );

        // We ensure that we're not trying to prove blocks that are being proven.
        // If that is not the case, we add the block to the queue.
        if first_height_unproven.saturating_add(self.proofs_to_create.current_proof_jump() as u64)
            <= stf_info.slot_number()
        {
            let block_header = stf_info.da_block_header().clone();
            // Save the transition for later proving. This is temporarily redundant
            // since we always just try to prove blocks right away (because we don't have fee
            // estimates for proving built out yet).
            self.proofs_to_create.append(BlockProofInfo {
                status: BlockProofStatus::Waiting(stf_info),
                header: block_header,
                // TODO(@preston-evans98): estimate public data size. This requires a new API on the `prover_service`.
                // <https://github.com/Sovereign-Labs/sovereign-sdk-wip/issues/440>
                public_data_size: 0,
            });
        }

        if self.eager_proof_submission {
            self.proofs_to_create
                .oldest_mut()
                .prove_any_unproven_blocks(&*self.prover_service)
                .await;
        }

        let num_proofs_to_create = self.proofs_to_create.current_proof_jump();

        // If we've covered enough blocks for the aggregate proof, hand the
        // window off to the aggregator task.
        if num_proofs_to_create >= self.aggregated_proof_block_jump.get() {
            self.proofs_to_create.close_newest_proof();
            let metadata = self.proofs_to_create.take_oldest();
            let window_size = num_proofs_to_create as u64;

            // Capacity is `max_number_of_aggregated_proofs_in_memory`: blocks
            // here only once the aggregator has one window in flight AND that
            // many windows buffered. While blocked, intake stops draining the
            // STF-info mpsc, which propagates back-pressure upstream to the
            // runner exactly as in the pre-pipelining design.
            self.metadata_tx
                .send((metadata, window_size))
                .await
                .map_err(|_| {
                    anyhow::anyhow!("Aggregator task has terminated; cannot send metadata")
                })?;
        }

        let pending_agg_metadata = self.metadata_tx.max_capacity() - self.metadata_tx.capacity();
        sov_metrics::track_metrics(|tracker| {
            tracker.submit(super::metrics::ZkProofManagerMetrics {
                proving_lag: received_slot_number.get() - first_height_unproven.get(),
                proofs_to_create: self.proofs_to_create.current_proof_jump(),
                slot_number: received_slot_number.get(),
                pending_agg_metadata,
            });
        });

        Ok(())
    }
}

struct AggregatorTask<Ps: ProverService> {
    prover_service: Arc<Ps>,
    proof_sender: Box<dyn ProofSender>,
    backoff_policy: ExponentialBuilder,
    metadata_rx: mpsc::Receiver<(AggregateProofMetadata<Ps>, u64)>,
    cursor: CursorHandle,
    primary_shutdown: PrimaryShutdownController,
    /// Final slot of the last proof this node posted before it (re)started, from the posted-proof record.
    posted_before_restart: u64,
    /// When to check that the proofs posted before the restart were accepted (see [`STARTUP_IN_FLIGHT_WARN_AFTER`]).
    warn_after: Option<tokio::time::Instant>,
}

impl<Ps: ProverService> AggregatorTask<Ps>
where
    Ps::DaService: DaService<Error = anyhow::Error>,
{
    async fn run(mut self) -> anyhow::Result<()> {
        loop {
            let (metadata, window_size) = match self.metadata_rx.recv().await {
                // Intake side dropped its sender (clean shutdown or intake error).
                None => {
                    tracing::debug!("Intake task closed metadata channel; aggregator exiting");
                    break;
                }
                Some(item) => item,
            };

            let status = self.proof_sender.proof_blob_sender_status().await?;
            if status.is_busy() {
                tracing::error!(
                    in_flight = status.in_flight,
                    max_concurrent_proof_blobs = status.max_concurrent,
                    "The zk proof blob sender is busy, which means proofs are not being confirmed by the rollup on time. Triggering shutdown."
                );
                self.primary_shutdown.shutdown();
                break;
            }

            let proving_start = std::time::Instant::now();
            let agg_proof = create_aggregate_proof_with_retries(
                metadata,
                &*self.prover_service,
                &self.backoff_policy,
            )
            .await?;
            let aggregation_duration = proving_start.elapsed();

            sov_metrics::track_metrics(|tracker| {
                tracker.submit(super::metrics::ZkAggregatedProofMetrics {
                    aggregation_duration_ms: aggregation_duration.as_millis(),
                });
            });

            // Selendra: after a restart the node resumes from the last proof accepted on-chain and re-proves the
            // slots after it, but it already posted proofs for some of them (accepted since, or re-dispatched by the
            // sequencer). Re-posting those gets the prover penalized for duplicates, so skip windows the chain has
            // accepted or this node posted before the restart. The proof is still created above, so the outer proof
            // chain stays intact for the next window.
            let final_slot = self.cursor.next_height_to_receive().get() + window_size - 1;
            self.warn_if_proofs_from_before_restart_are_missing();
            let latest_accepted = latest_accepted_proof_final_slot();
            if final_slot <= latest_accepted.max(self.posted_before_restart) {
                tracing::info!(
                    final_slot,
                    latest_accepted,
                    posted_before_restart = self.posted_before_restart,
                    "Not posting aggregated proof: already accepted on-chain or posted before the restart"
                );
                self.cursor.inc_next_height_to_receive_by(window_size);
                continue;
            }

            tracing::debug!(
                bytes = agg_proof.raw_aggregated_proof.len(),
                "Sending aggregated proof to DA"
            );

            self.proof_sender
                .publish_proof_blob_with_metadata(agg_proof)
                .await?;
            record_posted_proof_final_slot(final_slot);

            self.cursor.inc_next_height_to_receive_by(window_size);
        }
        tracing::debug!("Aggregator task has been completed");
        Ok(())
    }

    /// Warns once if, [`STARTUP_IN_FLIGHT_WARN_AFTER`] after startup, the chain still has not accepted the proofs
    /// this node posted before the restart.
    fn warn_if_proofs_from_before_restart_are_missing(&mut self) {
        let Some(warn_after) = self.warn_after else {
            return;
        };
        if tokio::time::Instant::now() < warn_after {
            return;
        }
        self.warn_after = None;
        let latest_accepted = latest_accepted_proof_final_slot();
        if latest_accepted < self.posted_before_restart {
            tracing::warn!(
                posted_before_restart = self.posted_before_restart,
                latest_accepted,
                "Proofs posted before the restart are still not accepted on-chain; check the proof blob sender"
            );
        }
    }
}

async fn create_aggregate_proof_with_retries<Ps: ProverService>(
    mut metadata: AggregateProofMetadata<Ps>,
    prover_service: &Ps,
    backoff_policy: &ExponentialBuilder,
) -> anyhow::Result<SerializedAggregatedProof> {
    let mut attempt_num = 1u32;
    let mut backoff_iter = backoff_policy.build();

    loop {
        let maybe_backoff_duration = backoff_iter.next();

        match metadata.prove(prover_service).await {
            Ok(proof) => return Ok(proof),
            Err((returned_metadata, error)) => {
                let error_message = format!("Failed to generate aggregate proof: {error}");

                if error_message.contains("Elf parse error") {
                    // NOTE We exit early on this error since it means the we've failed to find/parse
                    // the zk circuit, and there's no recovering from that.
                    tracing::error!("Fatal error: {error_message}");
                    tracing::error!("Please check your zk circuit ELF file was built correctly!");
                    anyhow::bail!(error)
                };

                if error_message.contains("Outer network proving") {
                    tracing::error!("Fatal error: {error_message}");
                    anyhow::bail!(error)
                };

                tracing::error!(error_message);
                match maybe_backoff_duration {
                    None => {
                        tracing::warn!("Maximum number of retries exhausted - exiting");
                        anyhow::bail!(error)
                    }
                    Some(duration) => {
                        tracing::info!("Retrying generation of aggregate proof in {}s, attempt {attempt_num} of {}...", duration.as_secs(), BACKOFF_POLICY_MAX_NUM_RETRIES);
                        attempt_num += 1;
                        sleep(duration).await;
                        metadata = returned_metadata;
                        continue;
                    }
                }
            }
        }
    }
}
