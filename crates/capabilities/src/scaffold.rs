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
const AGENT_BODY: &str = "\n# Role\n\nDescribe who this agent is and what it owns.\n\n## Instructions\n\nTODO: instructions for the agent.\n";
/// Kimi's `mcp.json` is a merged config, so scaffolding writes a paste-ready
/// entry rather than the bare server object the other tools emit.
const KIMI_MCP_JSON: &str =
    "{\n  \"mcpServers\": {\n    \"TODO-name\": { \"command\": \"TODO\", \"args\": [] }\n  }\n}\n";

/// Render the file content for `(tool, kind)`. Returns `None` if unsupported.
pub fn render(req: &ScaffoldRequest) -> Option<String> {
    match (req.tool, req.kind) {
        (Tool::Claude, Kind::Skill)
        | (Tool::Opencode, Kind::Skill)
        | (Tool::Shared, Kind::Skill)
        | (Tool::Kimi, Kind::Skill) => Some(build_frontmatter_md(
            &[("name", req.name), ("description", req.description)],
            SKILL_BODY,
        )),
        (Tool::Kimi, Kind::Agent) => Some(build_frontmatter_md(
            &[("name", req.name), ("description", req.description)],
            AGENT_BODY,
        )),
        (Tool::Kimi, Kind::McpServer) => Some(KIMI_MCP_JSON.to_string()),
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
    fn kimi_skill_and_agent_roundtrip_with_different_bodies() {
        let skill = render(&req(Tool::Kimi, Kind::Skill, "deploy", "Ship it")).unwrap();
        let agent = render(&req(Tool::Kimi, Kind::Agent, "reviewer", "Reviews PRs")).unwrap();
        assert_eq!(frontmatter::parse(&skill).name(), Some("deploy"));
        assert_eq!(frontmatter::parse(&agent).name(), Some("reviewer"));
        assert_eq!(
            frontmatter::parse(&agent).description(),
            Some("Reviews PRs")
        );
        assert!(skill.contains("# Overview"));
        assert!(agent.contains("# Role"), "agent gets its own body");
    }

    #[test]
    fn kimi_mcp_snippet_is_a_pasteable_mcp_servers_map() {
        let s = render(&req(Tool::Kimi, Kind::McpServer, "m", "d")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!(v["mcpServers"].is_object(), "wraps in mcpServers to paste");
    }

    #[test]
    fn agent_kind_is_kimi_only() {
        for t in [Tool::Claude, Tool::Opencode, Tool::Codex, Tool::Shared] {
            assert!(render(&req(t, Kind::Agent, "x", "y")).is_none());
        }
    }

    #[test]
    fn opencode_hook_is_unsupported() {
        assert!(render(&req(Tool::Opencode, Kind::Hook, "x", "y")).is_none());
    }
}
