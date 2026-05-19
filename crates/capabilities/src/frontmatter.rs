//! Minimal YAML frontmatter parser for `---\nkey: value\n---\nbody`.
//!
//! Only supports the flat `key: value` shape used by SKILL.md / command markdown
//! across Claude Code, opencode, and the shared ~/.agents standard. Values are
//! trimmed; multiline values, lists, nested maps, and quoted forms beyond simple
//! double-quotes are out of scope for v0.

use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Frontmatter {
    pub fields: HashMap<String, String>,
    pub body: String,
}

impl Frontmatter {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.fields.get(key).map(|s| s.as_str())
    }

    pub fn name(&self) -> Option<&str> {
        self.get("name")
    }

    pub fn description(&self) -> Option<&str> {
        self.get("description")
    }
}

/// Parse `---\n...\n---\n<body>`. If no frontmatter block is present, returns
/// `Frontmatter { fields: {}, body: <full input> }` — never errors on absence.
pub fn parse(input: &str) -> Frontmatter {
    let stripped = input
        .strip_prefix("---\n")
        .or_else(|| input.strip_prefix("---\r\n"));
    let Some(rest) = stripped else {
        return Frontmatter {
            fields: HashMap::new(),
            body: input.to_string(),
        };
    };

    let end = match find_closing(rest) {
        Some(idx) => idx,
        None => {
            return Frontmatter {
                fields: HashMap::new(),
                body: input.to_string(),
            }
        }
    };

    let yaml = &rest[..end.start];
    let body_start = end.end;
    let body = rest.get(body_start..).unwrap_or("").to_string();

    let mut fields = HashMap::new();
    for line in yaml.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let key = k.trim().to_string();
            let raw = v.trim();
            let val = strip_quotes(raw).to_string();
            fields.insert(key, val);
        }
    }
    Frontmatter { fields, body }
}

struct Span {
    start: usize,
    end: usize,
}

fn find_closing(s: &str) -> Option<Span> {
    // Find a line that is exactly `---` (followed by \n, \r\n, or EOF).
    let mut idx = 0usize;
    for line in s.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" {
            return Some(Span {
                start: idx,
                end: idx + line.len(),
            });
        }
        idx += line.len();
    }
    None
}

fn strip_quotes(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_frontmatter() {
        let input = "---\nname: brainstorming\ndescription: Help brainstorm\n---\nBody here\n";
        let fm = parse(input);
        assert_eq!(fm.name(), Some("brainstorming"));
        assert_eq!(fm.description(), Some("Help brainstorm"));
        assert_eq!(fm.body, "Body here\n");
    }

    #[test]
    fn handles_quoted_values() {
        let input = "---\nname: \"my-skill\"\n---\n";
        let fm = parse(input);
        assert_eq!(fm.name(), Some("my-skill"));
    }

    #[test]
    fn no_frontmatter_returns_full_body() {
        let input = "Just a body\nwith two lines";
        let fm = parse(input);
        assert!(fm.fields.is_empty());
        assert_eq!(fm.body, input);
    }

    #[test]
    fn skips_comments_and_blank_lines() {
        let input = "---\n# comment\n\nname: x\n---\n";
        let fm = parse(input);
        assert_eq!(fm.name(), Some("x"));
    }

    #[test]
    fn unclosed_frontmatter_treats_input_as_body() {
        let input = "---\nname: oops\nno closing delim\n";
        let fm = parse(input);
        assert!(fm.fields.is_empty());
        assert_eq!(fm.body, input);
    }

    #[test]
    fn ignores_lines_without_colon() {
        let input = "---\nname: x\nrandom line no colon\ndescription: y\n---\n";
        let fm = parse(input);
        assert_eq!(fm.name(), Some("x"));
        assert_eq!(fm.description(), Some("y"));
    }

    #[test]
    fn crlf_line_endings_work() {
        let input = "---\r\nname: cr\r\n---\r\nbody\r\n";
        let fm = parse(input);
        assert_eq!(fm.name(), Some("cr"));
    }
}
