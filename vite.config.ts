import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

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
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "esnext",
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
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
