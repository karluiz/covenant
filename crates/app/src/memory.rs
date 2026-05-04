//! Pure retrieval scoring for operator learning (spec 3.13).
//! Storage I/O lives in `storage.rs`; this module only ranks loaded rows.

use crate::storage::OperatorMemoryRow;
use regex::Regex;
use std::sync::OnceLock;

const STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at",
    "is", "are", "was", "were", "be", "been", "being",
    "this", "that", "these", "those", "it", "its", "for", "with", "from",
    "as", "by", "do", "does", "did", "done", "doing", "yes", "no", "ok",
];

fn applied_memory_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)applied_memory:\s*(\d+)").expect("valid regex"))
}

/// Parses `applied_memory: <id>` out of a rationale string. Returns the
/// stripped rationale and the parsed id (if any). The marker can appear
/// on its own line OR mid-sentence; we accept both. The entire line
/// containing the marker is removed from the output.
pub fn parse_applied_memory(rationale: &str) -> (String, Option<i64>) {
    let re = applied_memory_regex();
    let mut id: Option<i64> = None;
    let mut kept = Vec::new();

    for line in rationale.lines() {
        if let Some(caps) = re.captures(line) {
            if let Some(id_match) = caps.get(1) {
                if let Ok(parsed) = id_match.as_str().parse::<i64>() {
                    id = Some(parsed);
                    continue; // drop this line from kept
                }
            }
        }
        kept.push(line);
    }

    let stripped = kept.join("\n").trim().to_string();
    (stripped, id)
}

/// Extract normalized tags: lowercase, deduplicate, drop stopwords/short
/// tokens, cap at 12. Preserves first-occurrence order.
pub fn extract_tags(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for tok in text.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
        if tok.len() < 2 || STOPWORDS.contains(&tok) || out.iter().any(|t| t == tok) {
            continue;
        }
        out.push(tok.to_string());
        if out.len() >= 12 {
            break;
        }
    }
    out
}

#[derive(Debug, Clone)]
pub struct MemoryHit {
    pub row: OperatorMemoryRow,
    pub vector_distance: f32,
    pub keyword_score: u32,
}

/// Combine score: distance - 0.05*kw_score. Lower is better.
fn combined_score(hit: &MemoryHit) -> f32 {
    hit.vector_distance - (hit.keyword_score as f32) * 0.05
}

/// Count keyword overlap: how many query tags appear in memory tags.
pub fn extract_keyword_score(memory_tags: &str, query_tags: &[String]) -> u32 {
    let mem: Vec<&str> = memory_tags.split_whitespace().collect();
    query_tags.iter().filter(|q| mem.contains(&q.as_str())).count() as u32
}

/// Top-k retrieval: rescore by keyword overlap, sort by combined score
/// (distance - 0.05*kw_score), newest-wins on tie. Returns (winners, shadowed).
/// Shadowed = same decision text + ≈equal score but older created_at.
pub fn retrieve_hybrid(
    candidates: Vec<(OperatorMemoryRow, f32)>,
    query_tags: &[String],
    k: usize,
) -> (Vec<MemoryHit>, Vec<i64>) {
    if candidates.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let mut hits: Vec<MemoryHit> = candidates
        .into_iter()
        .map(|(row, dist)| {
            let kw = extract_keyword_score(&row.tags, query_tags);
            MemoryHit { row, vector_distance: dist, keyword_score: kw }
        })
        .collect();

    hits.sort_by(|a, b| {
        let sa = combined_score(a);
        let sb = combined_score(b);
        sa.partial_cmp(&sb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.row.created_at_unix_ms.cmp(&a.row.created_at_unix_ms))
    });

    let mut shadowed: Vec<i64> = Vec::new();
    for i in 0..hits.len() {
        for j in (i + 1)..hits.len() {
            if hits[i].row.decision == hits[j].row.decision
                && (combined_score(&hits[i]) - combined_score(&hits[j])).abs() < 1e-3
            {
                shadowed.push(hits[j].row.id);
            }
        }
    }

    (hits.into_iter().take(k).collect(), shadowed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_applied_memory_extracts_id_on_own_line() {
        let input = "Reason text.\napplied_memory: 42";
        let (text, id) = parse_applied_memory(input);
        assert_eq!(text, "Reason text.");
        assert_eq!(id, Some(42));
    }

    #[test]
    fn parse_applied_memory_inline() {
        let input = "Reason text.\napplied_memory: 7 on same line";
        let (text, id) = parse_applied_memory(input);
        assert_eq!(text, "Reason text.");
        assert_eq!(id, Some(7));
    }

    #[test]
    fn parse_applied_memory_none_when_missing() {
        let input = "Plain rationale.";
        let (text, id) = parse_applied_memory(input);
        assert_eq!(text, "Plain rationale.");
        assert_eq!(id, None);
    }

    #[test]
    fn parse_applied_memory_invalid_id_keeps_line() {
        let input = "applied_memory: not-a-number";
        let (text, id) = parse_applied_memory(input);
        assert_eq!(text, "applied_memory: not-a-number");
        assert_eq!(id, None);
    }

    #[test]
    fn parse_applied_memory_case_insensitive() {
        let input = "Applied_Memory: 99";
        let (text, id) = parse_applied_memory(input);
        assert_eq!(text, "");
        assert_eq!(id, Some(99));
    }

    fn fixture_row(
        id: i64,
        tags: &str,
        decision: &str,
        created_at: u64,
    ) -> OperatorMemoryRow {
        OperatorMemoryRow {
            id,
            pattern: "dummy".to_string(),
            decision: decision.to_string(),
            rationale: None,
            scope: "global".to_string(),
            tags: tags.to_string(),
            created_at_unix_ms: created_at,
        }
    }

    #[test]
    fn extract_tags_lowercases_dedups_drops_stopwords() {
        assert_eq!(extract_tags("Run THE tests! Run again!"),
                   vec!["run", "tests", "again"]);
    }

    #[test]
    fn extract_tags_caps_at_12() {
        let r = extract_tags("aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp");
        assert_eq!(r.len(), 12);
    }

    #[test]
    fn extract_keyword_score_counts_overlap() {
        assert_eq!(extract_keyword_score("foo bar baz", &["bar".into(), "qux".into()]), 1);
    }

    #[test]
    fn retrieve_hybrid_empty_returns_empty() {
        let (w, s) = retrieve_hybrid(Vec::new(), &[], 5);
        assert!(w.is_empty() && s.is_empty());
    }

    #[test]
    fn retrieve_hybrid_orders_by_distance_then_recency() {
        let cand = vec![
            (fixture_row(1, "foo", "a", 1000), 0.5),
            (fixture_row(2, "bar", "b", 2000), 0.5),
            (fixture_row(3, "baz", "c", 1500), 0.2),
        ];
        let (w, _) = retrieve_hybrid(cand, &[], 3);
        assert_eq!([w[0].row.id, w[1].row.id, w[2].row.id], [3, 2, 1]);
    }

    #[test]
    fn retrieve_hybrid_keyword_overlap_lowers_score() {
        let cand = vec![
            (fixture_row(1, "foo bar baz", "x", 1000), 0.5),
            (fixture_row(2, "qux quux", "y", 1000), 0.5),
        ];
        let (w, _) = retrieve_hybrid(cand, &vec!["foo".into(), "bar".into()], 2);
        assert_eq!(w[0].row.id, 1);
    }

    #[test]
    fn retrieve_hybrid_shadows_same_decision_close_score() {
        let cand = vec![
            (fixture_row(1, "foo", "same", 1000), 0.5),
            (fixture_row(2, "foo", "same", 2000), 0.5),
        ];
        let (w, s) = retrieve_hybrid(cand, &[], 2);
        assert_eq!(w[0].row.id, 2);
        assert_eq!(s, vec![1]);
    }

    #[test]
    fn retrieve_hybrid_takes_k() {
        let cand = vec![
            (fixture_row(1, "a", "d1", 1000), 0.1),
            (fixture_row(2, "b", "d2", 1000), 0.2),
            (fixture_row(3, "c", "d3", 1000), 0.3),
            (fixture_row(4, "d", "d4", 1000), 0.4),
            (fixture_row(5, "e", "d5", 1000), 0.5),
            (fixture_row(6, "f", "d6", 1000), 0.6),
        ];
        let (w, _) = retrieve_hybrid(cand, &[], 3);
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].row.id, 1);
    }
}
