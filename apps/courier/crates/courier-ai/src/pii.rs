//! Regex-based PII redaction for prompts sent to remote AI providers.
//!
//! Redacted spans are replaced with stable `<PII:KIND:N>` placeholders and
//! restored in the model's output (and in tool-call arguments), so the
//! remote provider never sees the original values.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

static EMAIL_REGEX: OnceLock<Regex> = OnceLock::new();
static IPV4_REGEX: OnceLock<Regex> = OnceLock::new();
static PHONE_REGEX: OnceLock<Regex> = OnceLock::new();
static PLACEHOLDER_REGEX: OnceLock<Regex> = OnceLock::new();

fn get_email_regex() -> &'static Regex {
    EMAIL_REGEX.get_or_init(|| Regex::new(r"(?i)[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}").unwrap())
}

fn get_ipv4_regex() -> &'static Regex {
    IPV4_REGEX.get_or_init(|| Regex::new(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b").unwrap())
}

fn get_phone_regex() -> &'static Regex {
    // Very basic US-centric phone regex for demonstration
    PHONE_REGEX.get_or_init(|| Regex::new(r"\b\d{3}[-.]?\d{3}[-.]?\d{4}\b").unwrap())
}

fn get_placeholder_regex() -> &'static Regex {
    PLACEHOLDER_REGEX.get_or_init(|| Regex::new(r"<PII:([A-Z]+):(\d+)>").unwrap())
}

/// Stateful redactor: remembers placeholder→original mappings so redacted
/// values can be restored in model output.
#[derive(Debug, Default)]
pub struct PiiRedactor {
    // Map placeholder -> original
    replacements: HashMap<String, String>,
    counts: HashMap<String, usize>,
}

impl PiiRedactor {
    /// A redactor with the regex-based rules.
    pub fn new() -> Self {
        Self::default()
    }

    /// NER-based redaction is not implemented; behaves like [`Self::new`].
    pub fn with_ner() -> Self {
        Self::default()
    }

    /// Replace emails, IPv4 addresses and phone numbers with placeholders.
    pub fn redact(&mut self, text: &str) -> String {
        let mut result = text.to_owned();

        result = self.redact_generic(&result, get_email_regex(), "EMAIL");
        result = self.redact_generic(&result, get_ipv4_regex(), "IP");
        result = self.redact_generic(&result, get_phone_regex(), "PHONE");

        result
    }

    fn redact_generic(&mut self, text: &str, regex: &Regex, kind: &str) -> String {
        regex
            .replace_all(text, |caps: &regex::Captures| {
                let original = caps[0].to_owned();
                if original.starts_with("<PII:") {
                    return original;
                }

                let count = self.counts.entry(kind.to_owned()).or_insert(0);
                *count += 1;
                let placeholder = format!("<PII:{kind}:{count}>");

                self.replacements.insert(placeholder.clone(), original);
                placeholder
            })
            .into_owned()
    }

    /// Substitute placeholders in `text` back with their original values.
    pub fn restore(&self, text: &str) -> String {
        get_placeholder_regex()
            .replace_all(text, |caps: &regex::Captures| {
                let full_match = &caps[0];
                self.replacements
                    .get(full_match)
                    .map_or_else(|| full_match.to_owned(), Clone::clone)
            })
            .into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_and_restore_roundtrip() {
        let mut redactor = PiiRedactor::new();
        let redacted =
            redactor.redact("mail bob@example.com from 10.0.0.1 or call 314-555-1234 please");
        assert!(!redacted.contains("bob@example.com"), "got: {redacted}");
        assert!(!redacted.contains("10.0.0.1"), "got: {redacted}");
        assert!(!redacted.contains("314-555-1234"), "got: {redacted}");
        assert!(redacted.contains("<PII:EMAIL:1>"), "got: {redacted}");
        assert!(redacted.contains("<PII:IP:1>"), "got: {redacted}");
        assert!(redacted.contains("<PII:PHONE:1>"), "got: {redacted}");

        let restored = redactor.restore(&redacted);
        assert!(restored.contains("bob@example.com"));
        assert!(restored.contains("10.0.0.1"));
        assert!(restored.contains("314-555-1234"));
    }

    #[test]
    fn restore_leaves_unknown_placeholders_alone() {
        let redactor = PiiRedactor::new();
        assert_eq!(redactor.restore("keep <PII:EMAIL:9>"), "keep <PII:EMAIL:9>");
    }
}
