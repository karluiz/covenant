//! Pure metrics aggregation for the Resources panel. No system calls — the app
//! crate populates a `ProcessTable` from `sysinfo`; this crate only sums subtrees
//! and builds the snapshot, so it stays unit-testable.

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
pub struct ProcSample {
    pub pid: u32,
    pub parent_pid: u32,
    /// Logical process name (see [`friendly_proc_name`]).
    pub name: String,
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

/// Collect `root` and all its transitive descendants. Missing pids are skipped;
/// cycles are visited once.
fn collect_subtree<'a>(table: &'a ProcessTable, root: u32) -> Vec<&'a ProcSample> {
    let mut out = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(s) = table.by_pid.get(&pid) {
            out.push(s);
        }
        if let Some(kids) = table.children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    out
}

/// Sum cpu + memory over `root` and all its transitive descendants.
pub fn aggregate_subtree(table: &ProcessTable, root: u32) -> ProcMetrics {
    let mut out = ProcMetrics::default();
    for s in collect_subtree(table, root) {
        out.cpu += s.cpu;
        out.mem_bytes += s.mem_bytes;
    }
    out
}

/// A coalesced hot process inside a session subtree: all processes sharing a
/// logical name folded into one entry (`vitest ×10`), cpu already normalized
/// to the machine reading.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TopProc {
    pub name: String,
    pub cpu: f32,
    pub count: u32,
}

/// Cutoff below which a coalesced process is not worth surfacing (normalized %).
const TOP_PROC_MIN_CPU: f32 = 0.5;
const TOP_PROC_LIMIT: usize = 3;

fn top_procs(procs: &[&ProcSample], cpu_div: f32) -> Vec<TopProc> {
    let mut by_name: HashMap<&str, (f32, u32)> = HashMap::new();
    for s in procs {
        let e = by_name.entry(s.name.as_str()).or_default();
        e.0 += s.cpu;
        e.1 += 1;
    }
    let mut out: Vec<TopProc> = by_name
        .into_iter()
        .map(|(name, (cpu, count))| TopProc {
            name: name.to_string(),
            cpu: cpu / cpu_div,
            count,
        })
        .filter(|t| t.cpu >= TOP_PROC_MIN_CPU)
        .collect();
    out.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
    out.truncate(TOP_PROC_LIMIT);
    out
}

/// Resolve a logical name for a process: generic runtimes (`node`, `python`, …)
/// are mapped to the JS tool they host by scanning argv for a
/// `node_modules/<pkg>` or `node_modules/.bin/<tool>` path (`vitest`, `tsc`,
/// `vite`). Everything else keeps its kernel name.
pub fn friendly_proc_name<'a>(name: &str, args: impl Iterator<Item = &'a str>) -> String {
    const GENERIC: &[&str] = &["node", "python", "python3", "ruby", "deno", "bun"];
    if !GENERIC.contains(&name) {
        return name.to_string();
    }
    let mut args = args;
    args.find_map(tool_from_node_modules)
        .unwrap_or_else(|| name.to_string())
}

fn tool_from_node_modules(arg: &str) -> Option<String> {
    let rest = &arg[arg.find("node_modules/")? + "node_modules/".len()..];
    let mut segs = rest.split('/');
    let first = segs.next()?;
    let tool = match first {
        ".bin" => segs.next()?,
        s if s.starts_with('@') => segs.next()?,
        s => s,
    };
    let tool = tool
        .trim_end_matches(".cjs")
        .trim_end_matches(".mjs")
        .trim_end_matches(".js");
    (!tool.is_empty()).then(|| tool.to_string())
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
    /// Hottest coalesced processes in this session's subtree, cpu-desc.
    pub top: Vec<TopProc>,
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
    let div = if machine.ncpus > 0 {
        machine.ncpus as f32
    } else {
        1.0
    };
    let mut sessions = Vec::with_capacity(roots.len());
    let mut total_cpu = 0.0f32;
    let mut total_mem = 0u64;
    for (id, pid) in roots {
        let procs = collect_subtree(table, *pid);
        let mut m = ProcMetrics::default();
        for s in &procs {
            m.cpu += s.cpu;
            m.mem_bytes += s.mem_bytes;
        }
        let cpu = m.cpu / div;
        total_cpu += cpu;
        total_mem += m.mem_bytes;
        sessions.push(SessionMetric {
            id: id.clone(),
            cpu,
            mem_bytes: m.mem_bytes,
            top: top_procs(&procs, div),
        });
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
        named(pid, parent, "proc", cpu, mem)
    }

    fn named(pid: u32, parent: u32, name: &str, cpu: f32, mem: u64) -> ProcSample {
        ProcSample {
            pid,
            parent_pid: parent,
            name: name.into(),
            cpu,
            mem_bytes: mem,
        }
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
        assert_eq!(
            m,
            ProcMetrics {
                cpu: 3.0,
                mem_bytes: 30
            }
        );
    }

    #[test]
    fn cycle_does_not_hang() {
        let table = ProcessTable::from_samples(vec![sample(1, 2, 1.0, 1), sample(2, 1, 1.0, 1)]);
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
            MachineTotals {
                mem_total_bytes: 8_000_000_000,
                ncpus: 4,
            },
        );
        assert_eq!(snap.sessions[0].cpu, 50.0);
        assert_eq!(snap.sessions[0].mem_bytes, 100_000_000);
        assert_eq!(snap.total_cpu, 100.0);
        assert_eq!(snap.total_mem_bytes, 200_000_000);
        assert!((snap.ram_share - 2.5).abs() < 1e-3);
        assert_eq!(snap.mem_total_bytes, 8_000_000_000);
    }

    #[test]
    fn top_procs_coalesce_by_name_sort_by_cpu_and_drop_idle() {
        let table = ProcessTable::from_samples(vec![
            named(10, 1, "zsh", 0.1, 5),
            named(20, 10, "vitest", 120.0, 100),
            named(21, 10, "vitest", 100.0, 100),
            named(22, 10, "tsc", 240.0, 100),
            named(23, 10, "idle-helper", 0.2, 100),
        ]);
        let snap = build_snapshot(
            &table,
            &[("a".into(), 10)],
            MachineTotals {
                mem_total_bytes: 1,
                ncpus: 4,
            },
        );
        let top = &snap.sessions[0].top;
        assert_eq!(top.len(), 2, "zsh + idle-helper below cutoff: {top:?}");
        assert_eq!((top[0].name.as_str(), top[0].count), ("tsc", 1));
        assert_eq!((top[1].name.as_str(), top[1].count), ("vitest", 2));
        assert!((top[0].cpu - 60.0).abs() < 1e-3);
        assert!((top[1].cpu - 55.0).abs() < 1e-3);
    }

    #[test]
    fn friendly_name_resolves_js_tools_and_keeps_the_rest() {
        let vitest_worker = [
            "/opt/homebrew/bin/node",
            "--require",
            "/repo/node_modules/vitest/suppress-warnings.cjs",
            "/repo/node_modules/vitest/dist/workers/forks.js",
        ];
        assert_eq!(
            friendly_proc_name("node", vitest_worker.iter().copied()),
            "vitest"
        );
        let tsc = ["node", "/repo/node_modules/.bin/tsc"];
        assert_eq!(friendly_proc_name("node", tsc.iter().copied()), "tsc");
        let scoped = ["node", "/repo/node_modules/@angular/cli/bin/ng.js"];
        assert_eq!(friendly_proc_name("node", scoped.iter().copied()), "cli");
        let bare = ["node", "server.js"];
        assert_eq!(friendly_proc_name("node", bare.iter().copied()), "node");
        assert_eq!(friendly_proc_name("cargo", [].iter().copied()), "cargo");
    }

    #[test]
    fn snapshot_guards_zero_cores_and_zero_total_ram() {
        let table = ProcessTable::from_samples(vec![sample(10, 1, 5.0, 5)]);
        let snap = build_snapshot(
            &table,
            &[("a".into(), 10)],
            MachineTotals {
                mem_total_bytes: 0,
                ncpus: 0,
            },
        );
        assert_eq!(snap.sessions[0].cpu, 5.0);
        assert_eq!(snap.ram_share, 0.0);
    }
}
