//! Smoke test against the real ~/.claude on the host. Run with:
//!   cargo run -p karl-capabilities --example scan_real

use karl_capabilities::adapters::claude;

fn main() {
    let home = dirs_home();
    println!("scanning user scope at {}", home.display());
    let user = claude::scan_user(&home).expect("scan_user");
    println!("  user caps: {}", user.len());

    println!("scanning plugins…");
    let plugins = claude::scan_plugins(&home).expect("scan_plugins");
    println!("  plugin caps: {}", plugins.len());

    let mut skills = 0;
    let mut cmds = 0;
    let mut hooks = 0;
    let mut mcps = 0;
    for c in user.iter().chain(plugins.iter()) {
        match c {
            claude::Capability::Skill(_) => skills += 1,
            claude::Capability::SlashCommand(_) => cmds += 1,
            claude::Capability::Hook(_) => hooks += 1,
            claude::Capability::McpServer(_) => mcps += 1,
        }
    }
    println!("  skills={skills} commands={cmds} hooks={hooks} mcps={mcps}");

    if let Some(c) = plugins.iter().find_map(|c| {
        if let claude::Capability::Skill(s) = c {
            Some(s)
        } else {
            None
        }
    }) {
        println!(
            "\nsample plugin skill:\n  name={}\n  scope={:?}\n  path={}",
            c.name,
            c.scope,
            c.path.display()
        );
    }
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .expect("HOME unset")
}
