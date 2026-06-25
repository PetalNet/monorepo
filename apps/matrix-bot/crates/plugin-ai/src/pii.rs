use regex::Regex;
use std::collections::HashMap;
use std::sync::OnceLock;

static EMAIL_REGEX: OnceLock<Regex> = OnceLock::new();
static IPV4_REGEX: OnceLock<Regex> = OnceLock::new();
static PHONE_REGEX: OnceLock<Regex> = OnceLock::new();

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

#[derive(Debug, Default)]
pub struct PiiRedactor {
    // Map placeholder -> original
    replacements: HashMap<String, String>,
    counts: HashMap<String, usize>,
}

impl PiiRedactor {
    pub fn new() -> Self {
        Self::default()
    }

    // NER disabled due to compilation issues
    pub fn with_ner() -> Self {
        Self::default()
    }

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

    pub fn restore(&self, text: &str) -> String {
        let placeholder_regex = Regex::new(r"<PII:([A-Z]+):(\d+)>").unwrap();

        placeholder_regex
            .replace_all(text, |caps: &regex::Captures| {
                let full_match = &caps[0];
                self.replacements
                    .get(full_match)
                    .map_or_else(|| full_match.to_owned(), Clone::clone)
            })
            .into_owned()
    }
}
