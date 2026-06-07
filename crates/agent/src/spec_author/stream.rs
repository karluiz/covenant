//! Streaming tool-loop for the premium spec author.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpecStreamEvent {
    ThinkingDelta { text: String },
    TextDelta { text: String },
    ToolStart { id: String, tool: String, arg: String },
    ToolResult { id: String, summary: String, ok: bool },
    SectionUpdate { section: String, markdown: String, status: String },
    Phase { section: String },
    TurnDone { awaiting_user: bool },
    Final { markdown: String },
    Error { message: String },
}

/// Callback sink the dispatcher pushes events into.
pub trait StreamSink: Send + Sync {
    fn emit(&self, event: SpecStreamEvent);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct VecSink(Mutex<Vec<SpecStreamEvent>>);
    impl StreamSink for VecSink {
        fn emit(&self, e: SpecStreamEvent) { self.0.lock().unwrap().push(e); }
    }

    #[test]
    fn event_serializes_snake_case_tag() {
        let e = SpecStreamEvent::ToolStart {
            id: "1".into(), tool: "grep".into(), arg: "fn main".into() };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "tool_start");
        assert_eq!(v["tool"], "grep");
    }

    #[test]
    fn sink_collects() {
        let sink = VecSink(Mutex::new(vec![]));
        sink.emit(SpecStreamEvent::TurnDone { awaiting_user: true });
        assert_eq!(sink.0.lock().unwrap().len(), 1);
    }
}
