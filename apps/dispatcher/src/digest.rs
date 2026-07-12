//! The compact inbox digest — how deferred cards reach an agent without
//! interrupting it (CONTRACTS §4).
//!
//! Truncation is not paraphrase: each line carries the card_id so the agent
//! can pull the full VERBATIM body; the digest never rewrites content (DP11,
//! fleet-dispatcher-review "forward verbatim").

use crate::board::BoardCard;

pub const DEFAULT_MAX_ITEMS: usize = 12;
pub const BODY_SNIPPET_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DigestItem {
    pub card_id: String,
    pub task_id: i64,
    pub sender: String,
    pub priority: u8,
    pub thread: Option<String>,
    pub requires_reply: bool,
    /// First BODY_SNIPPET_CHARS chars of the verbatim body; `truncated`
    /// says whether more exists on the card.
    pub snippet: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Digest {
    pub recipient: String,
    pub total_deferred: usize,
    /// Items included (≤ max_items), ordered by priority then age.
    pub items: Vec<DigestItem>,
    /// Card ids listed in `items` — the caller marks exactly these delivered.
    pub included_card_ids: Vec<String>,
}

pub fn build(recipient: &str, deferred: &[BoardCard], max_items: usize) -> Digest {
    let mut items = Vec::new();
    for card in deferred.iter().take(max_items) {
        let mut snippet: String = card.body.chars().take(BODY_SNIPPET_CHARS).collect();
        let truncated = snippet.len() < card.body.len();
        if truncated {
            snippet.push('…');
        }
        items.push(DigestItem {
            card_id: card.card_id.clone(),
            task_id: card.task_id,
            sender: card.sender.clone(),
            priority: card.priority,
            thread: card.thread.clone(),
            requires_reply: card.requires_reply,
            snippet,
            truncated,
        });
    }
    Digest {
        recipient: recipient.to_string(),
        total_deferred: deferred.len(),
        included_card_ids: items.iter().map(|i| i.card_id.clone()).collect(),
        items,
    }
}

/// One human/agent-readable block. Kept boring and stable: agents parse it.
pub fn render_text(d: &Digest) -> String {
    let mut out = format!(
        "INBOX DIGEST for {} — {} deferred item(s){}\n",
        d.recipient,
        d.total_deferred,
        if d.total_deferred > d.items.len() {
            format!(" (showing {})", d.items.len())
        } else {
            String::new()
        }
    );
    for item in &d.items {
        out.push_str(&format!(
            "- [P{}] task {} from {}{}{} (card {}): {}\n",
            item.priority,
            item.task_id,
            item.sender,
            if item.requires_reply {
                " REPLY-WANTED"
            } else {
                ""
            },
            item.thread
                .as_deref()
                .map(|t| format!(" thread {t}"))
                .unwrap_or_default(),
            item.card_id,
            item.snippet
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card::{InterruptPolicy, SenderClass};

    fn card(id: &str, priority: u8, body: &str) -> BoardCard {
        BoardCard {
            card_id: id.into(),
            task_id: 1,
            sender: "@parker:petalnet.example".into(),
            sender_class: SenderClass::Principal,
            recipient: Some("janet".into()),
            priority,
            thread: None,
            requires_reply: false,
            interrupt_policy: InterruptPolicy::Defer,
            body: body.into(),
            needs: Default::default(),
            state: "posted".into(),
            claimed_by: None,
            lease_expires_at_ms: None,
            fence: 0,
            reaps: 0,
            reply_to: None,
            parent_id: None,
            result: None,
            created_at_ms: 0,
        }
    }

    #[test]
    fn digest_caps_items_but_reports_total() {
        let cards: Vec<BoardCard> = (0..20)
            .map(|i| card(&format!("c{i}"), 2, "hello"))
            .collect();
        let d = build("janet", &cards, 5);
        assert_eq!(d.items.len(), 5);
        assert_eq!(d.total_deferred, 20);
        assert_eq!(d.included_card_ids.len(), 5);
        assert!(render_text(&d).contains("showing 5"));
    }

    #[test]
    fn long_bodies_truncate_with_marker_never_paraphrase() {
        let long = "x".repeat(500);
        let d = build("janet", &[card("c1", 0, &long)], 10);
        let item = &d.items[0];
        assert!(item.truncated);
        assert!(item.snippet.ends_with('…'));
        assert!(item.snippet.chars().count() == BODY_SNIPPET_CHARS + 1);
        // The snippet is a strict prefix of the verbatim body — no rewriting.
        assert!(long.starts_with(item.snippet.trim_end_matches('…')));
    }

    #[test]
    fn multibyte_bodies_do_not_panic_or_split() {
        let body = "héllo wörld 🌍".repeat(40);
        let d = build("janet", &[card("c1", 1, &body)], 10);
        assert!(d.items[0].snippet.chars().count() <= BODY_SNIPPET_CHARS + 1);
    }
}
