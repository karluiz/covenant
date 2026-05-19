use std::sync::Mutex;
use std::time::SystemTime;

#[derive(Debug, Clone)]
pub struct DigestEntry {
    pub at: SystemTime,
    pub label: String,
    pub summary: String,
}

#[derive(Default)]
pub struct DigestBuffer {
    entries: Mutex<Vec<DigestEntry>>,
}

impl DigestBuffer {
    pub fn push(&self, entry: DigestEntry) {
        self.entries.lock().unwrap().push(entry);
    }

    pub fn drain(&self) -> Vec<DigestEntry> {
        std::mem::take(&mut *self.entries.lock().unwrap())
    }

    pub fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

pub fn format_entries(entries: &[DigestEntry]) -> String {
    use std::time::UNIX_EPOCH;
    entries
        .iter()
        .map(|e| {
            let secs =
                e.at.duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
            format!("- t={secs} [{}] {}", e.label, e.summary)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub async fn spawn_flush_loop(
    buffer: std::sync::Arc<DigestBuffer>,
    client: std::sync::Arc<dyn crate::email::client::SendGridClient>,
    from: String,
    to: String,
    window: std::time::Duration,
) {
    use crate::email::client::EmailMessage;
    use crate::email::templates::render_digest;
    let mut interval = tokio::time::interval(window);
    interval.tick().await; // skip the immediate first tick
    loop {
        interval.tick().await;
        let entries = buffer.drain();
        if entries.is_empty() {
            continue;
        }
        let count = entries.len();
        let body = render_digest(
            count,
            "now",
            "now",
            (window.as_secs() / 60) as u32,
            &format_entries(&entries),
        );
        let msg = EmailMessage {
            from: from.clone(),
            to: to.clone(),
            subject: format!("[Covenant] Activity digest — {} event(s)", count),
            body,
        };
        if let Err(e) = client.send(msg).await {
            tracing::warn!(error = %e, "digest flush failed");
        }
    }
}

#[cfg(test)]
mod flush_tests {
    use super::*;
    use crate::email::client::{RecordingSendGridClient, SendGridClient};
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test(start_paused = true)]
    async fn flush_emits_one_email_when_buffer_has_entries() {
        let buf = Arc::new(DigestBuffer::default());
        let recording = Arc::new(RecordingSendGridClient::default());
        let client: Arc<dyn SendGridClient> = recording.clone();

        buf.push(DigestEntry {
            at: std::time::SystemTime::now(),
            label: "AomComplete".into(),
            summary: "first".into(),
        });
        buf.push(DigestEntry {
            at: std::time::SystemTime::now(),
            label: "AomComplete".into(),
            summary: "second".into(),
        });

        let handle = tokio::spawn(spawn_flush_loop(
            Arc::clone(&buf),
            client,
            "from@x".into(),
            "to@x".into(),
            Duration::from_secs(60),
        ));

        // Let the spawned task run until it parks on the first interval tick.
        tokio::task::yield_now().await;
        // Now advance past the window so the interval fires.
        tokio::time::advance(Duration::from_secs(61)).await;
        // Drain the wakeup queue so the task processes the tick and sends.
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        handle.abort();

        let snap = recording.snapshot();
        assert_eq!(snap.len(), 1, "expected exactly one digest email");
        assert!(snap[0].subject.contains("2 event(s)"));
        assert!(snap[0].body.contains("first"));
        assert!(snap[0].body.contains("second"));
        assert!(buf.is_empty(), "buffer should be drained");
    }

    #[tokio::test(start_paused = true)]
    async fn flush_skips_when_buffer_empty() {
        let buf = Arc::new(DigestBuffer::default());
        let recording = Arc::new(RecordingSendGridClient::default());
        let client: Arc<dyn SendGridClient> = recording.clone();

        let handle = tokio::spawn(spawn_flush_loop(
            Arc::clone(&buf),
            client,
            "from@x".into(),
            "to@x".into(),
            Duration::from_secs(60),
        ));

        tokio::time::advance(Duration::from_secs(61)).await;
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        handle.abort();

        assert!(recording.snapshot().is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(label: &str, summary: &str) -> DigestEntry {
        DigestEntry {
            at: SystemTime::now(),
            label: label.into(),
            summary: summary.into(),
        }
    }

    #[test]
    fn push_and_drain_roundtrip() {
        let b = DigestBuffer::default();
        assert!(b.is_empty());
        b.push(entry("aom_complete", "ok"));
        b.push(entry("aom_complete", "again"));
        assert_eq!(b.len(), 2);
        let drained = b.drain();
        assert_eq!(drained.len(), 2);
        assert!(b.is_empty());
    }

    #[test]
    fn drain_on_empty_returns_empty() {
        let b = DigestBuffer::default();
        assert!(b.drain().is_empty());
    }

    #[test]
    fn format_entries_emits_one_line_each() {
        let e = vec![entry("aom_complete", "ok"), entry("aom_complete", "two")];
        let s = format_entries(&e);
        assert_eq!(s.lines().count(), 2);
        assert!(s.contains("aom_complete"));
    }
}
