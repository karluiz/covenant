# Apple Feedback draft — frontmost app's mach receives gated for seconds after idle

> File under: macOS → Performance / Responsiveness. Attach
> `covenant-stall-2026-08-03.spindump.txt` (kept in
> `~/Library/Application Support/com.karluiz.covenant/backups/`).

## Title

Frontmost app's main thread and NSEventThread receive no mach messages for
up to 4.9s after a short idle period — user's click is delivered seconds
late (macOS 26.3, 25D125, Apple Silicon)

## Summary

On macOS 26.3, an app that has received no user input for tens of seconds
stops having mach messages delivered to its main thread and NSEventThread
entirely, even while the process is frontmost, unclamped, and its threads
hold user-interactive priority (pth_curpri 47). The block lasts until an
importance donation from WindowServer reaches the process — which we have
measured taking 1–5 seconds after the user's next click. The user's click
itself is not delivered until that donation lands, so the first interaction
after a short idle period visibly freezes the app (spinning cursor, no
frames) for 1–2.5 seconds.

## Steps to reproduce

1. Use any Tauri/WKWebView app (observed in our terminal app, Covenant) on
   macOS 26.3, Apple Silicon.
2. Leave the app unattended (no input to it) for 1–5 minutes while using
   another app.
3. Click a UI element in the app (e.g. a tab).
4. The app shows no new frame for 1–2.5s, then everything applies at once.

## Evidence (attached spindump, timeline mode, 2ms interval)

- Main thread: `<4875ms gap with no samples, process frontmost, process
  unclamped, priority 47 (47)>` — blocked in `mach_msg2_trap`, never made
  runnable. Wake carries `<thread QoS user interactive (promote default)>`.
- NSEventThread: identical 4875ms gap, then `<process received importance
  donation from WindowServer [391]>`, and only then
  `PullEventsFromWindowServerOnConnection` retrieves the pending click.
- During the gap we independently measured (in-app probes, 10Hz):
  - posted `run_on_main_thread` closures: run 1.2–2.3s late
  - `dispatch_async` to the main queue: same
  - a repeating 100ms `CFRunLoopTimer` (mk_timer): fires 1.2–2.1s late
  - main runloop mode sampled thread-safely: 100% `kCFRunLoopDefaultMode`
  - main thread `pth_curpri` via `thread_info`: constant 46–47
  - a sibling normal-priority thread in the same process wakes punctually
    every 100ms throughout.

## What we ruled out empirically before concluding this

WKWebView occlusion throttling (disabled via SPI — no change), App Nap
(`NSAppSleepDisabled` — no change), `NSProcessInfo beginActivityWithOptions:
UserInitiatedAllowingIdleSystemSleep|LatencyCritical` held for the process
lifetime — no change, runloop mode starvation (disproved by mode sampling),
priority decay (disproved by `pth_curpri`), AppKit UpdateCycle
(`NSApplicationUpdateCycleEnabled=NO` verified inert — no change),
self-posted `NSEvent`s to wake the loop (they ride the same gated path).

## Impact

Any latency-sensitive app (terminals, editors, chat) that the user
frequently returns to after brief idle periods shows a 1–2.5s freeze on the
first interaction. The behavior punishes precisely the "switch back to the
app and click" pattern.

## Regression note

Not observed by us on earlier macOS releases (the app's telemetry shows the
same first-interaction stall shape across macOS 26.x builds we have data
for; we cannot compare to macOS 15 directly).

## Request

If this is intended power management, provide a supported API for
latency-critical apps to opt out (the existing NSActivity options
measurably do not), or deliver the pending user event's importance donation
synchronously with the event enqueue rather than seconds later.
