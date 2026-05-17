import { listen } from "@tauri-apps/api/event";

console.log("[notch] window booted");
listen("notch://state", (ev) => {
  console.log("[notch] state", ev.payload);
});
