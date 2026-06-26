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

use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Force one immediate sample + emit, regardless of the active flag (the ↻ button).
#[tauri::command]
pub async fn resources_sample_now(app: AppHandle) -> Result<(), String> {
    emit_one(&app).await;
    Ok(())
}

/// Start/stop the live sampler loop (panel mount/unmount).
#[tauri::command]
pub async fn resources_set_active(app: AppHandle, active: bool) -> Result<(), String> {
    app.state::<crate::AppState>().resources.set_active(active);
    if active {
        emit_one(&app).await;
    }
    Ok(())
}

/// Collect the live session roots (id, pid) from the registry.
async fn session_roots(app: &AppHandle) -> Vec<(String, u32)> {
    let state = app.state::<crate::AppState>();
    let sessions = state.sessions.lock().await;
    sessions
        .iter()
        .filter_map(|(id, managed)| managed.session.pid().map(|pid| (id.0.to_string(), pid)))
        .collect()
}

/// Refresh sysinfo (memory + cpu + processes; cpu is a delta so refresh twice) and emit a snapshot.
async fn emit_one(app: &AppHandle) {
    let roots = session_roots(app).await;
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing()
            .with_processes(ProcessRefreshKind::everything())
            .with_memory(MemoryRefreshKind::everything())
            .with_cpu(CpuRefreshKind::everything()),
    );
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    // second refresh after the minimum cpu interval gives a real cpu delta
    tokio::time::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL).await;
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.refresh_memory();
    sys.refresh_cpu_all();
    let snap = snapshot(&sys, &roots);
    let _ = app.emit("resources_update", &snap);
}

/// Spawn the background sampler. Ticks ~1.5s, but only emits while active.
pub fn spawn_sampler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(1500));
        loop {
            tick.tick().await;
            // `interval`'s first tick fires immediately, and the sampler is
            // spawned before `AppState` is managed in setup. `state()` panics
            // when the type isn't registered yet, which aborts the whole app at
            // launch — use `try_state` and skip until it's available.
            let Some(state) = app.try_state::<crate::AppState>() else {
                continue;
            };
            if state.resources.is_active() {
                emit_one(&app).await;
            }
        }
    });
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
        assert!(
            snap.mem_total_bytes > 0,
            "machine RAM total should be known"
        );
        assert!(
            snap.sessions[0].mem_bytes > 0,
            "our own process uses memory"
        );
    }
}
