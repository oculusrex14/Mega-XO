#!/usr/bin/env python3
"""Validate and export a generated P21 hero source as a silent looping web asset."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = REPO_ROOT / "assets/p21/motion/hero-provider-source.mp4"
DEFAULT_OUTPUT = REPO_ROOT / "assets/p21/motion"


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, capture_output=True, text=True)


def probe(path: Path) -> dict:
    result = run([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ])
    return json.loads(result.stdout)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def has_encoder(codec: str) -> bool:
    result = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], check=True, capture_output=True, text=True)
    return codec in result.stdout


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Original provider MP4")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUTPUT, help="Owned P21 motion output directory")
    parser.add_argument("--crossfade", type=float, default=0.4, help="Tail-to-head seam overlap in seconds")
    args = parser.parse_args()

    source = args.source.resolve()
    out_dir = args.out_dir.resolve()
    if not source.is_file():
        parser.error(f"provider source does not exist: {source}")
    if args.crossfade < 0.1 or args.crossfade > 1.0:
        parser.error("crossfade must be between 0.1 and 1.0 seconds")
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        parser.error("ffmpeg and ffprobe must already be available; this script does not install tools")
    if not has_encoder("libx264") or not has_encoder("libvpx-vp9") or not has_encoder("png"):
        parser.error("the existing ffmpeg must include libx264, libvpx-vp9, and png encoders")

    source_info = probe(source)
    video_streams = [stream for stream in source_info.get("streams", []) if stream.get("codec_type") == "video"]
    if not video_streams:
        parser.error("provider source has no video stream")
    video = video_streams[0]
    width = int(video.get("width") or 0)
    height = int(video.get("height") or 0)
    duration = float(video.get("duration") or source_info.get("format", {}).get("duration") or 0)
    if not width or not height or abs((width / height) - (16 / 9)) > 0.025:
        parser.error(f"provider source is not a 16:9 video ({width}x{height})")
    if not 8.0 <= duration <= 12.0:
        parser.error(f"provider source duration must be 8–12 seconds, got {duration:.3f}")
    if args.crossfade * 2 >= duration:
        parser.error("crossfade is too long for the source duration")

    out_dir.mkdir(parents=True, exist_ok=True)
    final_mp4 = out_dir / "hero-loop.mp4"
    final_webm = out_dir / "hero-loop.webm"
    final_poster = out_dir / "hero-poster.png"
    fade_s = f"{args.crossfade:.6f}"
    tail_start = f"{duration - args.crossfade:.6f}"
    middle_duration = f"{duration - 2 * args.crossfade:.6f}"
    graph = (
        f"[0:v]fps=24,format=yuv420p,split=3[whole][head][tail];"
        f"[head]trim=start=0:duration={fade_s},setpts=PTS-STARTPTS,settb=AVTB[headclip];"
        f"[tail]trim=start={tail_start}:duration={fade_s},setpts=PTS-STARTPTS,settb=AVTB[tailclip];"
        f"[tailclip][headclip]xfade=transition=fade:duration={fade_s}:offset=0[seam];"
        f"[whole]trim=start={fade_s}:duration={middle_duration},setpts=PTS-STARTPTS,settb=AVTB[mid];"
        f"[seam][mid]concat=n=2:v=1:a=0[outv]"
    )

    with tempfile.TemporaryDirectory(prefix="p21-motion-") as temporary:
        temp = Path(temporary)
        stage_mp4 = temp / "hero-loop.mp4"
        stage_webm = temp / "hero-loop.webm"
        stage_poster = temp / "hero-poster.png"

        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
            "-filter_complex", graph, "-map", "[outv]", "-an", "-t", f"{duration - args.crossfade:.6f}",
            "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", str(stage_mp4),
        ])
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(stage_mp4),
            "-an", "-c:v", "libvpx-vp9", "-crf", "33", "-b:v", "0", "-row-mt", "0", "-threads", "1",
            "-pix_fmt", "yuv420p", str(stage_webm),
        ])
        poster_time = max(0.5, (duration - args.crossfade) / 2)
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{poster_time:.3f}",
            "-i", str(stage_mp4), "-frames:v", "1", "-vf", "scale=1280:-2:flags=lanczos",
            "-c:v", "png", str(stage_poster),
        ])

        for stage, final in ((stage_mp4, final_mp4), (stage_webm, final_webm), (stage_poster, final_poster)):
            stage.replace(final)

    outputs = []
    for path in (final_mp4, final_webm, final_poster):
        info = probe(path)
        video_out = next((stream for stream in info.get("streams", []) if stream.get("codec_type") == "video"), {})
        outputs.append({
            "file": path.name,
            "sha256": sha256(path),
            "bytes": path.stat().st_size,
            "width": video_out.get("width"),
            "height": video_out.get("height"),
            "duration_seconds": float(video_out.get("duration") or info.get("format", {}).get("duration") or 0),
            "codec": video_out.get("codec_name"),
            "audio_streams": sum(1 for stream in info.get("streams", []) if stream.get("codec_type") == "audio"),
        })
    report = {
        "source": {
            "file": source.name,
            "sha256": sha256(source),
            "bytes": source.stat().st_size,
            "width": width,
            "height": height,
            "duration_seconds": duration,
            "codec": video.get("codec_name"),
            "audio_streams": sum(1 for stream in source_info.get("streams", []) if stream.get("codec_type") == "audio"),
        },
        "export": {
            "fps": 24,
            "crossfade_seconds": args.crossfade,
            "silent_outputs": True,
            "outputs": outputs,
        },
    }
    print(json.dumps(report, indent=2))
    if any(item["audio_streams"] != 0 for item in outputs):
        parser.error("an exported web asset unexpectedly contains audio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
