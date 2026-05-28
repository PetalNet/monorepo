mod relay_config;

pub use relay_config::{RelayCluster, RelayConfig};

use core::fmt::Write as _;
use std::{borrow::ToOwned, collections::HashMap, sync::Arc};

use anyhow::{Context as _, Result, anyhow};
use async_trait::async_trait;
use matrix_sdk::{
    Client,
    attachment::AttachmentConfig,
    room::Room,
    ruma::{
        OwnedRoomId, RoomAliasId, RoomId,
        events::room::message::{
            AudioMessageEventContent, FileMessageEventContent, ImageMessageEventContent,
            MessageType, OriginalSyncRoomMessageEvent, RoomMessageEventContent,
            VideoMessageEventContent,
        },
    },
};
use mime::Mime;
use plugin_core::{Plugin, PluginContext, PluginSpec, PluginTriggers, RoomMessageMeta, truncate};
use tokio::sync::RwLock;
use tracing::{info, warn};

#[derive(Debug)]
pub struct RelayPlugin;

#[derive(Default, Debug)]
pub struct Relay {
    plan: RwLock<Option<Arc<RelayPlan>>>,
}

#[derive(Debug, Clone, Copy)]
struct RelayOptions {
    reupload_media: bool,
    caption_media: bool,
}

#[derive(Debug, Clone)]
struct RelayPlan {
    map: HashMap<OwnedRoomId, Vec<OwnedRoomId>>,
    opts: HashMap<OwnedRoomId, RelayOptions>,
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

    async fn run(&self, _ctx: &PluginContext, _args: &str, _spec: &PluginSpec) -> Result<()> {
        Ok(())
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

    async fn on_room_message(
        &self,
        ctx: &PluginContext,
        event: &OriginalSyncRoomMessageEvent,
        spec: &PluginSpec,
        _meta: &RoomMessageMeta,
    ) -> Result<()> {
        info!(room_id = %ctx.room.room_id(), sender = %event.sender, "Relay: on_room_message called");

        if ctx.dev_active {
            info!(room_id = %ctx.room.room_id(), "Dev mode active: relay disabled");
            return Ok(());
        }

        let Some(plan) = self.ensure_plan(&ctx.client, spec).await? else {
            info!(room_id = %ctx.room.room_id(), "Relay: no plan loaded (config empty?)");
            return Ok(());
        };

        let source_id = ctx.room.room_id().to_owned();
        let Some(targets) = plan.map.get(&source_id).cloned() else {
            info!(room_id = %source_id, "Relay: room not in mapping");
            return Ok(());
        };
        let opts = plan.opts.get(&source_id).copied().unwrap_or(RelayOptions {
            reupload_media: true,
            caption_media: true,
        });

        let display_name = resolve_display_name(&ctx.room, &event.sender).await;
        let display_name_bold = to_bold(&display_name);
        let formatted_text = format_text_message(&event.content.msgtype, &display_name_bold);

        for target_id in targets {
            if target_id == source_id {
                continue;
            }
            if let Some(room_handle) = ctx.client.get_room(&target_id) {
                let send_res = if let Some(text) = formatted_text.as_ref() {
                    let content = RoomMessageEventContent::text_plain(text.clone());
                    room_handle.send(content).await
                } else {
                    forward_media(&ctx.client, &room_handle, event, opts.reupload_media).await
                };

                match send_res {
                    Ok(_) => {
                        info!(from = %source_id, to = %target_id, sender = %event.sender, "Relayed message");
                        if formatted_text.is_none()
                            && opts.caption_media
                            && let Some(kind) = media_kind(&event.content.msgtype)
                        {
                            let caption = format!("{display_name_bold}: sent a {kind}");
                            let _ = room_handle
                                .send(RoomMessageEventContent::text_plain(caption))
                                .await;
                        }
                    }
                    Err(e) => warn!(
                        error = %e,
                        from = %source_id,
                        to = %target_id,
                        "Failed to relay message"
                    ),
                }
            } else {
                warn!(from = %source_id, to = %target_id, "No handle for target room; skipping relay");
            }
        }

        Ok(())
    }
}

impl Relay {
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
        let plan = resolve_relay_map(client, &cfg).await?;
        let plan = Arc::new(plan);
        *guard = Some(Arc::clone(&plan));
        drop(guard);

        Ok(Some(plan))
    }
}

async fn resolve_relay_map(client: &Client, cfg: &RelayConfig) -> Result<RelayPlan> {
    let mut map: HashMap<OwnedRoomId, Vec<OwnedRoomId>> = HashMap::new();
    let mut opts: HashMap<OwnedRoomId, RelayOptions> = HashMap::new();

    for cluster in &cfg.clusters {
        let mut resolved: Vec<OwnedRoomId> = Vec::new();
        for room_ref in &cluster.rooms {
            if let Ok(id) = RoomId::parse(room_ref) {
                resolved.push(id.clone());
                continue;
            }
            if room_ref.starts_with('#') {
                if let Ok(alias) = RoomAliasId::parse(room_ref) {
                    match client.resolve_room_alias(&alias).await {
                        Ok(resp) => {
                            resolved.push(resp.room_id.clone());
                        }
                        Err(e) => {
                            warn!(alias = %room_ref, error = %e, "Failed to resolve room alias; skipping");
                        }
                    }
                } else {
                    warn!(alias = %room_ref, "Invalid room alias; skipping");
                }
            } else {
                warn!(room = %room_ref, "Invalid room reference (expect !room_id or #alias); skipping");
            }
        }

        let reupload = cluster
            .reupload_media
            .or(cfg.reupload_media)
            .unwrap_or(true);
        let caption = cluster.caption_media.or(cfg.caption_media).unwrap_or(true);

        for r in &resolved {
            let peers: Vec<OwnedRoomId> = resolved.iter().filter(|x| *x != r).cloned().collect();
            map.entry(r.clone())
                .and_modify(|existing| {
                    for p in &peers {
                        if !existing.contains(p) {
                            existing.push(p.clone());
                        }
                    }
                })
                .or_insert(peers);
            opts.insert(
                r.clone(),
                RelayOptions {
                    reupload_media: reupload,
                    caption_media: caption,
                },
            );
        }
    }

    info!(
        clusters = cfg.clusters.len(),
        rooms = map.len(),
        "Loaded relay mapping"
    );
    for (from, peers) in &map {
        let peer_list = peers
            .iter()
            .map(|p| p.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        info!(from = %from, peers = %peer_list, "Relay mapping entry");
    }

    Ok(RelayPlan { map, opts })
}

async fn resolve_display_name(room: &Room, sender: &matrix_sdk::ruma::OwnedUserId) -> String {
    match room.get_member(sender).await {
        Ok(Some(member)) => member
            .display_name()
            .map_or_else(|| sender.localpart().to_owned(), ToOwned::to_owned),
        _ => sender.localpart().to_owned(),
    }
}

fn format_text_message(msg: &MessageType, display_name_bold: &str) -> Option<String> {
    match msg {
        MessageType::Text(t) => {
            let (quoted, main) = split_reply_fallback(&t.body);
            Some(format_output(quoted, display_name_bold, main.trim(), ""))
        }
        MessageType::Notice(n) => {
            let (quoted, main) = split_reply_fallback(&n.body);
            Some(format_output(quoted, display_name_bold, main.trim(), ""))
        }
        MessageType::Emote(e) => {
            let (quoted, main) = split_reply_fallback(&e.body);
            Some(format_output(quoted, display_name_bold, main.trim(), "* "))
        }
        MessageType::Audio(_)
        | MessageType::File(_)
        | MessageType::Image(_)
        | MessageType::Location(_)
        | MessageType::ServerNotice(_)
        | MessageType::Video(_)
        | MessageType::VerificationRequest(_)
        | _ => None,
    }
}

fn format_output(
    quoted: Option<String>,
    display_name_bold: &str,
    main: &str,
    prefix: &str,
) -> String {
    let mut out = String::new();
    if let Some(q) = quoted {
        let snippet = truncate(q.as_str(), 300);
        _ = writeln!(&mut out, "↪ {snippet}");
    }
    out.push_str(display_name_bold);
    out.push_str(": ");
    out.push_str(prefix);
    out.push_str(main);
    out
}

async fn forward_media(
    client: &Client,
    room: &Room,
    event: &OriginalSyncRoomMessageEvent,
    reupload: bool,
) -> matrix_sdk::Result<matrix_sdk::ruma::api::client::message::send_message_event::v3::Response> {
    let msg = &event.content.msgtype;
    match msg {
        MessageType::Image(img) => {
            if reupload {
                match reupload_image(client, img).await {
                    Ok((body, mime, data)) => send_attachment(room, &body, &mime, data).await,
                    Err(e) => {
                        warn!(error = %e, "Image reupload failed; forwarding original event");
                        room.send(event.content.clone()).await
                    }
                }
            } else {
                room.send(event.content.clone()).await
            }
        }
        MessageType::File(file) => {
            if reupload {
                match reupload_file(client, file).await {
                    Ok((body, mime, data)) => send_attachment(room, &body, &mime, data).await,
                    Err(e) => {
                        warn!(error = %e, "File reupload failed; forwarding original event");
                        room.send(event.content.clone()).await
                    }
                }
            } else {
                room.send(event.content.clone()).await
            }
        }
        MessageType::Audio(audio) => {
            if reupload {
                match reupload_audio(client, audio).await {
                    Ok((body, mime, data)) => send_attachment(room, &body, &mime, data).await,
                    Err(e) => {
                        warn!(error = %e, "Audio reupload failed; forwarding original event");
                        room.send(event.content.clone()).await
                    }
                }
            } else {
                room.send(event.content.clone()).await
            }
        }
        MessageType::Video(video) => {
            if reupload {
                match reupload_video(client, video).await {
                    Ok((body, mime, data)) => send_attachment(room, &body, &mime, data).await,
                    Err(e) => {
                        warn!(error = %e, "Video reupload failed; forwarding original event");
                        room.send(event.content.clone()).await
                    }
                }
            } else {
                room.send(event.content.clone()).await
            }
        }
        MessageType::Emote(_)
        | MessageType::Location(_)
        | MessageType::Notice(_)
        | MessageType::ServerNotice(_)
        | MessageType::Text(_)
        | MessageType::VerificationRequest(_)
        | _ => room.send(event.content.clone()).await,
    }
}

const fn media_kind(msg: &MessageType) -> Option<&'static str> {
    match msg {
        MessageType::Image(_) => Some("image"),
        MessageType::File(_) => Some("file"),
        MessageType::Audio(_) => Some("audio"),
        MessageType::Video(_) => Some("video"),
        MessageType::Emote(_)
        | MessageType::Location(_)
        | MessageType::Notice(_)
        | MessageType::ServerNotice(_)
        | MessageType::Text(_)
        | MessageType::VerificationRequest(_)
        | _ => None,
    }
}

async fn reupload_image(
    client: &Client,
    img: &ImageMessageEventContent,
) -> Result<(String, Mime, Vec<u8>)> {
    let body = img.body.clone();
    let mime = parse_mime(img.info.as_ref().and_then(|i| i.mimetype.as_deref()));
    let data_opt = client
        .media()
        .get_file(&img.clone(), true)
        .await
        .context("downloading image")?;
    let data = data_opt.ok_or_else(|| anyhow!("image bytes missing"))?;
    Ok((body, mime, data))
}

async fn reupload_file(
    client: &Client,
    file: &FileMessageEventContent,
) -> Result<(String, Mime, Vec<u8>)> {
    let body = file.body.clone();
    let mime = parse_mime(file.info.as_ref().and_then(|i| i.mimetype.as_deref()));
    let data_opt = client
        .media()
        .get_file(&file.clone(), true)
        .await
        .context("downloading file")?;
    let data = data_opt.ok_or_else(|| anyhow!("file bytes missing"))?;
    Ok((body, mime, data))
}

async fn reupload_audio(
    client: &Client,
    audio: &AudioMessageEventContent,
) -> Result<(String, Mime, Vec<u8>)> {
    let body = audio.body.clone();
    let mime = parse_mime(audio.info.as_ref().and_then(|i| i.mimetype.as_deref()));
    let data_opt = client
        .media()
        .get_file(&audio.clone(), true)
        .await
        .context("downloading audio")?;
    let data = data_opt.ok_or_else(|| anyhow!("audio bytes missing"))?;
    Ok((body, mime, data))
}

async fn reupload_video(
    client: &Client,
    video: &VideoMessageEventContent,
) -> Result<(String, Mime, Vec<u8>)> {
    let body = video.body.clone();
    let mime = parse_mime(video.info.as_ref().and_then(|i| i.mimetype.as_deref()));
    let data_opt = client
        .media()
        .get_file(&video.clone(), true)
        .await
        .context("downloading video")?;
    let data = data_opt.ok_or_else(|| anyhow!("video bytes missing"))?;
    Ok((body, mime, data))
}

async fn send_attachment(
    room: &Room,
    body: &str,
    mime: &Mime,
    data: Vec<u8>,
) -> matrix_sdk::Result<matrix_sdk::ruma::api::client::message::send_message_event::v3::Response> {
    let config = AttachmentConfig::new();
    room.send_attachment(body, &mime.clone(), data, config)
        .await
}

fn parse_mime(opt: Option<&str>) -> Mime {
    opt.and_then(|s| s.parse::<Mime>().ok())
        .unwrap_or(mime::APPLICATION_OCTET_STREAM)
}

fn to_bold(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' => char::from_u32('𝐀' as u32 + (c as u32 - 'A' as u32)).unwrap_or(c),
            'a'..='z' => char::from_u32('𝐚' as u32 + (c as u32 - 'a' as u32)).unwrap_or(c),
            '0'..='9' => char::from_u32('𝟎' as u32 + (c as u32 - '0' as u32)).unwrap_or(c),
            _ => c,
        })
        .collect()
}

fn split_reply_fallback(body: &str) -> (Option<String>, String) {
    if let Some(sep_idx) = body.find("\n\n") {
        let (quoted_block, rest) = body.split_at(sep_idx);
        let main = rest
            .trim_start_matches('\n')
            .trim_start_matches('\n')
            .to_owned();
        let mut quoted_lines = Vec::new();
        for line in quoted_block.lines() {
            if let Some(stripped) = line.strip_prefix("> ") {
                quoted_lines.push(stripped.to_owned());
            } else if line.starts_with('>') {
                let s = line.trim_start_matches('>').trim_start();
                quoted_lines.push(s.to_owned());
            }
        }
        if !quoted_lines.is_empty() {
            let quoted = quoted_lines.join(" ");
            return (Some(quoted.trim().to_owned()), main);
        }
    }
    (None, body.to_owned())
}
