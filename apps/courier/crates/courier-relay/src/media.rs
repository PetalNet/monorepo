//! Bounded media pipeline: download, re-upload, and sends.
//!
//! matrix-sdk deliberately issues media downloads with NO timeout
//! (`timeout(Some(Duration::MAX))` in its `media.rs` — "we don't know the
//! network connectivity"). On a half-dead connection that call parks
//! forever; the previous generation deadlocked on exactly that. Every
//! network call here goes through [`courier_core::bound`].

use core::future::IntoFuture;
use core::time::Duration;

use anyhow::{Result, anyhow};
use matrix_sdk::{
    Client,
    attachment::AttachmentConfig,
    room::Room,
    ruma::{
        OwnedTransactionId,
        events::room::message::{
            AudioMessageEventContent, FileMessageEventContent, ImageMessageEventContent,
            MessageType, OriginalSyncRoomMessageEvent, RoomMessageEventContent,
            VideoMessageEventContent,
        },
    },
};
use mime::Mime;
use tracing::warn;

use courier_core::bound;

// Deadlines and retry budgets for every external call in the relay path.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(30);
pub const SEND_ATTEMPTS: u32 = 3;
pub const MEDIA_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(90);
pub const MEDIA_UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
pub const MEDIA_ATTEMPTS: u32 = 2;
pub const RETRY_BASE_DELAY: Duration = Duration::from_secs(1);

pub type SendResponse = matrix_sdk::ruma::api::client::message::send_message_event::v3::Response;

/// Send a message event with a deadline, bounded retries, and a STABLE
/// transaction id: every retry re-uses `txn_id`, so a retry of a send whose
/// first attempt landed (but whose response was lost) is deduped server-side
/// instead of appearing twice in the room.
pub async fn send_text_bounded(
    room: &Room,
    content: &RoomMessageEventContent,
    txn_id: &OwnedTransactionId,
) -> Result<SendResponse> {
    bound::bounded_retry(
        "relay.send",
        SEND_TIMEOUT,
        SEND_ATTEMPTS,
        RETRY_BASE_DELAY,
        || {
            room.send(content.clone())
                .with_transaction_id(txn_id.clone())
        },
    )
    .await
}

/// Relay a media event: re-upload when configured (falling back to
/// forwarding the original content on failure), else forward as-is.
pub async fn forward_media(
    client: &Client,
    room: &Room,
    event: &OriginalSyncRoomMessageEvent,
    reupload: bool,
    txn_id: &OwnedTransactionId,
) -> Result<SendResponse> {
    let msg = &event.content.msgtype;
    let downloaded = if reupload {
        match msg {
            MessageType::Image(img) => Some(reupload_image(client, img).await),
            MessageType::File(file) => Some(reupload_file(client, file).await),
            MessageType::Audio(audio) => Some(reupload_audio(client, audio).await),
            MessageType::Video(video) => Some(reupload_video(client, video).await),
            MessageType::Emote(_)
            | MessageType::Location(_)
            | MessageType::Notice(_)
            | MessageType::ServerNotice(_)
            | MessageType::Text(_)
            | MessageType::VerificationRequest(_)
            | _ => None,
        }
    } else {
        None
    };

    match downloaded {
        // NOTE: matrix-sdk's SendAttachment future exposes no transaction-id
        // hook, so re-uploaded media retries cannot be deduped server-side.
        // The delivery ledger still prevents cross-restart/backfill dupes;
        // the residual window is a single in-flight retry whose first
        // attempt landed but whose response was lost.
        Some(Ok((body, mime, data))) => send_attachment(room, &body, &mime, data).await,
        Some(Err(e)) => {
            warn!(error = %e, "Media reupload failed; forwarding original event");
            forward_original(room, event, txn_id).await
        }
        None => forward_original(room, event, txn_id).await,
    }
}

/// Forward the original event content unchanged (no media re-upload), with a
/// stable transaction id across retries.
async fn forward_original(
    room: &Room,
    event: &OriginalSyncRoomMessageEvent,
    txn_id: &OwnedTransactionId,
) -> Result<SendResponse> {
    bound::bounded_retry(
        "relay.forward_original",
        SEND_TIMEOUT,
        SEND_ATTEMPTS,
        RETRY_BASE_DELAY,
        || {
            room.send(event.content.clone())
                .with_transaction_id(txn_id.clone())
        },
    )
    .await
}

async fn reupload_image(
    client: &Client,
    img: &ImageMessageEventContent,
) -> Result<(String, Mime, Vec<u8>)> {
    let body = img.body.clone();
    let mime = parse_mime(img.info.as_ref().and_then(|i| i.mimetype.as_deref()));
    let data = download_media("relay.download_image", || {
        let media = client.media();
        let content = img.clone();
        async move { media.get_file(&content, true).await }
    })
    .await?;
    Ok((body, mime, data))
}

async fn reupload_file(
    client: &Client,
    file: &FileMessageEventContent,
) -> Result<(String, Mime, Vec<u8>)> {
    let body = file.body.clone();
    let mime = parse_mime(file.info.as_ref().and_then(|i| i.mimetype.as_deref()));
    let data = download_media("relay.download_file", || {
        let media = client.media();
        let content = file.clone();
        async move { media.get_file(&content, true).await }
    })
    .await?;
    Ok((body, mime, data))
}

async fn reupload_audio(
    client: &Client,
    audio: &AudioMessageEventContent,
) -> Result<(String, Mime, Vec<u8>)> {
    let body = audio.body.clone();
    let mime = parse_mime(audio.info.as_ref().and_then(|i| i.mimetype.as_deref()));
    let data = download_media("relay.download_audio", || {
        let media = client.media();
        let content = audio.clone();
        async move { media.get_file(&content, true).await }
    })
    .await?;
    Ok((body, mime, data))
}

async fn reupload_video(
    client: &Client,
    video: &VideoMessageEventContent,
) -> Result<(String, Mime, Vec<u8>)> {
    let body = video.body.clone();
    let mime = parse_mime(video.info.as_ref().and_then(|i| i.mimetype.as_deref()));
    let data = download_media("relay.download_video", || {
        let media = client.media();
        let content = video.clone();
        async move { media.get_file(&content, true).await }
    })
    .await?;
    Ok((body, mime, data))
}

/// Download media with a hard deadline and retries. This wrapper is what
/// makes the SDK's unbounded media download finite.
async fn download_media<M, F>(op: &str, make_fut: M) -> Result<Vec<u8>>
where
    M: FnMut() -> F,
    F: IntoFuture<Output = matrix_sdk::Result<Option<Vec<u8>>>>,
{
    let data_opt = bound::bounded_retry(
        op,
        MEDIA_DOWNLOAD_TIMEOUT,
        MEDIA_ATTEMPTS,
        RETRY_BASE_DELAY,
        make_fut,
    )
    .await?;
    data_opt.ok_or_else(|| anyhow!("{op}: media bytes missing"))
}

async fn send_attachment(
    room: &Room,
    body: &str,
    mime: &Mime,
    data: Vec<u8>,
) -> Result<SendResponse> {
    bound::bounded_retry(
        "relay.send_attachment",
        MEDIA_UPLOAD_TIMEOUT,
        MEDIA_ATTEMPTS,
        RETRY_BASE_DELAY,
        || {
            let room = room.clone();
            let body = body.to_owned();
            let mime = mime.clone();
            let data = data.clone();
            async move {
                room.send_attachment(&body, &mime, data, AttachmentConfig::new())
                    .await
            }
        },
    )
    .await
}

fn parse_mime(opt: Option<&str>) -> Mime {
    opt.and_then(|s| s.parse::<Mime>().ok())
        .unwrap_or(mime::APPLICATION_OCTET_STREAM)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mime_falls_back_to_octet_stream() {
        assert_eq!(parse_mime(Some("image/png")), "image/png");
        assert_eq!(
            parse_mime(Some("not a mime")),
            mime::APPLICATION_OCTET_STREAM
        );
        assert_eq!(parse_mime(None), mime::APPLICATION_OCTET_STREAM);
    }
}
