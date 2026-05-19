//! Templates for creating new capabilities (v0: in-code string constants).

use crate::model::{Kind, Tool};
use crate::writer::build_frontmatter_md;

pub struct ScaffoldRequest<'a> {
    pub tool: Tool,
    pub kind: Kind,
    pub name: &'a str,
    pub description: &'a str,
}

const SKILL_BODY: &str = "\n# Overview\n\nDescribe what this skill does and when to use it.\n\n## Instructions\n\nTODO: instructions for the agent.\n";
const SLASH_BODY: &str = "\nTODO: command body\n";
const HOOK_JSON: &str = r#"{"matcher":"*","hooks":[{"type":"command","command":"echo TODO"}]}"#;
const MCP_JSON: &str = r#"{"command":"TODO","type":"stdio"}"#;

/// Render the file content for `(tool, kind)`. Returns `None` if unsupported.
pub fn render(req: &ScaffoldRequest) -> Option<String> {
    match (req.tool, req.kind) {
        (Tool::Claude, Kind::Skill)
        | (Tool::Opencode, Kind::Skill)
        | (Tool::Shared, Kind::Skill) => Some(build_frontmatter_md(
            &[("name", req.name), ("description", req.description)],
            SKILL_BODY,
        )),
        (Tool::Claude, Kind::SlashCommand) | (Tool::Codex, Kind::SlashCommand) => {
            Some(build_frontmatter_md(
                &[("name", req.name), ("description", req.description)],
                SLASH_BODY,
            ))
        }
        (Tool::Claude, Kind::Hook) => Some(HOOK_JSON.to_string()),
        (Tool::Claude, Kind::McpServer)
        | (Tool::Copilot, Kind::McpServer)
        | (Tool::Codex, Kind::McpServer) => Some(MCP_JSON.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter;

    fn req<'a>(tool: Tool, kind: Kind, name: &'a str, desc: &'a str) -> ScaffoldRequest<'a> {
        ScaffoldRequest {
            tool,
            kind,
            name,
            description: desc,
        }
    }

    #[test]
    fn claude_skill_roundtrips() {
        let s = render(&req(Tool::Claude, Kind::Skill, "foo", "bar")).unwrap();
        let fm = frontmatter::parse(&s);
        assert_eq!(fm.name(), Some("foo"));
        assert_eq!(fm.description(), Some("bar"));
    }

    #[test]
    fn claude_slash_roundtrips() {
        let s = render(&req(Tool::Claude, Kind::SlashCommand, "deploy", "ships it")).unwrap();
        let fm = frontmatter::parse(&s);
        assert_eq!(fm.name(), Some("deploy"));
        assert_eq!(fm.description(), Some("ships it"));
    }

    #[test]
    fn opencode_skill_roundtrips() {
        let s = render(&req(Tool::Opencode, Kind::Skill, "oc", "d")).unwrap();
        let fm = frontmatter::parse(&s);
        assert_eq!(fm.name(), Some("oc"));
    }

    #[test]
    fn shared_skill_roundtrips() {
        let s = render(&req(Tool::Shared, Kind::Skill, "sh", "d")).unwrap();
        let fm = frontmatter::parse(&s);
        assert_eq!(fm.name(), Some("sh"));
        assert_eq!(fm.description(), Some("d"));
    }

    #[test]
    fn claude_hook_is_valid_json() {
        let s = render(&req(Tool::Claude, Kind::Hook, "h", "d")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["matcher"], "*");
        assert!(v["hooks"].is_array());
    }

    #[test]
    fn claude_mcp_is_valid_json() {
        let s = render(&req(Tool::Claude, Kind::McpServer, "m", "d")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["type"], "stdio");
    }

    #[test]
    fn copilot_mcp_is_valid_json() {
        let s = render(&req(Tool::Copilot, Kind::McpServer, "m", "d")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["type"], "stdio");
    }

    #[test]
    fn copilot_skill_is_unsupported() {
        assert!(render(&req(Tool::Copilot, Kind::Skill, "x", "y")).is_none());
    }

    #[test]
    fn codex_slash_roundtrips() {
        let s = render(&req(
            Tool::Codex,
            Kind::SlashCommand,
            "review",
            "code review",
        ))
        .unwrap();
        let fm = frontmatter::parse(&s);
        assert_eq!(fm.name(), Some("review"));
    }

    #[test]
    fn codex_skill_is_unsupported() {
        assert!(render(&req(Tool::Codex, Kind::Skill, "x", "y")).is_none());
    }

    #[test]
    fn opencode_hook_is_unsupported() {
        assert!(render(&req(Tool::Opencode, Kind::Hook, "x", "y")).is_none());
    }
}
