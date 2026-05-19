use crate::error::Result;
use crate::memory::Memory;

pub struct CostGate<'a> {
    memory: &'a Memory,
    cap_usd: f64,
}

impl<'a> CostGate<'a> {
    pub fn new(memory: &'a Memory, cap_usd: f64) -> Self {
        Self { memory, cap_usd }
    }

    pub fn current_day(now_ms: i64) -> String {
        let secs = (now_ms / 1000) as i64;
        let days = secs / 86_400;
        let (y, m, d) = days_to_ymd(days);
        format!("{:04}-{:02}-{:02}", y, m, d)
    }

    pub fn is_frozen(&self, now_ms: i64) -> Result<bool> {
        let day = Self::current_day(now_ms);
        let spend = self.memory.spend_for_day(&day)?;
        Ok(spend >= self.cap_usd)
    }

    /// Records cost unconditionally (post-call accounting). Prefer `try_reserve` for
    /// pre-call gating to avoid TOCTOU races.
    pub fn record(&self, now_ms: i64, usd: f64) -> Result<()> {
        let day = Self::current_day(now_ms);
        self.memory.add_spend(&day, usd)
    }

    /// Atomic: try to reserve `usd` against today's cap.
    /// Returns Ok(true) if reserved (caller may proceed), Ok(false) if cap would be exceeded.
    /// Integration into summarizer/agent callers is follow-up #1a.
    pub fn try_reserve(&self, now_ms: i64, usd: f64) -> Result<bool> {
        let day = Self::current_day(now_ms);
        self.memory.try_reserve_spend(&day, usd, self.cap_usd)
    }
}

fn days_to_ymd(mut days: i64) -> (i32, u32, u32) {
    days += 719468;
    let era = if days >= 0 { days } else { days - 146096 } / 146097;
    let doe = (days - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = (if m <= 2 { y + 1 } else { y }) as i32;
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_format_is_iso() {
        assert_eq!(CostGate::current_day(1777867200000), "2026-05-04");
    }

    #[test]
    fn try_reserve_round_trip() {
        let m = Memory::open_in_memory().unwrap();
        let g = CostGate::new(&m, 1.0);
        assert!(g.try_reserve(1777867200000, 0.5).unwrap());
        assert!(g.try_reserve(1777867200000, 0.4).unwrap());
        // 0.9 + 0.2 = 1.1 > 1.0 → false
        assert!(!g.try_reserve(1777867200000, 0.2).unwrap());
    }

    #[test]
    fn freezes_at_cap() {
        let m = Memory::open_in_memory().unwrap();
        let g = CostGate::new(&m, 1.0);
        assert!(!g.is_frozen(1777867200000).unwrap());
        g.record(1777867200000, 0.5).unwrap();
        assert!(!g.is_frozen(1777867200000).unwrap());
        g.record(1777867200000, 0.6).unwrap();
        assert!(g.is_frozen(1777867200000).unwrap());
    }
}
