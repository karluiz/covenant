import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Source-of-truth version from package.json — exposed to the frontend
// as `__APP_VERSION__`. We also read CHANGELOG.md raw at config time
// and inline it as `__APP_CHANGELOG__` so the release-log modal can
// render it without a runtime fetch (Tauri webview file:// reads can
// fail on some macOS configs; inlining sidesteps the whole class).
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };
let changelog = "";
try {
  changelog = readFileSync(resolve(__dirname, "CHANGELOG.md"), "utf-8");
} catch {
  changelog = "# Changelog\n\nNo changelog file found at build time.";
}

// Vite is configured for Tauri:
//  - frontend root is `ui/` (entry: ui/index.html)
//  - build output goes to `<repo>/dist`, referenced by tauri.conf.json -> frontendDist
//  - clearScreen disabled so Rust errors stay visible
//  - port 1420 fixed (matches tauri.conf.json -> devUrl)
//  - src-tauri excluded from watch
export default defineConfig(async () => ({
  root: "ui",
  publicDir: false,
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_CHANGELOG__: JSON.stringify(changelog),
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "ui/index.html"),
        notch: resolve(__dirname, "ui/notch/index.html"),
        notchDev: resolve(__dirname, "ui/notch/dev.html"),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    // Explicit IPv4 loopback: `false` binds whatever `localhost` resolves
    // to first (often ::1 only), while the webview may pick 127.0.0.1 and
    // get connection-refused — cached index.html then paints the boot
    // splash forever with no JS. Must match tauri.conf.json devUrl.
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/crates/**", "**/target/**"],
    },
  },
}));
