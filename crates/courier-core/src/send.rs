//! Bounded room sends for plugins.
//!
//! Even a plain reply goes through [`crate::bound::bounded`]: a send on a
//! half-dead connection must cost bounded time, never park a plugin task
//! forever (the supervisor budget would eventually kill it, but a deadline
//! here fails fast and loudly instead).

use core::time::Duration;

use anyhow::Result;
use matrix_sdk::ruma::events::room::message::{
    AddMentions, ForwardThread, RoomMessageEventContent,
};

use crate::bound;
use crate::plugin::PluginContext;

/// Deadline for one plugin message send.
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

#[must_use]
fn decorate_dev(text: &str, dev_active: bool) -> String {
    if dev_active {
        format!("=======DEV MODE=======\n{text}")
    } else {
        text.to_owned()
    }
}

/// Send a plain-text message to the current room.
///
/// If `ctx.trigger_event` is set (the common case — a plugin responding to a
/// command or mention), the message is threaded as a Matrix reply to that
/// event. This keeps multi-person group rooms readable when the bot and the
/// humans are talking concurrently. To opt out and send a flat top-level
/// message, use [`send_text_flat`].
///
/// The message text is decorated with a development-mode banner when
/// `ctx.dev_active` is true.
///
/// # Errors
///
/// Returns an error if the send fails or exceeds its deadline.
pub async fn send_text(ctx: &PluginContext, text: impl Into<String> + Send) -> Result<()> {
    let text = text.into();
    let decorated = decorate_dev(&text, ctx.dev_active);
    let content = if let Some(trigger) = ctx.trigger_event.as_ref() {
        // Build a proper Matrix reply against the triggering event.
        let full = trigger
            .as_ref()
            .clone()
            .into_full_event(ctx.room.room_id().to_owned());
        RoomMessageEventContent::text_plain(decorated).make_reply_to(
            &full,
            ForwardThread::Yes,
            AddMentions::Yes,
        )
    } else {
        RoomMessageEventContent::text_plain(decorated)
    };
    bound::bounded("plugin.send_text", SEND_TIMEOUT, ctx.room.send(content)).await?;
    Ok(())
}

/// Send a flat top-level message, ignoring any `trigger_event` thread. Use
/// for proactive announcements that aren't replies to anyone (e.g. periodic
/// status posts, scheduled jobs).
///
/// # Errors
///
/// Returns an error if the send fails or exceeds its deadline.
pub async fn send_text_flat(ctx: &PluginContext, text: impl Into<String> + Send) -> Result<()> {
    let text = text.into();
    let content = RoomMessageEventContent::text_plain(decorate_dev(&text, ctx.dev_active));
    bound::bounded(
        "plugin.send_text_flat",
        SEND_TIMEOUT,
        ctx.room.send(content),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_banner_is_prepended_only_in_dev() {
        assert_eq!(decorate_dev("hi", false), "hi");
        assert_eq!(decorate_dev("hi", true), "=======DEV MODE=======\nhi");
    }
}
