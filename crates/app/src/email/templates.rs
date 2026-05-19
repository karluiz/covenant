pub const ESCALATION_TEMPLATE: &str = "[Covenant] {label}\n\n\
Session: {session}\n\
When:    {timestamp}\n\
Cwd:     {cwd}\n\n\
{title}\n\n\
{body}\n";

pub const DIGEST_TEMPLATE: &str = "[Covenant] Activity digest — {count} event(s)\n\n\
Window: {window_start} → {window_end}\n\n\
{entries}\n\n\
—\n\
This digest groups Info-severity events from the last {minutes} minutes.\n";

pub fn render_escalation(
    label: &str,
    session: &str,
    timestamp: &str,
    cwd: &str,
    title: &str,
    body: &str,
) -> String {
    ESCALATION_TEMPLATE
        .replace("{label}", label)
        .replace("{session}", session)
        .replace("{timestamp}", timestamp)
        .replace("{cwd}", cwd)
        .replace("{title}", title)
        .replace("{body}", body)
}

pub fn render_digest(
    count: usize,
    window_start: &str,
    window_end: &str,
    minutes: u32,
    entries: &str,
) -> String {
    DIGEST_TEMPLATE
        .replace("{count}", &count.to_string())
        .replace("{window_start}", window_start)
        .replace("{window_end}", window_end)
        .replace("{minutes}", &minutes.to_string())
        .replace("{entries}", entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escalation_substitutes_all_placeholders() {
        let out = render_escalation(
            "op_escalate",
            "01HX",
            "2026-05-05T12:00:00Z",
            "/tmp",
            "paused",
            "blocked on input",
        );
        assert!(out.contains("op_escalate"));
        assert!(out.contains("01HX"));
        assert!(out.contains("2026-05-05T12:00:00Z"));
        assert!(out.contains("/tmp"));
        assert!(out.contains("paused"));
        assert!(out.contains("blocked on input"));
        assert!(!out.contains("{"));
    }

    #[test]
    fn digest_substitutes_all_placeholders() {
        let out = render_digest(3, "12:00", "12:15", 15, "- a\n- b\n- c");
        assert!(out.contains("3 event(s)"));
        assert!(out.contains("12:00 → 12:15"));
        assert!(out.contains("- a"));
        assert!(out.contains("last 15 minutes"));
        assert!(!out.contains("{"));
    }
}
