use serde::{Deserialize, Serialize};
use ulid::Ulid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FamiliarId(pub Ulid);

impl FamiliarId {
    pub fn new() -> Self {
        Self(Ulid::new())
    }
    pub fn as_str(&self) -> String {
        self.0.to_string()
    }
}

impl std::fmt::Display for FamiliarId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Style {
    Concise,
    Formal,
    Conversational,
    Sarcastic,
}

impl Default for Style {
    fn default() -> Self {
        Style::Conversational
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FamiliarConfig {
    pub name: String,
    pub style: Style,
    pub daily_cap_usd: f64,
}

impl Default for FamiliarConfig {
    fn default() -> Self {
        Self {
            name: "Familiar".into(),
            style: Style::default(),
            daily_cap_usd: 5.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Familiar {
    pub id: FamiliarId,
    pub session_id: String,
    pub config: FamiliarConfig,
    pub created_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn familiar_id_round_trips_through_string() {
        let id = FamiliarId::new();
        let s = id.as_str();
        let parsed: Ulid = s.parse().unwrap();
        assert_eq!(parsed, id.0);
    }

    #[test]
    fn default_config_has_sensible_cap() {
        let cfg = FamiliarConfig::default();
        assert!(cfg.daily_cap_usd > 0.0);
        assert_eq!(cfg.style, Style::Conversational);
    }

    #[test]
    fn style_serializes_lowercase() {
        let s = serde_json::to_string(&Style::Sarcastic).unwrap();
        assert_eq!(s, "\"sarcastic\"");
    }
}
