//! Resources panel backend: samples per-session process subtrees via `sysinfo`
//! and emits `resources_update` events while the panel is active.

use karl_metrics::{build_snapshot, MachineTotals, ProcSample, ProcessTable, ResourcesSnapshot};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, ProcessRefreshKind, RefreshKind, System};

/// Build a `ProcessTable` from a refreshed `sysinfo::System`.
fn table_from_system(sys: &System) -> ProcessTable {
    let samples = sys
        .processes()
        .iter()
        .map(|(pid, proc_)| ProcSample {
            pid: pid.as_u32(),
            parent_pid: proc_.parent().map(|p| p.as_u32()).unwrap_or(0),
            cpu: proc_.cpu_usage(),
            mem_bytes: proc_.memory(), // sysinfo >= 0.30 returns bytes
        })
        .collect();
    ProcessTable::from_samples(samples)
}

/// Sample the given session roots into a snapshot. `sys` must already have had
/// processes + cpu refreshed at least twice (cpu usage is a delta).
pub fn snapshot(sys: &System, roots: &[(String, u32)]) -> ResourcesSnapshot {
    let table = table_from_system(sys);
    let machine = MachineTotals {
        mem_total_bytes: sys.total_memory(),
        ncpus: sys.cpus().len(),
    };
    build_snapshot(&table, roots, machine)
}

/// Shared on/off switch for the sampler loop, flipped by the Tauri commands.
#[derive(Clone, Default)]
pub struct ResourcesState {
    active: Arc<AtomicBool>,
}

impl ResourcesState {
    pub fn set_active(&self, on: bool) {
        self.active.store(on, Ordering::Relaxed);
    }
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_over_real_system_has_machine_totals() {
        let mut sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_processes(ProcessRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything())
                .with_cpu(CpuRefreshKind::everything()),
        );
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let me = std::process::id();
        let snap = snapshot(&sys, &[("self".into(), me)]);
        assert!(snap.mem_total_bytes > 0, "machine RAM total should be known");
        assert!(snap.sessions[0].mem_bytes > 0, "our own process uses memory");
    }
}
