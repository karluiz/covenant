//! macOS: hold the process in the audio path so the kernel never wake-gates it.
//!
//! Continuation of the idle-switch saga (full ledger in main_lag.rs; filed
//! with Apple as FB24145989). The spindump proved macOS 26 withholds ALL mach
//! receives from an idle-classified process — even the user's click — until a
//! WindowServer importance donation propagates (1-5s). Every wake-side lever
//! failed, and the event keepalive (mac_wake.rs) only covers stretches where
//! session mouse events actually flow; reading quietly for two minutes
//! re-closes the gate.
//!
//! This module attacks the CLASSIFICATION instead: a process rendering audio
//! cannot be wake-gated without audible glitches, so coreaudiod keeps it
//! exempt. We loop a 1-second buffer of pure silence via AVAudioPlayer for
//! the app's lifetime — the "silent audio assertion" long used by apps that
//! must not be throttled.
//!
//! Fencing, per the user's explicit request (this is deliberately reversible):
//!   * Kill switch WITHOUT a rebuild:
//!       defaults write com.karluiz.covenant AudioKeepaliveDisabled -bool YES
//!     then relaunch. Delete the key to re-enable.
//!   * Whole feature is this one module + one call in lib.rs setup — removal
//!     is a two-line revert.
//!   * ponytail: exit contract — if the reading-idle-then-click vitals don't
//!     collapse, OR it shows up in battery/Now Playing complaints, OR Apple
//!     fixes FB24145989, this comes out.
//!
//! Honest cost, and its guard: an active audio context makes coreaudiod hold
//! `PreventUserIdleSystemSleep` (verified live in `pmset -g assertions`) — an
//! unguarded silent loop would keep the Mac awake forever. A watcher thread
//! therefore PAUSES the player after 10 minutes without any session input
//! event (fed by mac_wake's global monitor) and resumes it when activity
//! returns. While you use the machine, Covenant stays audio-classified; when
//! you walk away, the assertion drops and the Mac sleeps normally. The
//! trade: the first click after a 10+ minute absence falls back to today's
//! gated behavior — rarer and more tolerable than the read-two-minutes case
//! this exists to fix.

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use objc2::class;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    /// Pause the silent loop after this long without a session input event,
    /// so the audio sleep assertion drops and the Mac can sleep.
    const ABSENCE_PAUSE_MS: i64 = 10 * 60 * 1000;
    const GUARD_TICK: Duration = Duration::from_secs(30);

    static PLAYER: AtomicUsize = AtomicUsize::new(0);

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    // Force-link AVFoundation so class!(AVAudioPlayer) resolves.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// Canonical 44-byte PCM WAV of pure silence: mono, 8kHz, 16-bit, 1s.
    /// Generated in memory — no asset to ship.
    pub fn silent_wav() -> Vec<u8> {
        const SAMPLE_RATE: u32 = 8_000;
        const SECONDS: u32 = 1;
        let data_len: u32 = SAMPLE_RATE * SECONDS * 2; // 16-bit mono
        let mut w = Vec::with_capacity(44 + data_len as usize);
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + data_len).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
        w.extend_from_slice(&1u16.to_le_bytes()); // PCM
        w.extend_from_slice(&1u16.to_le_bytes()); // mono
        w.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        w.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
        w.extend_from_slice(&2u16.to_le_bytes()); // block align
        w.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        w.extend_from_slice(b"data");
        w.extend_from_slice(&data_len.to_le_bytes());
        w.resize(44 + data_len as usize, 0);
        w
    }

    unsafe fn nsstring(s: &str) -> *mut AnyObject {
        let alloc: *mut AnyObject = msg_send![class!(NSString), alloc];
        // 4 = NSUTF8StringEncoding
        msg_send![
            alloc,
            initWithBytes: s.as_ptr() as *const c_void,
            length: s.len(),
            encoding: 4usize
        ]
    }

    pub fn install() {
        unsafe {
            let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
            let key = nsstring("AudioKeepaliveDisabled");
            let disabled: bool = msg_send![defaults, boolForKey: key];
            if disabled {
                tracing::info!("audio keepalive disabled via AudioKeepaliveDisabled default");
                return;
            }
            let wav = silent_wav();
            let data: *mut AnyObject = msg_send![
                class!(NSData),
                dataWithBytes: wav.as_ptr() as *const c_void,
                length: wav.len()
            ];
            let alloc: *mut AnyObject = msg_send![class!(AVAudioPlayer), alloc];
            let mut err: *mut AnyObject = std::ptr::null_mut();
            let player: *mut AnyObject = msg_send![alloc, initWithData: data, error: &mut err];
            if player.is_null() {
                tracing::warn!("audio keepalive: AVAudioPlayer init failed — inactive");
                return;
            }
            let _: () = msg_send![player, setNumberOfLoops: -1isize];
            let _: bool = msg_send![player, prepareToPlay];
            let playing: bool = msg_send![player, play];
            // Hold the player for the process lifetime.
            let held: *mut AnyObject = msg_send![player, retain];
            PLAYER.store(held as usize, Ordering::Relaxed);
            if playing {
                tracing::info!("silent audio keepalive playing");
            } else {
                tracing::warn!("audio keepalive: play() returned false — inactive");
            }
        }
        spawn_absence_guard();
    }

    /// Pause during user absence (assertion drops, Mac can sleep); resume on
    /// activity. Session activity comes from mac_wake's global monitor ring.
    fn spawn_absence_guard() {
        let spawned = std::thread::Builder::new()
            .name("audio-keepalive-guard".into())
            .spawn(|| loop {
                std::thread::sleep(GUARD_TICK);
                let player = PLAYER.load(Ordering::Relaxed) as *mut AnyObject;
                if player.is_null() {
                    return;
                }
                let now = now_ms();
                let user_present = crate::mac_wake::last_event_before(now)
                    .is_some_and(|t| now - t <= ABSENCE_PAUSE_MS);
                unsafe {
                    let playing: bool = msg_send![player, isPlaying];
                    if playing && !user_present {
                        let _: () = msg_send![player, pause];
                        tracing::info!("audio keepalive paused (user absent)");
                    } else if !playing && user_present {
                        let ok: bool = msg_send![player, play];
                        tracing::info!(ok, "audio keepalive resumed (user active)");
                    }
                }
            });
        if let Err(e) = spawned {
            tracing::warn!(?e, "could not spawn audio keepalive guard");
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::install;

#[cfg(not(target_os = "macos"))]
pub fn install() {}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::imp::silent_wav;

    #[test]
    fn wav_header_is_canonical_pcm_silence() {
        let w = silent_wav();
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(&w[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes([w[20], w[21]]), 1); // PCM
        assert_eq!(u16::from_le_bytes([w[22], w[23]]), 1); // mono
        assert_eq!(u32::from_le_bytes([w[24], w[25], w[26], w[27]]), 8_000);
        assert_eq!(&w[36..40], b"data");
        let data_len = u32::from_le_bytes([w[40], w[41], w[42], w[43]]) as usize;
        assert_eq!(w.len(), 44 + data_len);
        // Every sample is zero — actual silence, not just low volume.
        assert!(w[44..].iter().all(|&b| b == 0));
    }
}
