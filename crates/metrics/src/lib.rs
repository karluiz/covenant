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
}
