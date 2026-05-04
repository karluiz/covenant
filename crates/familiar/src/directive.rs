use crate::error::{FamiliarError, Result};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectiveKind {
    Stop,
    Focus,
    Avoid,
    Resume,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Directive {
    pub id: String,           // ulid
    pub kind: DirectiveKind,
    pub payload: String,
    pub rationale: String,
}

impl Directive {
    pub fn new(kind: DirectiveKind, payload: String, rationale: String) -> Self {
        Self { id: Ulid::new().to_string(), kind, payload, rationale }
    }

    /// The synthetic user message that will be injected into the operator's
    /// next cycle when this directive is approved.
    pub fn rendered_for_operator(&self) -> String {
        let tag = match self.kind {
            DirectiveKind::Stop => "STOP",
            DirectiveKind::Focus => "FOCUS",
            DirectiveKind::Avoid => "AVOID",
            DirectiveKind::Resume => "RESUME",
            DirectiveKind::Custom => "DIRECTIVE",
        };
        format!("[FAMILIAR_DIRECTIVE {}]\n{}\n\n(Rationale: {})",
                tag, self.payload, self.rationale)
    }
}

pub trait SafetyCheck: Send + Sync {
    /// Returns Err(reason) if the directive payload is unsafe.
    fn check(&self, d: &Directive) -> std::result::Result<(), String>;
}

/// Default minimal safety: blocks the high-risk patterns from the spec.
pub struct DefaultSafety;
impl SafetyCheck for DefaultSafety {
    fn check(&self, d: &Directive) -> std::result::Result<(), String> {
        let p = d.payload.to_lowercase();
        let blocked = [
            ("rm -rf", "rm -rf"),
            ("sudo ", "sudo"),
            ("doas ", "doas"),
            ("| sh", "pipe to sh"),
            ("| bash", "pipe to bash"),
            ("git push --force", "force push"),
            ("git push -f", "force push"),
            ("mkfs", "mkfs"),
            ("dd if=", "dd"),
        ];
        for (pat, label) in blocked {
            if p.contains(pat) {
                return Err(format!("blocked: {label}"));
            }
        }
        Ok(())
    }
}

pub fn ensure_safe(d: &Directive, safety: &dyn SafetyCheck) -> Result<()> {
    safety.check(d).map_err(|reason| FamiliarError::SafetyBlocked { reason })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_message_tags_kind() {
        let d = Directive::new(DirectiveKind::Stop, "stop touching auth".into(),
                               "you said it was risky".into());
        let r = d.rendered_for_operator();
        assert!(r.contains("[FAMILIAR_DIRECTIVE STOP]"));
        assert!(r.contains("stop touching auth"));
        assert!(r.contains("Rationale"));
    }

    #[test]
    fn safety_blocks_rm_rf() {
        let d = Directive::new(DirectiveKind::Custom, "rm -rf /".into(), "x".into());
        assert!(ensure_safe(&d, &DefaultSafety).is_err());
    }

    #[test]
    fn safety_blocks_force_push_to_main() {
        let d = Directive::new(DirectiveKind::Custom,
                                "git push --force origin main".into(), "x".into());
        assert!(ensure_safe(&d, &DefaultSafety).is_err());
    }

    #[test]
    fn safe_directive_passes() {
        let d = Directive::new(DirectiveKind::Focus, "focus on test 12".into(), "x".into());
        assert!(ensure_safe(&d, &DefaultSafety).is_ok());
    }
}
