//! Pure metrics aggregation for the Resources panel. No system calls — the app
//! crate populates a `ProcessTable` from `sysinfo`; this crate only sums subtrees
//! and builds the snapshot, so it stays unit-testable.

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProcSample {
    pub pid: u32,
    pub parent_pid: u32,
    pub cpu: f32,
    pub mem_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ProcMetrics {
    pub cpu: f32,
    pub mem_bytes: u64,
}

/// Process snapshot indexed by pid, with a parent→children adjacency for
/// descendant walks.
pub struct ProcessTable {
    by_pid: HashMap<u32, ProcSample>,
    children: HashMap<u32, Vec<u32>>,
}

impl ProcessTable {
    pub fn from_samples(samples: Vec<ProcSample>) -> Self {
        let mut by_pid = HashMap::new();
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for s in samples {
            children.entry(s.parent_pid).or_default().push(s.pid);
            by_pid.insert(s.pid, s);
        }
        Self { by_pid, children }
    }
}

/// Sum cpu + memory over `root` and all its transitive descendants. Missing pids
/// contribute zero; cycles are visited once.
pub fn aggregate_subtree(table: &ProcessTable, root: u32) -> ProcMetrics {
    let mut out = ProcMetrics::default();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(s) = table.by_pid.get(&pid) {
            out.cpu += s.cpu;
            out.mem_bytes += s.mem_bytes;
        }
        if let Some(kids) = table.children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    out
}

#[derive(Debug, Clone, Copy)]
pub struct MachineTotals {
    pub mem_total_bytes: u64,
    pub ncpus: usize,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SessionMetric {
    pub id: String,
    pub cpu: f32,
    pub mem_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ResourcesSnapshot {
    pub total_cpu: f32,
    pub total_mem_bytes: u64,
    pub ram_share: f32,
    pub mem_total_bytes: u64,
    pub sessions: Vec<SessionMetric>,
}

/// Aggregate each session's subtree, normalize cpu to a 0..100 machine reading
/// (so a fully-pegged core under 8 cores reads ~12.5%, matching Activity-Monitor
/// style), and compute the footprint totals + RAM share.
pub fn build_snapshot(
    table: &ProcessTable,
    roots: &[(String, u32)],
    machine: MachineTotals,
) -> ResourcesSnapshot {
    let div = if machine.ncpus > 0 { machine.ncpus as f32 } else { 1.0 };
    let mut sessions = Vec::with_capacity(roots.len());
    let mut total_cpu = 0.0f32;
    let mut total_mem = 0u64;
    for (id, pid) in roots {
        let m = aggregate_subtree(table, *pid);
        let cpu = m.cpu / div;
        total_cpu += cpu;
        total_mem += m.mem_bytes;
        sessions.push(SessionMetric { id: id.clone(), cpu, mem_bytes: m.mem_bytes });
    }
    let ram_share = if machine.mem_total_bytes > 0 {
        total_mem as f32 / machine.mem_total_bytes as f32 * 100.0
    } else {
        0.0
    };
    ResourcesSnapshot {
        total_cpu,
        total_mem_bytes: total_mem,
        ram_share,
        mem_total_bytes: machine.mem_total_bytes,
        sessions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(pid: u32, parent: u32, cpu: f32, mem: u64) -> ProcSample {
        ProcSample { pid, parent_pid: parent, cpu, mem_bytes: mem }
    }

    #[test]
    fn subtree_sums_root_and_all_descendants() {
        let table = ProcessTable::from_samples(vec![
            sample(100, 1, 1.0, 10),
            sample(200, 100, 2.0, 20),
            sample(300, 200, 4.0, 40),
            sample(201, 100, 8.0, 80),
            sample(999, 1, 99.0, 990),
        ]);
        let m = aggregate_subtree(&table, 100);
        assert_eq!(m.cpu, 1.0 + 2.0 + 4.0 + 8.0);
        assert_eq!(m.mem_bytes, 10 + 20 + 40 + 80);
    }

    #[test]
    fn missing_root_contributes_zero_but_sums_its_children() {
        let table = ProcessTable::from_samples(vec![sample(600, 500, 3.0, 30)]);
        let m = aggregate_subtree(&table, 500);
        assert_eq!(m, ProcMetrics { cpu: 3.0, mem_bytes: 30 });
    }

    #[test]
    fn cycle_does_not_hang() {
        let table = ProcessTable::from_samples(vec![
            sample(1, 2, 1.0, 1),
            sample(2, 1, 1.0, 1),
        ]);
        let m = aggregate_subtree(&table, 1);
        assert_eq!(m.mem_bytes, 2);
    }

    #[test]
    fn snapshot_sums_sessions_and_normalizes_cpu_by_cores() {
        let table = ProcessTable::from_samples(vec![
            sample(10, 1, 200.0, 100_000_000),
            sample(20, 1, 200.0, 100_000_000),
        ]);
        let snap = build_snapshot(
            &table,
            &[("a".into(), 10), ("b".into(), 20)],
            MachineTotals { mem_total_bytes: 8_000_000_000, ncpus: 4 },
        );
        assert_eq!(snap.sessions[0].cpu, 50.0);
        assert_eq!(snap.sessions[0].mem_bytes, 100_000_000);
        assert_eq!(snap.total_cpu, 100.0);
        assert_eq!(snap.total_mem_bytes, 200_000_000);
        assert!((snap.ram_share - 2.5).abs() < 1e-3);
        assert_eq!(snap.mem_total_bytes, 8_000_000_000);
    }

    #[test]
    fn snapshot_guards_zero_cores_and_zero_total_ram() {
        let table = ProcessTable::from_samples(vec![sample(10, 1, 5.0, 5)]);
        let snap = build_snapshot(
            &table,
            &[("a".into(), 10)],
            MachineTotals { mem_total_bytes: 0, ncpus: 0 },
        );
        assert_eq!(snap.sessions[0].cpu, 5.0);
        assert_eq!(snap.ram_share, 0.0);
    }
}
