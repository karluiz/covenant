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
            let secs = e
                .at
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("- t={secs} [{}] {}", e.label, e.summary)
        })
        .collect::<Vec<_>>()
        .join("\n")
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
