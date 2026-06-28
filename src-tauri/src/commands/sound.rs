//! Native playback of terminal notification cues (issue #28 follow-up).
//!
//! These cues were originally synthesized (and custom files decoded) with the
//! Web Audio API inside the webview. On macOS WebKit idle-suspends an
//! `AudioContext` once the app is backgrounded or the machine goes idle, and a
//! cue's only trigger — a background terminal event — isn't a user gesture, so
//! the context can't revive itself and the cue plays nothing (#119, #167). A
//! pile of keep-alive / gesture-resume workarounds still lost the sound after a
//! stretch of inactivity. Playing in the host process sidesteps the webview
//! audio lifecycle entirely, so a cue still sounds after the machine's been idle.
//!
//! The five built-in tones are rendered here to PCM and mixed; `"custom"` plays
//! a user-supplied file decoded by `rodio`. Both go out through a short-lived
//! `rodio` output stream on a dedicated thread, so a slow device-open never
//! blocks the command and the stream is torn down once the cue finishes.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::thread;

use rodio::buffer::SamplesBuffer;
use rodio::{Decoder, OutputStream, Sink};

use crate::error::{AppError, AppResult};

/// Render rate for the synthesized tones (Hz). Custom files keep their own.
const SAMPLE_RATE: u32 = 44_100;

/// Largest custom notification sound we'll attempt to play. Mirrors the cap the
/// webview used to enforce before it read the bytes.
const MAX_SOUND_BYTES: u64 = 8 * 1024 * 1024;

/// Audio extensions a custom notification sound may use. Mirrors
/// `AUDIO_EXTENSIONS` in `src/lib/ipc.ts`; the authoritative guard since the
/// frontend picker's filter is UI-only.
const ALLOWED_SOUND_EXTS: &[&str] = &["wav", "mp3", "ogg", "m4a", "aac", "flac"];

/// Peak gain for a decoded custom sound — matches the web path's 0.8.
const CUSTOM_GAIN: f32 = 0.8;

/// Linear attack, then exponential decay to `FLOOR`, mirroring the Web Audio
/// envelope (`linearRampToValueAtTime` then `exponentialRampToValueAtTime`).
const ATTACK_SECS: f32 = 0.01;
const FLOOR: f32 = 0.0001;

#[derive(Clone, Copy)]
enum Wave {
    Sine,
    Square,
    Triangle,
}

/// One scheduled tone: frequency, start offset and duration (seconds), plus
/// waveform and peak gain. Mirrors `Tone` in `src/features/terminal/notify.ts`.
struct Tone {
    freq: f32,
    at: f32,
    dur: f32,
    wave: Wave,
    gain: f32,
}

/// The built-in sounds, each a short sequence of enveloped tones. Kept in lock
/// step with `SOUND_RECIPES` in `src/features/terminal/notify.ts`.
fn recipe(name: &str) -> Option<Vec<Tone>> {
    Some(match name {
        "chime" => vec![
            Tone {
                freq: 880.0,
                at: 0.0,
                dur: 0.18,
                wave: Wave::Sine,
                gain: 0.25,
            },
            Tone {
                freq: 1318.5,
                at: 0.12,
                dur: 0.28,
                wave: Wave::Sine,
                gain: 0.25,
            },
        ],
        "ping" => vec![Tone {
            freq: 1568.0,
            at: 0.0,
            dur: 0.16,
            wave: Wave::Sine,
            gain: 0.25,
        }],
        "blip" => vec![Tone {
            freq: 660.0,
            at: 0.0,
            dur: 0.09,
            wave: Wave::Square,
            gain: 0.18,
        }],
        "knock" => vec![
            Tone {
                freq: 180.0,
                at: 0.0,
                dur: 0.12,
                wave: Wave::Triangle,
                gain: 0.4,
            },
            Tone {
                freq: 150.0,
                at: 0.14,
                dur: 0.14,
                wave: Wave::Triangle,
                gain: 0.4,
            },
        ],
        "alert" => vec![
            Tone {
                freq: 988.0,
                at: 0.0,
                dur: 0.12,
                wave: Wave::Triangle,
                gain: 0.25,
            },
            Tone {
                freq: 988.0,
                at: 0.18,
                dur: 0.12,
                wave: Wave::Triangle,
                gain: 0.25,
            },
        ],
        _ => return None,
    })
}

/// One cycle of `wave` at the given phase (in cycles). Range [-1, 1].
fn waveform(wave: Wave, phase: f32) -> f32 {
    let frac = phase - phase.floor();
    match wave {
        Wave::Sine => (2.0 * std::f32::consts::PI * phase).sin(),
        Wave::Square => {
            if frac < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
        // /\ between +1 and -1 over one cycle.
        Wave::Triangle => 4.0 * (frac - 0.5).abs() - 1.0,
    }
}

/// Envelope amplitude at `t` seconds from the tone's start, given its peak gain
/// and duration: linear attack to `peak`, then exponential decay to `FLOOR`.
fn envelope(t: f32, peak: f32, dur: f32) -> f32 {
    if t < 0.0 || t > dur {
        return 0.0;
    }
    if t < ATTACK_SECS {
        return FLOOR + (peak - FLOOR) * (t / ATTACK_SECS);
    }
    let span = dur - ATTACK_SECS;
    if span <= 0.0 {
        return FLOOR;
    }
    // peak * (FLOOR/peak)^k — the continuous form of exponentialRampToValueAtTime.
    let k = (t - ATTACK_SECS) / span;
    peak * (FLOOR / peak).powf(k)
}

/// Render a recipe to a mono f32 PCM buffer at [`SAMPLE_RATE`], summing tones.
fn render(tones: &[Tone]) -> Vec<f32> {
    let total = tones.iter().map(|t| t.at + t.dur).fold(0.0_f32, f32::max) + 0.03; // brief tail so the last tone isn't clipped
    let n = (total * SAMPLE_RATE as f32).ceil() as usize;
    let mut buf = vec![0.0_f32; n];
    for tone in tones {
        let start = (tone.at * SAMPLE_RATE as f32) as usize;
        let len = (tone.dur * SAMPLE_RATE as f32).ceil() as usize;
        for i in 0..len {
            let idx = start + i;
            if idx >= n {
                break;
            }
            let t = i as f32 / SAMPLE_RATE as f32;
            let env = envelope(t, tone.gain, tone.dur);
            // Phase from the tone's own start so each tone begins at phase 0.
            buf[idx] += env * waveform(tone.wave, tone.freq * t);
        }
    }
    for s in buf.iter_mut() {
        *s = s.clamp(-1.0, 1.0);
    }
    buf
}

/// Validate a custom-sound path: allowed audio extension (the picker's filter is
/// UI-only and can't be trusted) and a size cap, so a tampered setting can't
/// point playback at an arbitrary file. Synchronous so the Settings "Test"
/// button gets immediate feedback
/// for a bad path; decode/playback errors surface later on the playback thread.
fn validate_sound_path(path: &str) -> AppResult<()> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ALLOWED_SOUND_EXTS.contains(&ext.as_str()) {
        return Err(AppError::Other("unsupported audio file type".into()));
    }
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(AppError::Other("not a file".into()));
    }
    if meta.len() > MAX_SOUND_BYTES {
        return Err(AppError::Other("file too large".into()));
    }
    Ok(())
}

/// What the playback thread should sound: a rendered built-in tone buffer, or a
/// custom file to decode. Both variants carry only `Send` data.
enum Job {
    Tones(Vec<f32>),
    File(String),
}

/// Play one cue to completion on the calling thread. Opens a fresh output
/// stream (kept alive until the cue ends), so device-open cost and teardown are
/// confined to this short-lived thread.
fn play_blocking(job: Job) -> AppResult<()> {
    let (_stream, handle) = OutputStream::try_default()
        .map_err(|e| AppError::Other(format!("no audio output device: {e}")))?;
    let sink = Sink::try_new(&handle).map_err(|e| AppError::Other(format!("audio sink: {e}")))?;
    match job {
        Job::Tones(samples) => sink.append(SamplesBuffer::new(1, SAMPLE_RATE, samples)),
        Job::File(path) => match File::open(&path).map_err(AppError::from).and_then(|f| {
            Decoder::new(BufReader::new(f)).map_err(|e| AppError::Other(format!("decode: {e}")))
        }) {
            Ok(source) => {
                sink.set_volume(CUSTOM_GAIN);
                sink.append(source);
            }
            // Unreadable / undecodable — fall back to a built-in tone so a real
            // event is never silently dropped (mirrors the old web fallback).
            Err(e) => {
                eprintln!("custom notification sound failed, falling back to chime: {e}");
                sink.append(SamplesBuffer::new(1, SAMPLE_RATE, render(&chime())));
            }
        },
    }
    sink.sleep_until_end();
    Ok(())
}

/// The chime recipe, used as the universal fallback. `recipe` always returns it.
fn chime() -> Vec<Tone> {
    recipe("chime").expect("chime recipe is always defined")
}

/// Play a terminal notification cue natively. `name` selects a built-in tone (an
/// unknown name falls back to "chime", matching the web default); `"custom"`
/// plays `custom_path`. Returns once the cue is *queued* — playback runs on a
/// dedicated thread so a slow device-open never blocks the command — so the only
/// errors surfaced here are a missing/invalid custom path (for the "Test"
/// button); decode/playback failures are logged and fall back on that thread.
#[tauri::command]
pub fn play_notification_sound(name: String, custom_path: Option<String>) -> AppResult<()> {
    let job = if name == "custom" {
        let path = custom_path.ok_or_else(|| AppError::Other("no custom sound chosen".into()))?;
        validate_sound_path(&path)?;
        Job::File(path)
    } else {
        Job::Tones(render(&recipe(&name).unwrap_or_else(chime)))
    };
    thread::spawn(move || {
        if let Err(e) = play_blocking(job) {
            eprintln!("notification sound playback failed: {e}");
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builtin_renders_non_empty_audio() {
        for name in ["chime", "ping", "blip", "knock", "alert"] {
            let tones = recipe(name).expect("builtin recipe defined");
            let pcm = render(&tones);
            assert!(!pcm.is_empty(), "{name} rendered no samples");
            assert!(
                pcm.iter().any(|s| s.abs() > 0.01),
                "{name} rendered silence"
            );
            assert!(
                pcm.iter().all(|s| s.is_finite() && s.abs() <= 1.0),
                "{name} produced out-of-range samples"
            );
        }
    }

    #[test]
    fn unknown_recipe_is_none_so_caller_falls_back() {
        assert!(recipe("does-not-exist").is_none());
    }

    #[test]
    fn envelope_starts_and_ends_quiet_and_peaks_in_between() {
        let dur = 0.2;
        assert!(envelope(0.0, 0.25, dur) <= FLOOR + 1e-6);
        assert!(envelope(ATTACK_SECS, 0.25, dur) > 0.2); // ~peak just after attack
        assert!(envelope(dur, 0.25, dur) < 0.01); // decayed to ~floor by the end
        assert_eq!(envelope(dur + 0.05, 0.25, dur), 0.0); // silent past the tone
    }

    #[test]
    fn unsupported_extension_is_rejected() {
        assert!(validate_sound_path("/tmp/notes.txt").is_err());
    }
}
