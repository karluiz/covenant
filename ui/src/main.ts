// M0 placeholder frontend.
//
// Step 5 of M0 mounts xterm.js here and pipes bytes through the
// `spawn_session` / `write_to_session` Tauri commands. For now this file
// just renders a marker so we can confirm the webview boots.

const root = document.getElementById("app");
if (root) {
  root.textContent = "karl-terminal — webview alive (M0 stub)";
}
