//! Pure text formatting for relayed messages.

use matrix_sdk::ruma::{OwnedEventId, events::room::message::MessageType};

use courier_core::text::to_bold;

/// Context about the original message when the inbound is a reply.
#[derive(Debug, Clone)]
pub struct ReplyContext {
    /// `event_id` of the original event being replied to (in the source
    /// room).
    pub source_event_id: OwnedEventId,
    /// Display name of the original sender, used for the
    /// "Parker replied to <X>: ..." header.
    pub original_sender_display: String,
}

/// Format a text-like message for relaying, or `None` for media/other types.
pub fn format_text_message(
    msg: &MessageType,
    display_name_bold: &str,
    reply: Option<&ReplyContext>,
) -> Option<String> {
    match msg {
        MessageType::Text(t) => {
            let (_quoted, main) = split_reply_fallback(&t.body);
            Some(format_output(reply, display_name_bold, main.trim(), ""))
        }
        MessageType::Notice(n) => {
            let (_quoted, main) = split_reply_fallback(&n.body);
            Some(format_output(reply, display_name_bold, main.trim(), ""))
        }
        MessageType::Emote(e) => {
            let (_quoted, main) = split_reply_fallback(&e.body);
            Some(format_output(reply, display_name_bold, main.trim(), "* "))
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

pub fn format_output(
    reply: Option<&ReplyContext>,
    display_name_bold: &str,
    main: &str,
    prefix: &str,
) -> String {
    let mut out = String::new();
    if let Some(r) = reply {
        // "<Parker> replied to <Friend>: <body>" — proper attribution. When
        // the receiving client supports m.relates_to, this body is also hung
        // under a native reply pointer; when it doesn't, the text alone is
        // enough to know who the reply targeted.
        let other_bold = to_bold(&r.original_sender_display);
        out.push_str(display_name_bold);
        out.push_str(" replied to ");
        out.push_str(&other_bold);
    } else {
        out.push_str(display_name_bold);
    }
    out.push_str(": ");
    out.push_str(prefix);
    out.push_str(main);
    out
}

/// The human caption used after relayed media, or `None` for non-media.
pub const fn media_kind(msg: &MessageType) -> Option<&'static str> {
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

/// Split a legacy `> quoted` reply-fallback prefix off a message body.
pub fn split_reply_fallback(body: &str) -> (Option<String>, String) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_header_formatting() {
        let plain = format_output(None, "𝐏𝐚𝐫𝐤𝐞𝐫", "hi", "");
        assert_eq!(plain, "𝐏𝐚𝐫𝐤𝐞𝐫: hi");

        let reply = ReplyContext {
            source_event_id: "$abc:hs".try_into().expect("valid event id"),
            original_sender_display: "Eli".to_owned(),
        };
        let with_reply = format_output(Some(&reply), "𝐏𝐚𝐫𝐤𝐞𝐫", "yes", "");
        assert!(with_reply.contains("replied to"), "got: {with_reply}");
        assert!(with_reply.ends_with(": yes"), "got: {with_reply}");
    }

    #[test]
    fn split_reply_fallback_strips_quotes() {
        let (quoted, main) = split_reply_fallback("> someone said this\n\nmy actual reply");
        assert_eq!(quoted.as_deref(), Some("someone said this"));
        assert_eq!(main, "my actual reply");

        let (none, body) = split_reply_fallback("plain message");
        assert!(none.is_none());
        assert_eq!(body, "plain message");
    }
}
