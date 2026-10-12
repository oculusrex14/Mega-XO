#!/usr/bin/env python3
"""Generate deterministic, original Mega XOXO optional UI sound cues.

This tool uses only Python's standard library plus the locally installed
ffmpeg executable. It synthesizes short mono tones, writes 24-bit PCM WAV
masters, exports compact MP3/Ogg files, decodes and checks every output, and
performs a second generation pass to verify byte-for-byte repeatability.

Playback is intentionally not wired into the website. These files do not
autoplay; a future integration requires explicit opt-in, volume/mute controls,
and a silent fallback.
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "assets" / "p21" / "audio"
SAMPLE_RATE = 48_000
CHANNELS = 1
SAMPLE_WIDTH_BYTES = 3
PCM_POSITIVE_MAX = (1 << 23) - 1
TARGET_PEAK_DBFS = -14.0
TARGET_PEAK = 10.0 ** (TARGET_PEAK_DBFS / 20.0)
MAX_DURATION_SECONDS = 1.5
MAX_COMPRESSED_BYTES = 32_768
LEADING_SILENCE_SECONDS = 0.030
TRAILING_SILENCE_SECONDS = 0.040
EDGE_CHECK_SECONDS = 0.070
EDGE_MAX_STEP = 0.060
EXPORT_PEAK_LIMIT = 0.32
SCRIPT_VERSION = "1.0.0"

# Each event is (frequencies_hz, duration_seconds, gap_after_seconds, gain).
# Harmonic partials are intentionally very soft; all notes have smooth attack
# and release envelopes. These are new oscillator compositions, not samples.
CUES: dict[str, dict[str, Any]] = {
    "ui-select": {
        "label": "Soft two-note selection confirmation",
        "events": [([784.0], 0.115, 0.025, 1.0), ([988.0], 0.135, 0.0, 0.92)],
    },
    "placed-x": {
        "label": "Muted warm X placement chord",
        "events": [([523.25, 659.25], 0.175, 0.0, 0.72)],
    },
    "placed-o": {
        "label": "Muted bright O placement chord",
        "events": [([587.33, 739.99], 0.175, 0.0, 0.68)],
    },
    "victory": {
        "label": "Gentle rising major arpeggio",
        "events": [
            ([523.25], 0.135, 0.025, 0.82),
            ([659.25], 0.135, 0.025, 0.82),
            ([783.99], 0.145, 0.025, 0.82),
            ([1046.50], 0.180, 0.0, 0.82),
        ],
    },
    "loss": {
        "label": "Soft descending reflective phrase",
        "events": [
            ([440.00], 0.135, 0.025, 0.78),
            ([392.00], 0.135, 0.025, 0.78),
            ([349.23], 0.145, 0.025, 0.78),
            ([293.66], 0.170, 0.0, 0.78),
        ],
    },
    "rank-up": {
        "label": "Warm five-note upward milestone",
        "events": [
            ([392.00], 0.125, 0.025, 0.78),
            ([523.25], 0.125, 0.025, 0.78),
            ([659.25], 0.125, 0.025, 0.78),
            ([783.99], 0.135, 0.025, 0.78),
            ([1046.50], 0.165, 0.0, 0.78),
        ],
    },
    "invite": {
        "label": "Friendly two-pulse invitation",
        "events": [
            ([659.25], 0.130, 0.070, 0.78),
            ([880.00], 0.145, 0.070, 0.78),
            ([783.99], 0.155, 0.0, 0.74),
        ],
    },
    "queue-match": {
        "label": "Quiet rising match-found signal",
        "events": [
            ([587.33], 0.120, 0.035, 0.78),
            ([739.99], 0.130, 0.035, 0.78),
            ([880.00], 0.155, 0.0, 0.78),
        ],
    },
    "reward": {
        "label": "Bright but restrained reward cascade",
        "events": [
            ([659.25], 0.115, 0.025, 0.76),
            ([783.99], 0.115, 0.025, 0.76),
            ([987.77], 0.125, 0.025, 0.76),
            ([1174.66], 0.155, 0.0, 0.76),
        ],
    },
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def smoothstep(value: float) -> float:
    value = min(1.0, max(0.0, value))
    return value * value * (3.0 - 2.0 * value)


def render_event(freqs: list[float], duration: float, gain: float) -> list[float]:
    count = round(duration * SAMPLE_RATE)
    attack = min(0.014, duration * 0.22)
    release = min(0.060, duration * 0.42)
    samples: list[float] = []
    for index in range(count):
        time_s = index / SAMPLE_RATE
        attack_env = smoothstep(time_s / attack)
        release_env = smoothstep((duration - time_s) / release)
        envelope = attack_env * release_env
        tone = 0.0
        for frequency in freqs:
            # Soft second and third partials add a little body without a clicky
            # transient or the sharp high-frequency content of a hard bell.
            tone += 0.80 * math.sin(2.0 * math.pi * frequency * time_s)
            tone += 0.14 * math.sin(2.0 * math.pi * frequency * 2.0 * time_s)
            tone += 0.025 * math.sin(2.0 * math.pi * frequency * 3.0 * time_s)
        # Gentle natural decay keeps held notes from sounding like alarms.
        decay = math.exp(-time_s / 0.55)
        samples.append(tone * envelope * decay * gain)
    return samples


def render_cue(spec: dict[str, Any]) -> list[float]:
    lead = round(LEADING_SILENCE_SECONDS * SAMPLE_RATE)
    tail = round(TRAILING_SILENCE_SECONDS * SAMPLE_RATE)
    body: list[float] = []
    for freqs, duration, gap, gain in spec["events"]:
        body.extend(render_event(freqs, duration, gain))
        body.extend([0.0] * round(gap * SAMPLE_RATE))

    peak = max(abs(sample) for sample in body) if body else 0.0
    if peak <= 0.0 or not math.isfinite(peak):
        raise ValueError("synthesizer produced empty or non-finite audio")
    scale = TARGET_PEAK / peak
    samples = ([0.0] * lead) + [sample * scale for sample in body] + ([0.0] * tail)
    if any(not math.isfinite(sample) for sample in samples):
        raise ValueError("synthesizer produced non-finite samples")
    # Keep signed conversion away from the asymmetric int24 minimum.
    return [max(-1.0, min(1.0, sample)) for sample in samples]


def write_wav(path: Path, samples: list[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = bytearray()
    for sample in samples:
        value = max(-PCM_POSITIVE_MAX, min(PCM_POSITIVE_MAX, round(sample * PCM_POSITIVE_MAX)))
        pcm.extend(int(value).to_bytes(SAMPLE_WIDTH_BYTES, byteorder="little", signed=True))
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(CHANNELS)
        handle.setsampwidth(SAMPLE_WIDTH_BYTES)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(pcm)


def decode_with_ffmpeg(ffmpeg: str, path: Path) -> tuple[list[float], int]:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        str(path),
        "-map_metadata",
        "-1",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "pipe:1",
    ]
    result = subprocess.run(command, check=True, capture_output=True)
    raw = result.stdout
    if len(raw) % 4:
        raise ValueError(f"decoder returned a partial float frame for {path.name}")
    decoded = [sample[0] for sample in struct.iter_unpack("<f", raw)]
    if not decoded or any(not math.isfinite(sample) for sample in decoded):
        raise ValueError(f"decoded audio is empty or non-finite: {path.name}")
    return decoded, len(decoded)


def peak_dbfs(samples: list[float]) -> float:
    peak = max((abs(sample) for sample in samples), default=0.0)
    return 20.0 * math.log10(peak) if peak > 0.0 else float("-inf")


def edge_max_step(samples: list[float], seconds: float = EDGE_CHECK_SECONDS) -> float:
    edge = min(len(samples), round(seconds * SAMPLE_RATE))
    if edge < 2:
        return 0.0
    steps = []
    for left, right in zip(samples[:edge], samples[1:edge]):
        steps.append(abs(right - left))
    tail = samples[-edge:]
    for left, right in zip(tail, tail[1:]):
        steps.append(abs(right - left))
    return max(steps, default=0.0)


def validate_wave(path: Path, samples: list[float]) -> dict[str, Any]:
    with wave.open(str(path), "rb") as handle:
        params = handle.getparams()
        payload = handle.readframes(handle.getnframes())
    if (params.nchannels, params.sampwidth, params.framerate, params.comptype) != (
        CHANNELS,
        SAMPLE_WIDTH_BYTES,
        SAMPLE_RATE,
        "NONE",
    ):
        raise ValueError(f"unexpected PCM format: {path.name}")
    duration = params.nframes / params.framerate
    if duration > MAX_DURATION_SECONDS or duration <= 0.0:
        raise ValueError(f"master duration outside bounds: {path.name}: {duration:.3f}s")
    if len(payload) != params.nframes * SAMPLE_WIDTH_BYTES * CHANNELS:
        raise ValueError(f"truncated PCM payload: {path.name}")
    pcm_samples = [
        int.from_bytes(payload[offset:offset + SAMPLE_WIDTH_BYTES], byteorder="little", signed=True) / PCM_POSITIVE_MAX
        for offset in range(0, len(payload), SAMPLE_WIDTH_BYTES)
    ]
    if not pcm_samples or any(not math.isfinite(sample) for sample in pcm_samples):
        raise ValueError(f"PCM samples are empty or non-finite: {path.name}")
    # Both padding bands are digital zero; the first and last sample therefore
    # join silence without a waveform discontinuity.
    lead_frames = round(LEADING_SILENCE_SECONDS * SAMPLE_RATE)
    tail_frames = round(TRAILING_SILENCE_SECONDS * SAMPLE_RATE)
    if any(pcm_samples[:lead_frames]) or any(pcm_samples[-tail_frames:]):
        raise ValueError(f"expected clean leading/trailing silence: {path.name}")
    p_dbfs = peak_dbfs(pcm_samples)
    if p_dbfs > TARGET_PEAK_DBFS + 0.02 or p_dbfs < TARGET_PEAK_DBFS - 0.30:
        raise ValueError(f"master peak outside target band: {path.name}: {p_dbfs:.2f} dBFS")
    step = edge_max_step(pcm_samples)
    if step > EDGE_MAX_STEP:
        raise ValueError(f"edge step suggests a click: {path.name}: {step:.4f}")
    return {"duration_seconds": round(duration, 6), "peak_dbfs": round(p_dbfs, 3), "edge_max_step": round(step, 6)}


def ffmpeg_version(ffmpeg: str) -> str:
    result = subprocess.run([ffmpeg, "-version"], check=True, capture_output=True, text=True)
    first_line = result.stdout.splitlines()[0].strip()
    # Store only the version banner, never environment or filesystem context.
    return first_line.split(" Copyright ", 1)[0]


def encode_exports(ffmpeg: str, master: Path, mp3_path: Path, ogg_path: Path) -> None:
    base = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(master), "-map_metadata", "-1", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-fflags", "+bitexact"]
    mp3_command = base + ["-c:a", "libmp3lame", "-b:a", "96k", "-write_xing", "0", "-id3v2_version", "0", "-write_id3v1", "0", "-flags:a", "+bitexact", str(mp3_path)]
    # This bundled FFmpeg build exposes its native Vorbis encoder (which needs
    # two channels and is marked experimental), not libvorbis. Duplicate the
    # mono master to stereo for that encoder; decoding is checked after export.
    ogg_command = base + ["-ac", "2", "-c:a", "vorbis", "-strict", "-2", "-q:a", "2", "-flags:a", "+bitexact", str(ogg_path)]
    for command in (mp3_command, ogg_command):
        subprocess.run(command, check=True, capture_output=True)


def generate_pack(output_dir: Path, ffmpeg: str, ffmpeg_ver: str) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    tracks: list[dict[str, Any]] = []
    generated_files: list[Path] = []

    for track_number, (cue_id, spec) in enumerate(CUES.items(), start=1):
        samples = render_cue(spec)
        wav_path = output_dir / f"{cue_id}.wav"
        mp3_path = output_dir / f"{cue_id}.mp3"
        ogg_path = output_dir / f"{cue_id}.ogg"
        write_wav(wav_path, samples)
        encode_exports(ffmpeg, wav_path, mp3_path, ogg_path)

        wav_qa = validate_wave(wav_path, samples)
        export_qa: dict[str, Any] = {}
        for export_path, codec in ((mp3_path, "MP3 / libmp3lame, mono 96 kb/s"), (ogg_path, "Ogg Vorbis / native FFmpeg encoder marked experimental; stereo quality 2 via -strict -2")):
            if export_path.stat().st_size > MAX_COMPRESSED_BYTES:
                raise ValueError(f"compressed export exceeds byte limit: {export_path.name}")
            decoded, decoded_frames = decode_with_ffmpeg(ffmpeg, export_path)
            duration = decoded_frames / SAMPLE_RATE
            decoded_peak = max(abs(value) for value in decoded)
            if duration > MAX_DURATION_SECONDS + 0.12 or duration <= 0.0:
                raise ValueError(f"compressed duration outside bounds: {export_path.name}: {duration:.3f}s")
            if decoded_peak > EXPORT_PEAK_LIMIT:
                raise ValueError(f"compressed export peak too high: {export_path.name}: {peak_dbfs(decoded):.2f} dBFS")
            step = edge_max_step(decoded)
            if step > EDGE_MAX_STEP:
                raise ValueError(f"compressed export edge suggests a click: {export_path.name}: {step:.4f}")
            export_qa[export_path.suffix[1:]] = {
                "codec": codec,
                "duration_seconds": round(duration, 6),
                "decoded_peak_dbfs": round(peak_dbfs(decoded), 3),
                "edge_max_step": round(step, 6),
            }

        files: dict[str, Any] = {}
        for path in (wav_path, mp3_path, ogg_path):
            generated_files.append(path)
            files[path.suffix[1:]] = {
                "path": path.name,
                "sha256": sha256(path),
                "bytes": path.stat().st_size,
            }
        tracks.append(
            {
                "asset_id": f"P21-AUD-{track_number:03d}",
                "id": cue_id,
                "description": spec["label"],
                "master": wav_qa,
                "exports_qa": export_qa,
                "files": files,
            }
        )

    source_path = Path(__file__).resolve()
    manifest = {
        "schema_version": 1,
        "pack": "Mega XOXO optional-to-play UI cues",
        "generator_version": SCRIPT_VERSION,
        "provenance": {
            "source": "Original local procedural synthesis authored for this pack; pure sine oscillators with fixed soft partials/envelopes.",
            "third_party_audio": "None; no samples, loops, songs, or hosted generation service used.",
            "rights_note": "No third-party audio incorporated. Separate product, trademark, or owner clearance remains outside this technical provenance record.",
            "source_script": "scripts/p21/export-audio.py",
            "source_script_sha256": sha256(source_path),
        },
        "tools": {
            "python": sys.version.split()[0],
            "ffmpeg": ffmpeg_ver,
            "libraries": "Python standard library only",
        },
        "audio_quality": {
            "sample_rate_hz": SAMPLE_RATE,
            "channels": CHANNELS,
            "master_format": "WAV, signed 24-bit little-endian PCM (PCM_S24LE)",
            "master_peak_target_dbfs": TARGET_PEAK_DBFS,
            "maximum_master_duration_seconds": MAX_DURATION_SECONDS,
            "maximum_compressed_file_bytes": MAX_COMPRESSED_BYTES,
            "leading_silence_ms": round(LEADING_SILENCE_SECONDS * 1000),
            "trailing_silence_ms": round(TRAILING_SILENCE_SECONDS * 1000),
            "per_note_attack_ms": 14,
            "per_note_release_ms": 60,
            "edge_step_validation_limit": EDGE_MAX_STEP,
            "compressed_decode_peak_limit_linear": EXPORT_PEAK_LIMIT,
        },
        "activation": {
            "integrated_into_web_or_native_app": False,
            "autoplay": False,
            "default_playback": "not connected; no audio is requested or played by this asset pack",
            "future_requirement": "Explicit user opt-in, mute/volume controls, and an accessible silent fallback before any playback integration.",
        },
        "tracks": tracks,
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {"manifest": manifest, "generated_files": generated_files, "manifest_path": manifest_path}


def verify_repeatable(output_dir: Path, ffmpeg: str, ffmpeg_ver: str, generated: dict[str, Any]) -> None:
    expected: dict[str, str] = {
        path.name: sha256(path) for path in generated["generated_files"]
    }
    expected["manifest.json"] = sha256(generated["manifest_path"])
    # The transient comparison pack is created below the owned asset directory
    # and removed automatically; it never leaves a repository artifact behind.
    with tempfile.TemporaryDirectory(prefix=".repeatability-", dir=output_dir) as temp_name:
        second_dir = Path(temp_name) / "second-pass"
        second = generate_pack(second_dir, ffmpeg, ffmpeg_ver)
        actual = {path.name: sha256(path) for path in second["generated_files"]}
        actual["manifest.json"] = sha256(second["manifest_path"])
    if expected != actual:
        differences = sorted(name for name in expected.keys() | actual.keys() if expected.get(name) != actual.get(name))
        raise ValueError("repeat generation changed outputs: " + ", ".join(differences))


def main() -> int:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is unavailable; install nothing automatically and rerun when an approved local ffmpeg is available")
    ffmpeg_ver = ffmpeg_version(ffmpeg)
    generated = generate_pack(OUTPUT, ffmpeg, ffmpeg_ver)
    verify_repeatable(OUTPUT, ffmpeg, ffmpeg_ver, generated)
    total_bytes = sum(path.stat().st_size for path in generated["generated_files"])
    print(
        f"PASS: {len(CUES)} cues; {len(generated['generated_files'])} WAV/MP3/OGG files; "
        f"{total_bytes} audio bytes; decode/peak/duration/edge and repeatability checks passed."
    )
    print(f"Manifest: {generated['manifest_path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
