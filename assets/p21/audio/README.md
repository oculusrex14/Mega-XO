# Optional UI audio cues

This pack contains nine short, original, locally synthesized cues for the P21.06 audio rows. WAV files are the retained 48 kHz, mono, signed 24-bit PCM masters. MP3 and Ogg Vorbis files are compact web exports. Exact durations, peaks, byte counts, tool versions, provenance, and per-file SHA-256 hashes are in `manifest.json`.

This machine's FFmpeg build exposes its native Vorbis encoder, which is marked experimental and requires `-strict -2`; the generated Ogg files are decoded and bounds-checked by the exporter. This technical check is not browser, device, or human listening acceptance.

| Asset ID | Cue | Purpose |
|---|---|---|
| P21-AUD-001 | `ui-select` | Soft two-note selection confirmation |
| P21-AUD-002 | `placed-x` | Muted warm X placement chord |
| P21-AUD-003 | `placed-o` | Muted bright O placement chord |
| P21-AUD-004 | `victory` | Gentle rising major arpeggio |
| P21-AUD-005 | `loss` | Soft descending reflective phrase |
| P21-AUD-006 | `rank-up` | Warm five-note upward milestone |
| P21-AUD-007 | `invite` | Friendly two-pulse invitation |
| P21-AUD-008 | `queue-match` | Quiet rising match-found signal |
| P21-AUD-009 | `reward` | Bright but restrained reward cascade |

Regenerate from the repository root with:

```sh
python3 scripts/p21/export-audio.py
```

The generator uses the Python standard library and the already installed `ffmpeg`; it performs PCM, duration, peak, edge, decode, byte-budget, and repeatability checks. It does not install tools or call an online generator. All tones are composed by the editable Python source with sine oscillators and smooth envelopes; no third-party samples, music, or loops are used. This provenance statement is not a trademark or release approval.

The pack is not imported or played by the website or native clients. There is no autoplay. Future integration requires explicit opt-in, mute/volume controls, and an accessible silent fallback. This asset slice does not complete P21.06 or establish human listening, cross-browser audio, or phone acceptance.
