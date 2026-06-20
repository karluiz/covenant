use crate::settings::Settings;
use serde_json::Value;

/// Remove every secret field from a serialized `Settings` JSON value, in place.
/// Keeps the surrounding non-secret structure intact.
pub fn strip_secrets(prefs: &mut Value) {
    let Some(obj) = prefs.as_object_mut() else { return };
    obj.remove("anthropic_api_key");
    obj.remove("sendgrid_api_key");
    if let Some(tg) = obj.get_mut("telegram").and_then(|v| v.as_object_mut()) {
        tg.remove("bot_token");
    }
    if let Some(providers) = obj.get_mut("providers").and_then(|v| v.as_object_mut()) {
        for (_id, p) in providers.iter_mut() {
            if let Some(po) = p.as_object_mut() {
                po.remove("api_key");
            }
        }
    }
}

/// Apply cloud (secret-free) preferences over the local Settings while
/// preserving this machine's secret fields. Strategy: start from local JSON,
/// capture local secrets, shallow-overwrite top-level keys from cloud (cloud
/// has no secret keys, so they survive), then re-inject the captured secrets.
/// Deserializing back into `Settings` validates and fills any missing field
/// with serde defaults.
pub fn merge_preferences(local: &Settings, cloud_prefs: &Value) -> Settings {
    let mut base = serde_json::to_value(local).unwrap_or(Value::Null);

    // Overwrite top-level non-secret keys from cloud.
    if let (Some(b), Some(c)) = (base.as_object_mut(), cloud_prefs.as_object()) {
        for (k, v) in c {
            b.insert(k.clone(), v.clone());
        }
    }

    // Re-inject local secrets (cloud never carried them; cloud's telegram/
    // providers objects just lack the secret subfields after the overwrite).
    if let Some(b) = base.as_object_mut() {
        b.insert(
            "anthropic_api_key".into(),
            serde_json::to_value(&local.anthropic_api_key).unwrap_or(Value::Null),
        );
        b.insert(
            "sendgrid_api_key".into(),
            serde_json::to_value(&local.sendgrid_api_key).unwrap_or(Value::Null),
        );
        if let Some(tg) = b.get_mut("telegram").and_then(|v| v.as_object_mut()) {
            tg.insert("bot_token".into(), Value::String(local.telegram.bot_token.clone()));
        }
        if let Some(providers) = b.get_mut("providers").and_then(|v| v.as_object_mut()) {
            for (id, p) in providers.iter_mut() {
                if let (Some(po), Some(local_p)) = (p.as_object_mut(), local.providers.get(id)) {
                    po.insert(
                        "api_key".into(),
                        serde_json::to_value(&local_p.api_key).unwrap_or(Value::Null),
                    );
                }
            }
        }
    }

    serde_json::from_value(base).unwrap_or_else(|_| local.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strip_removes_all_secret_paths() {
        let mut v = json!({
            "anthropic_api_key": "sk-ant-xxx",
            "sendgrid_api_key": "SG.yyy",
            "telegram": { "bot_token": "123:abc", "chat_id": "42", "enabled": true },
            "providers": { "azure": { "api_key": "az-secret", "label": "Azure" } },
            "ui_font_family": "Inter"
        });
        strip_secrets(&mut v);
        assert!(v.get("anthropic_api_key").is_none());
        assert!(v.get("sendgrid_api_key").is_none());
        assert!(v["telegram"].get("bot_token").is_none());
        assert_eq!(v["telegram"]["chat_id"], json!("42")); // non-secret kept
        assert!(v["providers"]["azure"].get("api_key").is_none());
        assert_eq!(v["providers"]["azure"]["label"], json!("Azure"));
        assert_eq!(v["ui_font_family"], json!("Inter"));
    }

    #[test]
    fn merge_keeps_local_secrets_takes_cloud_nonsecret() {
        let mut local = Settings::default();
        local.anthropic_api_key = Some("LOCAL-KEY".into());
        local.telegram.bot_token = "LOCAL-BOT".into();
        local.ui_font_family = Some("OldFont".into());

        // Cloud prefs = a stripped serialization with a changed non-secret field.
        let mut cloud = serde_json::to_value(&local).unwrap();
        strip_secrets(&mut cloud);
        cloud["ui_font_family"] = json!("NewFont");

        let merged = merge_preferences(&local, &cloud);
        assert_eq!(merged.anthropic_api_key.as_deref(), Some("LOCAL-KEY")); // secret kept
        assert_eq!(merged.telegram.bot_token, "LOCAL-BOT"); // nested secret kept
        assert_eq!(merged.ui_font_family.as_deref(), Some("NewFont")); // cloud applied
    }
}
