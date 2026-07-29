#![cfg(unix)]
//! Look up the foreground process group name for a PTY master fd.
//! Used by the idle detector to know which CLI is currently in front.

use std::os::fd::RawFd;

/// Returns the executable name (basename, no path) of the process group
/// currently in the foreground of the PTY whose master fd is given,
/// or `None` if it cannot be determined (other OS, dead child, etc.).
///
/// When the kernel-reported name is a generic runtime (`node`, `python`,
/// `python3`, `ruby`), we peek at the process's argv to recover the
/// logical CLI name (e.g. `copilot`, `claude`, `opencode`, `aider`,
/// `hermes`). Without this, runtime-hosted agent CLIs get reported as
/// `node`/`python` and slip past the busy-dot allowlist exclusion.
#[cfg(target_os = "macos")]
pub fn foreground_process_name(master_fd: RawFd) -> Option<String> {
    let pgid = unsafe { libc::tcgetpgrp(master_fd) };
    if pgid <= 0 {
        tracing::trace!(master_fd, pgid, "tcgetpgrp returned non-positive");
        return None;
    }
    let comm = libproc::proc_pid::name(pgid)
        .map_err(|e| tracing::trace!(pgid, error = %e, "libproc::name failed"))
        .ok()?;
    // Some CLIs (Claude Code v2.1+) overwrite their own comm with their
    // version string (e.g. "2.1.143"). Always try argv when comm doesn't
    // already match a known logical CLI — covers both runtime-hosted
    // agents (`node`, `python`) and self-renamed binaries.
    let comm_is_known = LOGICAL_CLIS.iter().any(|c| comm.contains(c));
    if !comm_is_known || is_generic_runtime(&comm) {
        if let Some(logical) = logical_name_from_argv(pgid) {
            return Some(logical);
        }
    }
    Some(comm)
}

#[cfg(not(target_os = "macos"))]
pub fn foreground_process_name(_master_fd: RawFd) -> Option<String> {
    None
}

fn is_generic_runtime(comm: &str) -> bool {
    matches!(
        comm,
        "node" | "python" | "python3" | "ruby" | "deno" | "bun"
    )
}

/// Known agent / interactive CLIs we want to surface by their logical
/// name rather than the runtime that hosts them.
const LOGICAL_CLIS: &[&str] = &[
    "copilot",
    "claude",
    "opencode",
    "aider",
    "codex",
    "cursor-agent",
    "gemini",
    "hermes",
    "ollama",
    "pi",
];

fn logical_name_from_arg(arg: &str) -> Option<&'static str> {
    let basename = arg.rsplit('/').next().unwrap_or(arg);
    for cli in LOGICAL_CLIS {
        if *cli == "pi" {
            // Pi's npm/shebang process often reports as `node` with either
            // argv[1] = `/.../bin/pi` or a realpath under `pi-coding-agent`.
            // Keep this exact/package-scoped so random paths like
            // `pi-clipboard-*.png` don't get mistaken for the Pi CLI.
            if basename == "pi" || basename == "pi.js" || arg.contains("pi-coding-agent") {
                return Some("pi");
            }
        } else if *cli == "cursor-agent" {
            // Cursor's CLI: the `agent` launcher script execs its bundled
            // node with argv[0] = the invoked path, so comm is that path
            // truncated to 16 chars. Match the invoked basename (`agent`,
            // exact — it's too generic for contains) or the install path,
            // and report the canonical executor name "cursor".
            if basename == "agent" || basename == "cursor-agent" || arg.contains("cursor-agent") {
                return Some("cursor");
            }
        } else if basename.contains(cli) {
            return Some(*cli);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn logical_name_from_argv(pid: i32) -> Option<String> {
    let argv = read_proc_argv(pid)?;
    for arg in &argv {
        if let Some(cli) = logical_name_from_arg(arg) {
            return Some(cli.to_string());
        }
    }
    None
}

/// Read argv of `pid` via `sysctl(KERN_PROCARGS2)`. Layout:
///   [argc: i32][exec_path: cstr][NUL padding][argv[0] cstr]...[argv[argc-1] cstr][env...]
#[cfg(target_os = "macos")]
fn read_proc_argv(pid: i32) -> Option<Vec<String>> {
    let mut argmax: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            &mut argmax as *mut _ as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || argmax <= 0 {
        return None;
    }

    let mut buf: Vec<u8> = vec![0u8; argmax as usize];
    let mut size = buf.len();
    let mut mib2 = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let rc = unsafe {
        libc::sysctl(
            mib2.as_mut_ptr(),
            3,
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size < 4 {
        return None;
    }
    buf.truncate(size);

    let argc = i32::from_ne_bytes(buf[..4].try_into().ok()?);
    if argc <= 0 {
        return None;
    }

    let mut cursor = 4usize;
    while cursor < buf.len() && buf[cursor] != 0 {
        cursor += 1;
    }
    while cursor < buf.len() && buf[cursor] == 0 {
        cursor += 1;
    }

    let mut argv = Vec::with_capacity(argc as usize);
    for _ in 0..argc {
        if cursor >= buf.len() {
            break;
        }
        let start = cursor;
        while cursor < buf.len() && buf[cursor] != 0 {
            cursor += 1;
        }
        if let Ok(s) = std::str::from_utf8(&buf[start..cursor]) {
            argv.push(s.to_string());
        }
        cursor += 1;
    }
    Some(argv)
}

/// A dev server found under a session's process tree. The port is what
/// makes it identifiable — three tabs running `node` are three identical
/// strings, but `:1420` is the one you were looking for.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BusyServer {
    /// Logical name — argv-derived when possible (`node …/vite.js` → "vite").
    pub name: String,
    /// Lowest port it holds in LISTEN. `None` when the socket closed
    /// between the walk and the read.
    pub port: Option<u16>,
    pub pid: u32,
}

/// A live dev server somewhere under `root_pid`'s process tree: BFS the
/// descendants and report the first process whose (logical) name passes
/// `is_busy` AND that holds a TCP socket in LISTEN state. The listen
/// check is what discriminates "an app is serving" from build churn or
/// the brief subprocesses agent CLIs spawn. Agent CLIs themselves
/// (claude, codex, …) are walked *through* but never reported — a dev
/// server they started counts, they don't.
#[cfg(target_os = "macos")]
pub fn busy_server_descendant(root_pid: u32, is_busy: &dyn Fn(&str) -> bool) -> Option<BusyServer> {
    use libproc::processes::{pids_by_type, ProcFilter};
    let mut queue = vec![root_pid];
    // ponytail: 64-process cap bounds the walk; a session subtree past
    // that is pathological and the dot just stays off.
    let mut budget = 64usize;
    while let Some(pid) = queue.pop() {
        let children = pids_by_type(ProcFilter::ByParentProcess { ppid: pid }).unwrap_or_default();
        for &child in &children {
            if budget == 0 {
                return None;
            }
            budget -= 1;
            queue.push(child);
            let cpid = child as i32;
            let Ok(comm) = libproc::proc_pid::name(cpid) else {
                continue;
            };
            // Never report an agent CLI — including self-renamed comms
            // (Claude Code) and runtime-hosted ones (node → copilot).
            if LOGICAL_CLIS.iter().any(|c| comm.contains(c))
                || logical_name_from_argv(cpid).is_some()
            {
                continue;
            }
            // Prefer an argv-derived name (node running vite.js → "vite")
            // over the generic runtime comm.
            let display =
                busy_name_from_argv(cpid, is_busy).or_else(|| is_busy(&comm).then(|| comm.clone()));
            if let Some(name) = display {
                // The LISTEN walk is the gate AND the source of the port —
                // one pass, not a detection followed by a lookup.
                if let Some(ports) = listening_ports(cpid) {
                    return Some(BusyServer {
                        name,
                        // Lowest wins: vite's HMR socket is a real second
                        // listener, and :1420 is the one a human types.
                        port: ports.iter().copied().min(),
                        pid: child,
                    });
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
pub fn busy_server_descendant(
    _root_pid: u32,
    _is_busy: &dyn Fn(&str) -> bool,
) -> Option<BusyServer> {
    None
}

/// First argv element whose basename (with or without extension) passes
/// `is_busy` — recovers the logical tool name for runtime-hosted servers
/// (`node …/vite/bin/vite.js` → "vite").
#[cfg(target_os = "macos")]
fn busy_name_from_argv(pid: i32, is_busy: &dyn Fn(&str) -> bool) -> Option<String> {
    let argv = read_proc_argv(pid)?;
    for arg in &argv {
        let basename = arg.rsplit('/').next().unwrap_or(arg);
        if is_busy(basename) {
            return Some(basename.to_string());
        }
        let stem = basename.split('.').next().unwrap_or(basename);
        if is_busy(stem) {
            return Some(stem.to_string());
        }
    }
    None
}

/// True when `pid` holds at least one TCP socket in LISTEN state.
#[cfg(target_os = "macos")]
fn listening_ports(pid: i32) -> Option<Vec<u16>> {
    use libproc::bsd_info::BSDInfo;
    use libproc::file_info::{pidfdinfo, ListFDs, ProcFDType};
    use libproc::net_info::{SocketFDInfo, SocketInfoKind, TcpSIState};
    use libproc::proc_pid::{listpidinfo, pidinfo};
    let info = pidinfo::<BSDInfo>(pid, 0).ok()?;
    let fds = listpidinfo::<ListFDs>(pid, info.pbi_nfiles as usize).ok()?;
    let mut ports = Vec::new();
    for fd in fds {
        if !matches!(ProcFDType::from(fd.proc_fdtype), ProcFDType::Socket) {
            continue;
        }
        let Ok(sock) = pidfdinfo::<SocketFDInfo>(pid, fd.proc_fd) else {
            continue;
        };
        if matches!(SocketInfoKind::from(sock.psi.soi_kind), SocketInfoKind::Tcp) {
            // SAFETY: soi_kind == Tcp guarantees the union holds pri_tcp.
            let tcp = unsafe { sock.psi.soi_proto.pri_tcp };
            if matches!(TcpSIState::from(tcp.tcpsi_state), TcpSIState::Listen) {
                ports.push(port_from_network_order(tcp.tcpsi_ini.insi_lport));
            }
        }
    }
    // Some(vec![]) is impossible by construction: an empty vec means no
    // LISTEN socket, which is None — "this process is not serving".
    (!ports.is_empty()).then_some(ports)
}

/// `insi_lport` is a `c_int` holding a port in NETWORK byte order. Read it
/// raw on a little-endian machine and every server on :1420 reports 35850.
#[cfg(target_os = "macos")]
fn port_from_network_order(lport: libc::c_int) -> u16 {
    u16::from_be(lport as u32 as u16)
}

/// Send a signal to the foreground process group of the PTY whose master
/// fd is given. Used to kill the entire foreground process tree (e.g.
/// `npm run tauri:dev` plus its descendants) when the user hits the
/// force-kill shortcut. Returns the pgid on success.
pub fn kill_foreground_pgrp(master_fd: RawFd, signal: i32) -> std::io::Result<i32> {
    let pgid = unsafe { libc::tcgetpgrp(master_fd) };
    if pgid <= 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("tcgetpgrp returned {pgid}"),
        ));
    }
    let rc = unsafe { libc::killpg(pgid, signal) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(pgid)
}

/// Return true if `pgid` still has at least one live process.
pub fn pgrp_alive(pgid: i32) -> bool {
    unsafe { libc::killpg(pgid, 0) == 0 }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::{PtySession, SpawnOptions};

    #[tokio::test]
    async fn returns_shell_name_for_idle_zsh() {
        let opts = SpawnOptions::zsh_interactive();
        let (session, _rx) = PtySession::spawn(opts).expect("spawn zsh");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let name = foreground_process_name(session.master_fd());
        assert_eq!(name.as_deref(), Some("zsh"), "got {name:?}");
    }

    #[test]
    fn busy_server_descendant_finds_listening_child_and_ignores_non_listeners() {
        // A sleeping child matches the name filter but listens on nothing.
        let mut idle = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let is_sleep = |n: &str| n == "sleep";
        assert_eq!(
            busy_server_descendant(std::process::id(), &is_sleep),
            None,
            "non-listening process must not light the dot"
        );

        // A real listener (python http.server on an ephemeral port) must.
        let mut server = std::process::Command::new("/usr/bin/python3")
            .args(["-m", "http.server", "0", "--bind", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn python http.server");
        let is_py = |n: &str| n == "python3" || n == "Python";
        let mut found = None;
        for _ in 0..40 {
            found = busy_server_descendant(std::process::id(), &is_py);
            if found.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = server.kill();
        let _ = server.wait();
        let _ = idle.kill();
        let _ = idle.wait();
        let found = found.expect("listening python server not detected");
        assert!(is_py(&found.name), "unexpected name {:?}", found.name);
        // The port is the whole point of the walk now — a listener with no
        // port reported means the socket read regressed to a bare bool.
        assert!(found.port.is_some(), "listener reported without a port");
        assert!(found.pid > 0);
    }

    /// The byte-order guard. `insi_lport` is network order; read raw on a
    /// little-endian machine a server on :1420 reports 35850. Binding a
    /// listener whose port we already know is the only way to catch it.
    #[test]
    fn listening_ports_reports_the_real_port_not_the_byte_swapped_one() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let expected = listener.local_addr().expect("addr").port();

        let ports =
            listening_ports(std::process::id() as i32).expect("this process holds a LISTEN socket");

        assert!(
            ports.contains(&expected),
            "expected {expected} among {ports:?} — byte order?"
        );
    }

    #[test]
    fn network_order_port_round_trips() {
        // 1420 = 0x058C. Stored network-order in an int on a LE machine it
        // reads back raw as 0x8C05 = 35845.
        assert_eq!(port_from_network_order(0x8C05), 1420);
        assert_eq!(port_from_network_order(0x901F), 8080); // 0x1F90
    }

    #[test]
    fn argv_of_self_is_readable() {
        let pid = std::process::id() as i32;
        let argv = read_proc_argv(pid).expect("read_proc_argv self");
        assert!(!argv.is_empty(), "argv should not be empty");
    }

    #[test]
    fn logical_match_recognises_copilot_path() {
        assert_eq!(
            logical_name_from_arg("/usr/local/bin/copilot.js"),
            Some("copilot")
        );
    }

    #[test]
    fn logical_match_recognises_hermes_venv_entrypoint() {
        assert_eq!(
            logical_name_from_arg("/Users/me/.hermes/hermes-agent/venv/bin/hermes"),
            Some("hermes")
        );
    }

    #[test]
    fn logical_match_canonicalizes_cursor_cli_to_cursor() {
        // The `agent` launcher execs bundled node with argv[0] = the
        // invoked path; both that and the install path must map to
        // "cursor", never the raw binary name.
        assert_eq!(
            logical_name_from_arg("/Users/me/.local/bin/agent"),
            Some("cursor")
        );
        assert_eq!(
            logical_name_from_arg(
                "/Users/me/.local/share/cursor-agent/versions/2026.07.23/index.js"
            ),
            Some("cursor")
        );
        // Bare `agent` is exact-match only — no contains false-positives.
        assert_eq!(logical_name_from_arg("/usr/bin/user-agent-tool"), None);
    }

    #[test]
    fn logical_match_recognises_pi_npm_entrypoints_without_false_clipboard_hit() {
        assert_eq!(logical_name_from_arg("/opt/homebrew/bin/pi"), Some("pi"));
        assert_eq!(
            logical_name_from_arg(
                "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
            ),
            Some("pi")
        );
        assert_eq!(
            logical_name_from_arg("/var/folders/tmp/pi-clipboard-123.png"),
            None
        );
    }
}
