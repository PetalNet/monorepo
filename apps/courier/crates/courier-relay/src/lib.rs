//! The relay engine: mirrors messages between configured room clusters.
//!
//! Reliability posture (each mechanism is first-class, see the modules):
//!
//! - every network call is bounded ([`media`], [`plan`],
//!   [`courier_core::bound`]);
//! - per-leg delivery health is recorded for every attempt and legs are
//!   pre-registered from config ([`courier_core::health`]);
//! - exactly-once delivery: a persisted delivery [`ledger`] plus stable
//!   per-(event, target, purpose) transaction ids ([`idempotency`]) mean a
//!   retry or restart never loses or duplicates a message;
//! - startup backfill replays anything the ledger says is incomplete;
//! - events from the same source room are serialized (per-room fair lock) so
//!   relayed messages keep their order even though every event is processed
//!   in its own supervised task.

mod format;
pub mod idempotency;
pub mod ledger;
mod media;
mod plan;
mod state;

pub use plan::{RelayCluster, RelayConfig};

use core::sync::atomic::{AtomicBool, Ordering};
use core::time::Duration;
use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context as _, Result};
use async_trait::async_trait;
use matrix_sdk::{
    Client,
    room::{MessagesOptions, Room},
    ruma::{
        OwnedEventId, OwnedRoomId,
        events::{
            AnySyncMessageLikeEvent, AnySyncTimelineEvent,
            relation::InReplyTo,
            room::message::{
                AddMentions, ForwardThread, OriginalSyncRoomMessageEvent, Relation, ReplyMetadata,
                RoomMessageEventContent, SyncRoomMessageEvent,
            },
        },
        serde::Raw,
    },
};
use tokio::sync::{Mutex, RwLock};
use tracing::{error, info, warn};

use courier_core::{
    bound,
    health::{DEAD_LEG_THRESHOLD, RelayHealth},
    plugin::{Plugin, PluginContext, PluginSpec, PluginTriggers, RoomMessageMeta},
    text::to_bold,
};

use crate::format::ReplyContext;
use crate::ledger::DeliveryLedger;
use crate::plan::{DEFAULT_BACKFILL_LIMIT, LOOKUP_TIMEOUT, RelayPlan};
use crate::state::LastSeen;

/// Soft cap on the cross-room reply mapping; when exceeded the map is fully
/// cleared. Old threading info loses fidelity (replies fall back to
/// text-only), new conversations keep threading. Bounded memory > perfect
/// history.
const REPLY_MAP_CAP: usize = 50_000;

const BACKFILL_FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Outer safety-net budget for one relayed event, declared to the host via
/// [`Plugin::passive_budget`]. Every network call in the relay is already
/// individually bounded; the worst legitimate case per target is roughly
/// reply lookup (15s) + display lookup (15s) + media download (2×90s+15s) +
/// media upload (2×120s+15s) + caption (3×30s+18s) ≈ 9.5 minutes, and a
/// cluster can fan out to several targets. A too-small outer budget kills
/// valid media relays mid-flight before their own bounded retries finish —
/// expiry here abandons the event (backfill then retries it).
const RELAY_PASSIVE_BUDGET: Duration = Duration::from_secs(1800);

/// The relay plugin.
#[derive(Debug)]
pub struct Relay {
    plan: RwLock<Option<Arc<RelayPlan>>>,
    backfill_started: AtomicBool,
    last_seen: Mutex<Option<LastSeen>>,
    /// Cross-room event mapping for native reply forwarding.
    /// Key = (`source_room_id`, `source_event_id`); value = which target
    /// room got which `event_id` when that source event was relayed. Used to
    /// emit a native `m.relates_to.m.in_reply_to` pointer in target rooms.
    /// In-memory only: a restart loses the map and in-flight conversations
    /// briefly fall back to text-only reply headers until the next
    /// round-trip re-seeds them.
    reply_map: RwLock<HashMap<(OwnedRoomId, OwnedEventId), HashMap<OwnedRoomId, OwnedEventId>>>,
    /// Per-(source event, target room) delivery ledger — the source of truth
    /// for "has this event reached this leg".
    ledger: Mutex<Option<DeliveryLedger>>,
    /// Per-source-room fair locks serializing relay work, so concurrent
    /// supervised tasks can't reorder a room's messages.
    room_locks: Mutex<HashMap<OwnedRoomId, Arc<Mutex<()>>>>,
    /// Per-destination delivery health; shared with the reporter and `!diag`.
    health: Arc<RelayHealth>,
}

impl Relay {
    /// Create a relay wired to the shared per-leg health registry.
    #[must_use]
    pub fn new(health: Arc<RelayHealth>) -> Self {
        Self {
            plan: RwLock::default(),
            backfill_started: AtomicBool::new(false),
            last_seen: Mutex::default(),
            reply_map: RwLock::default(),
            ledger: Mutex::default(),
            room_locks: Mutex::default(),
            health,
        }
    }

    async fn room_lock(&self, room_id: &OwnedRoomId) -> Arc<Mutex<()>> {
        let mut locks = self.room_locks.lock().await;
        Arc::clone(locks.entry(room_id.clone()).or_default())
    }
}

#[async_trait]
impl Plugin for Relay {
    fn id(&self) -> &'static str {
        "relay"
    }

    fn help(&self) -> &'static str {
        "Relay messages between configured room clusters"
    }

    fn handles_room_messages(&self) -> bool {
        true
    }

    fn passive_budget(&self) -> Option<Duration> {
        Some(RELAY_PASSIVE_BUDGET)
    }

    fn spec(&self) -> PluginSpec {
        PluginSpec {
            id: "relay".to_owned(),
            enabled: true,
            dev_only: None,
            triggers: PluginTriggers::default(),
            config: serde_yaml::Value::default(),
        }
    }

    async fn on_startup(
        &self,
        client: &Client,
        spec: &PluginSpec,
        history_dir: Arc<PathBuf>,
        dev_active: bool,
    ) -> Result<()> {
        if dev_active {
            info!("Dev mode active: relay startup backfill disabled");
            return Ok(());
        }
        if self.backfill_started.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        if let Some(plan) = self.ensure_plan(client, spec).await? {
            self.validate_rooms(client, &plan);
        }
        if let Err(e) = self
            .run_startup_backfill(client, spec, history_dir.as_ref().as_path())
            .await
        {
            warn!(error = %e, "Relay startup backfill failed");
        }
        Ok(())
    }

    async fn run(&self, _ctx: &PluginContext, _args: &str, _spec: &PluginSpec) -> Result<()> {
        Ok(())
    }

    async fn on_room_message(
        &self,
        ctx: &PluginContext,
        event: &OriginalSyncRoomMessageEvent,
        spec: &PluginSpec,
        _meta: &RoomMessageMeta,
    ) -> Result<()> {
        info!(room_id = %ctx.room.room_id(), sender = %event.sender, "Relay: on_room_message");

        if ctx.dev_active {
            info!(room_id = %ctx.room.room_id(), "Dev mode active: relay disabled");
            return Ok(());
        }

        let Some(plan) = self.ensure_plan(&ctx.client, spec).await? else {
            info!(room_id = %ctx.room.room_id(), "Relay: no plan loaded (config empty?)");
            return Ok(());
        };

        let source_id = ctx.room.room_id().to_owned();
        let history_dir = ctx.history_dir.as_ref().as_path();

        // Serialize per source room (fair lock → FIFO wakeups) so relayed
        // messages keep their order across concurrent supervised tasks.
        let lock = self.room_lock(&source_id).await;
        let _ordering_guard = lock.lock().await;

        // Mark-seen advances ONLY on full delivery to every required target.
        // A partial fan-out (one leg ok, one failed) stays incomplete in the
        // delivery ledger and is retried by backfill.
        if self
            .relay_event(&ctx.client, &plan, &ctx.room, event, history_dir)
            .await?
        {
            self.mark_last_seen(history_dir, &source_id, event.origin_server_ts.get().into())
                .await;
        }

        Ok(())
    }
}

impl Relay {
    /// Log loudly at startup if a configured relay room has no local handle —
    /// the historical dead-leg failure mode (the bot silently skipped the
    /// room at relay time with a per-message WARN nobody saw).
    fn validate_rooms(&self, client: &Client, plan: &RelayPlan) {
        for room_id in plan.map.keys() {
            // Every configured room is also a destination for its peers;
            // pre-register so quiet legs are visible in reports from boot.
            self.health.register(room_id.as_str());
            if client.get_room(room_id).is_none() {
                self.health
                    .record_failure(room_id.as_str(), "room handle missing at startup");
                error!(
                    room = %room_id,
                    "Configured relay room is NOT available (not joined / bridge gone?) — this leg is dead until fixed"
                );
            }
        }
    }

    /// Relay one event to every required target. Returns `true` only when
    /// EVERY required target has confirmed delivery (now or previously) —
    /// the caller must not advance the last-seen mark otherwise.
    #[allow(
        clippy::too_many_lines,
        reason = "delivery accounting must remain adjacent so the last-seen mark cannot advance before every relay leg completes"
    )]
    async fn relay_event(
        &self,
        client: &Client,
        plan: &RelayPlan,
        source_room: &Room,
        event: &OriginalSyncRoomMessageEvent,
        history_dir: &Path,
    ) -> Result<bool> {
        let source_id = source_room.room_id().to_owned();
        let Some(targets) = plan.map.get(&source_id).cloned() else {
            info!(room_id = %source_id, "Relay: room not in mapping");
            return Ok(false);
        };
        let required: Vec<OwnedRoomId> = targets.into_iter().filter(|t| *t != source_id).collect();
        if required.is_empty() {
            return Ok(false);
        }
        let opts = plan.opts.get(&source_id).copied().unwrap_or_default();

        let source_event_id = event.event_id.clone();
        let event_ts: u64 = event.origin_server_ts.get().into();

        // Persist an incomplete ledger entry BEFORE any send so a crash
        // mid-fan-out is retried after restart, then skip legs that already
        // confirmed delivery on a previous attempt (no duplicates on retry).
        self.ledger_record_attempt(
            history_dir,
            source_event_id.as_str(),
            source_id.as_str(),
            event_ts,
        )
        .await;
        let already_delivered = self
            .ledger_delivered(history_dir, source_event_id.as_str())
            .await;
        if required
            .iter()
            .all(|t| already_delivered.contains(t.as_str()))
        {
            self.ledger_set_complete(history_dir, source_event_id.as_str())
                .await;
            return Ok(true);
        }

        let display_name = resolve_display_name(source_room, &event.sender).await;
        let display_name_bold = to_bold(&display_name);

        // If the inbound is a reply, figure out who it replied to so we can
        // render "X replied to Y: ..." AND look up the target-room twin
        // event for a native Matrix reply.
        let reply_context = extract_reply_context(&event.content, source_room).await;

        let formatted_text = format::format_text_message(
            &event.content.msgtype,
            &display_name_bold,
            reply_context.as_ref(),
        );

        let mut all_delivered = true;

        for target_id in required {
            if already_delivered.contains(target_id.as_str()) {
                continue;
            }
            let Some(room_handle) = client.get_room(&target_id) else {
                let failures = self
                    .health
                    .record_failure(target_id.as_str(), "no room handle");
                log_leg_failure(&source_id, &target_id, "no room handle", failures);
                all_delivered = false;
                continue;
            };

            // Native reply pointer when we know the original's twin in this
            // target room; plain content otherwise.
            let native_reply_target = if let Some(rctx) = reply_context.as_ref() {
                let guard = self.reply_map.read().await;
                guard
                    .get(&(source_id.clone(), rctx.source_event_id.clone()))
                    .and_then(|m| m.get(&target_id).cloned())
            } else {
                None
            };

            // Stable per-(source event, target, purpose) transaction id:
            // retries of the same logical relay re-use it, so the homeserver
            // dedupes a resend whose first attempt landed.
            let txn_id = idempotency::relay_txn_id(&source_event_id, &target_id, "relay");

            let send_res = if let Some(text) = formatted_text.as_ref() {
                let mut content = RoomMessageEventContent::text_plain(text.clone());
                if let Some(target_event_id) = native_reply_target.as_ref() {
                    // ReplyMetadata only uses `sender` for AddMentions, which
                    // we suppress; passing the bot's own id is fine.
                    if let Some(bot_user_id) = client.user_id() {
                        let bot_uid = bot_user_id.to_owned();
                        let meta = ReplyMetadata::new(target_event_id, &bot_uid, None);
                        content = content.make_reply_to(meta, ForwardThread::No, AddMentions::No);
                    } else {
                        // Extremely unlikely (client without a logged-in
                        // user); fall back to a raw relates_to pointer.
                        content.relates_to = Some(Relation::Reply {
                            in_reply_to: InReplyTo::new(target_event_id.clone()),
                        });
                    }
                }
                media::send_text_bounded(&room_handle, &content, &txn_id).await
            } else {
                media::forward_media(client, &room_handle, event, opts.reupload_media, &txn_id)
                    .await
            };

            match send_res {
                Ok(resp) => {
                    self.health.record_success(target_id.as_str());
                    self.ledger_record_delivery(
                        history_dir,
                        source_event_id.as_str(),
                        target_id.as_str(),
                    )
                    .await;
                    info!(
                        from = %source_id,
                        to = %target_id,
                        sender = %event.sender,
                        threaded = native_reply_target.is_some(),
                        "Relayed message"
                    );
                    // Record (source_event -> target_event) so a future reply
                    // to this source event can be threaded in this target.
                    self.record_relay(
                        source_id.clone(),
                        source_event_id.clone(),
                        target_id.clone(),
                        resp.event_id.clone(),
                    )
                    .await;
                    if formatted_text.is_none()
                        && opts.caption_media
                        && let Some(kind) = format::media_kind(&event.content.msgtype)
                    {
                        let caption = RoomMessageEventContent::text_plain(format!(
                            "{display_name_bold}: sent a {kind}"
                        ));
                        let caption_txn =
                            idempotency::relay_txn_id(&source_event_id, &target_id, "caption");
                        if let Err(e) =
                            media::send_text_bounded(&room_handle, &caption, &caption_txn).await
                        {
                            warn!(error = %e, to = %target_id, "Failed to send media caption");
                        }
                    }
                }
                Err(e) => {
                    all_delivered = false;
                    let failures = self
                        .health
                        .record_failure(target_id.as_str(), &e.to_string());
                    log_leg_failure(&source_id, &target_id, &e.to_string(), failures);
                }
            }
        }

        if all_delivered {
            self.ledger_set_complete(history_dir, source_event_id.as_str())
                .await;
        }
        Ok(all_delivered)
    }

    async fn with_ledger<R>(
        &self,
        history_dir: &Path,
        f: impl FnOnce(&mut DeliveryLedger) -> R + Send,
    ) -> R {
        f(self
            .ledger
            .lock()
            .await
            .get_or_insert_with(|| DeliveryLedger::load(state::delivery_ledger_path(history_dir))))
    }

    async fn ledger_record_attempt(&self, history_dir: &Path, event_id: &str, room: &str, ts: u64) {
        self.with_ledger(history_dir, |ledger| {
            ledger.record_attempt(event_id, room, ts);
        })
        .await;
    }

    async fn ledger_record_delivery(&self, history_dir: &Path, event_id: &str, target: &str) {
        self.with_ledger(history_dir, |ledger| {
            ledger.record_delivery(event_id, target);
        })
        .await;
    }

    async fn ledger_set_complete(&self, history_dir: &Path, event_id: &str) {
        self.with_ledger(history_dir, |ledger| ledger.set_complete(event_id))
            .await;
    }

    async fn ledger_delivered(&self, history_dir: &Path, event_id: &str) -> BTreeSet<String> {
        self.with_ledger(history_dir, |ledger| {
            ledger
                .get(event_id)
                .map(|record| record.delivered.clone())
                .unwrap_or_default()
        })
        .await
    }

    async fn ledger_snapshot(
        &self,
        history_dir: &Path,
        event_id: &str,
    ) -> Option<ledger::DeliveryRecord> {
        self.with_ledger(history_dir, |ledger| ledger.get(event_id).cloned())
            .await
    }

    async fn record_relay(
        &self,
        source_room: OwnedRoomId,
        source_event: OwnedEventId,
        target_room: OwnedRoomId,
        target_event: OwnedEventId,
    ) {
        let mut guard = self.reply_map.write().await;
        if guard.len() >= REPLY_MAP_CAP {
            warn!(cap = REPLY_MAP_CAP, "Reply map cap hit; clearing");
            guard.clear();
        }
        guard
            .entry((source_room, source_event))
            .or_default()
            .insert(target_room, target_event);
    }

    async fn run_startup_backfill(
        &self,
        client: &Client,
        spec: &PluginSpec,
        history_dir: &Path,
    ) -> Result<()> {
        let Some(plan) = self.ensure_plan(client, spec).await? else {
            info!("Relay startup backfill skipped: no plan loaded");
            return Ok(());
        };

        let mut sources: Vec<OwnedRoomId> = plan.map.keys().cloned().collect();
        sources.sort_by(|a, b| a.as_str().cmp(b.as_str()));

        info!(rooms = sources.len(), "Relay startup backfill start");
        for source_id in sources {
            let limit = plan
                .opts
                .get(&source_id)
                .map_or(DEFAULT_BACKFILL_LIMIT, |opts| opts.backfill_limit);
            if limit == 0 {
                info!(room = %source_id, "Relay backfill skipped by config");
                continue;
            }
            let Some(room) = client.get_room(&source_id) else {
                warn!(room = %source_id, "Relay backfill: no source room handle");
                continue;
            };
            if let Err(e) = self
                .backfill_room(client, &plan, &room, limit, history_dir)
                .await
            {
                warn!(room = %source_id, error = %e, "Relay backfill failed for room");
            }
        }
        info!("Relay startup backfill complete");

        Ok(())
    }

    async fn backfill_room(
        &self,
        client: &Client,
        plan: &RelayPlan,
        room: &Room,
        limit: usize,
        history_dir: &Path,
    ) -> Result<()> {
        let source_id = room.room_id().to_owned();
        let marker = self.last_seen_for(history_dir, &source_id).await;

        let response = bound::bounded_retry(
            "relay.backfill_messages",
            BACKFILL_FETCH_TIMEOUT,
            2,
            media::RETRY_BASE_DELAY,
            || {
                let mut options = MessagesOptions::backward();
                options.limit = u32::try_from(limit).unwrap_or(u32::MAX).into();
                room.messages(options)
            },
        )
        .await
        .with_context(|| format!("fetching recent messages for {source_id}"))?;

        let bot_user_id = client.user_id().map(std::borrow::ToOwned::to_owned);
        let mut events = Vec::new();
        for timeline_event in response.chunk {
            let Some(event) = room_message_from_raw(&timeline_event.into_raw()) else {
                continue;
            };
            if bot_user_id.as_ref().is_some_and(|bot| &event.sender == bot) {
                continue;
            }
            let ts: u64 = event.origin_server_ts.get().into();
            // Ledger-aware selection: fully-delivered events are never
            // resent (even when newer than the mark), incomplete ones are
            // retried (even when older than the mark), unknown ones follow
            // the mark.
            let record = self
                .ledger_snapshot(history_dir, event.event_id.as_str())
                .await;
            if !ledger::should_backfill(ts, marker, record.as_ref()) {
                continue;
            }
            events.push(event);
        }

        events.reverse();
        let mut relayed_count = 0usize;
        for event in events {
            if self
                .relay_event(client, plan, room, &event, history_dir)
                .await?
            {
                relayed_count += 1;
                self.mark_last_seen(history_dir, &source_id, event.origin_server_ts.get().into())
                    .await;
            }
        }

        info!(
            room = %source_id,
            relayed = relayed_count,
            limit,
            marker,
            "Relay backfill room complete"
        );

        Ok(())
    }

    async fn with_last_seen<R>(
        &self,
        history_dir: &Path,
        f: impl FnOnce(&mut LastSeen) -> R + Send,
    ) -> R {
        f(self
            .last_seen
            .lock()
            .await
            .get_or_insert_with(|| LastSeen::load(state::last_seen_path(history_dir))))
    }

    async fn last_seen_for(&self, history_dir: &Path, room_id: &OwnedRoomId) -> Option<u64> {
        self.with_last_seen(history_dir, |state| state.get(room_id.as_str()))
            .await
    }

    async fn mark_last_seen(&self, history_dir: &Path, room_id: &OwnedRoomId, ts: u64) {
        self.with_last_seen(history_dir, |state| state.advance(room_id.as_str(), ts))
            .await;
    }

    async fn ensure_plan(
        &self,
        client: &Client,
        spec: &PluginSpec,
    ) -> Result<Option<Arc<RelayPlan>>> {
        let value = self.plan.read().await.clone();
        if let Some(plan) = value {
            return Ok(Some(plan));
        }
        let mut guard = self.plan.write().await;
        if let Some(plan) = guard.clone() {
            return Ok(Some(plan));
        }

        let config_value = spec.config.clone();
        if config_value.is_null() {
            return Ok(None);
        }
        let cfg: RelayConfig =
            serde_yaml::from_value(config_value).context("parsing relay config")?;
        if cfg.clusters.is_empty() {
            return Ok(None);
        }
        let plan = plan::resolve_relay_map(client, &cfg).await?;
        let plan = Arc::new(plan);
        *guard = Some(Arc::clone(&plan));
        drop(guard);

        Ok(Some(plan))
    }
}

/// Per-leg failure logging that escalates: WARN for the first failures, a
/// single loud ERROR the moment a leg crosses the dead threshold.
fn log_leg_failure(source: &OwnedRoomId, target: &OwnedRoomId, err: &str, failures: u32) {
    if failures == DEAD_LEG_THRESHOLD {
        error!(
            from = %source,
            to = %target,
            error = %err,
            consecutive_failures = failures,
            "RELAY LEG DEAD: repeated delivery failures — messages to this room are being lost"
        );
    } else {
        warn!(
            from = %source,
            to = %target,
            error = %err,
            consecutive_failures = failures,
            "Failed to relay message"
        );
    }
}

/// If `content` is a reply (or a reply-within-thread), pull the in-reply-to
/// event id and resolve the original sender's display name. Returns `None`
/// for non-replies or when the original event can't be fetched / parsed.
async fn extract_reply_context(
    content: &RoomMessageEventContent,
    source_room: &Room,
) -> Option<ReplyContext> {
    let in_reply_to_event_id = match content.relates_to.as_ref()? {
        Relation::Reply { in_reply_to } => in_reply_to.event_id.clone(),
        Relation::Thread(t) => t.in_reply_to.as_ref().map(|r| r.event_id.clone())?,
        Relation::Replacement(_) | _ => return None,
    };

    // Need the original sender to format the header. Try the cache first,
    // then fall back to a homeserver fetch — with a deadline, since this can
    // hit the network. Any failure → graceful "someone" so we still ship a
    // header.
    let display = match bound::bounded(
        "relay.load_reply_target",
        LOOKUP_TIMEOUT,
        source_room.load_or_fetch_event(&in_reply_to_event_id, None),
    )
    .await
    {
        Ok(timeline_event) => match timeline_event.raw().deserialize() {
            Ok(ev) => {
                let sender: AnySyncTimelineEvent = ev;
                resolve_display_name(source_room, &sender.sender().to_owned()).await
            }
            Err(_) => "someone".to_owned(),
        },
        Err(_) => "someone".to_owned(),
    };

    Some(ReplyContext {
        source_event_id: in_reply_to_event_id,
        original_sender_display: display,
    })
}

async fn resolve_display_name(room: &Room, sender: &matrix_sdk::ruma::OwnedUserId) -> String {
    // `get_member` can hit the homeserver on a cache miss; a slow lookup
    // must degrade to the localpart, never stall the relay.
    match bound::bounded("relay.get_member", LOOKUP_TIMEOUT, room.get_member(sender)).await {
        Ok(Some(member)) => member.display_name().map_or_else(
            || sender.localpart().to_owned(),
            std::borrow::ToOwned::to_owned,
        ),
        Ok(None) | Err(_) => sender.localpart().to_owned(),
    }
}

fn room_message_from_raw(
    raw_event: &Raw<AnySyncTimelineEvent>,
) -> Option<OriginalSyncRoomMessageEvent> {
    let event = raw_event.deserialize().ok()?;
    let AnySyncTimelineEvent::MessageLike(message_like) = event else {
        return None;
    };
    let AnySyncMessageLikeEvent::RoomMessage(msg) = message_like else {
        return None;
    };
    let SyncRoomMessageEvent::Original(event) = msg else {
        return None;
    };
    Some(event)
}
