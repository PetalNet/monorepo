//! Small text helpers shared across the workspace.

/// Take at most `max` characters of `s`.
#[must_use]
pub fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Collapse all whitespace runs to single spaces and truncate to `max`.
#[must_use]
pub fn sanitize_line(s: &str, max: usize) -> String {
    let compact = s.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&compact, max)
}

/// Map ASCII letters/digits to Unicode mathematical-bold equivalents.
///
/// Used for sender-name prefixes on relayed messages, since relayed bodies
/// are plain text (no HTML formatting survives every bridge).
#[must_use]
pub fn to_bold(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' => char::from_u32('𝐀' as u32 + (c as u32 - 'A' as u32)).unwrap_or(c),
            'a'..='z' => char::from_u32('𝐚' as u32 + (c as u32 - 'a' as u32)).unwrap_or(c),
            '0'..='9' => char::from_u32('𝟎' as u32 + (c as u32 - '0' as u32)).unwrap_or(c),
            _ => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_counts_chars_not_bytes() {
        assert_eq!(truncate("héllo", 3), "hél");
        assert_eq!(truncate("hi", 10), "hi");
    }

    #[test]
    fn sanitize_line_collapses_whitespace() {
        assert_eq!(sanitize_line("a\n b\t\tc  ", 100), "a b c");
    }

    #[test]
    fn to_bold_maps_alnum_and_keeps_the_rest() {
        assert_eq!(to_bold("Ab1!"), "𝐀𝐛𝟏!");
    }
}
