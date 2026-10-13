# Google Colab runtime inventory (probed 2026-10-13)

Verified by allocating and immediately stopping each accelerator with the `colab` CLI (v0.7.4).
Account `oculusrexai@gmail.com`, auth `oauth2`.

## Result: T4 GPU and TPU v5e1 available; A100/L4/G4/H100 not entitled

| Accelerator | Allocated? | Hardware seen | Notes |
| --- | --- | --- | --- |
| CPU | yes (pre-existing session) | `Hardware: CPU`, Standard shape | 0.08 CU/hr |
| **T4** | **yes** (4.4 s) | `Hardware: T4`, `Variant: GPU` | 1.15 CU/hr; included with the current subscription (balance unchanged at 0.00) |
| `--high-mem` | not probed | - | requires Pro/Pro+; supported for CPU/T4/A100 |
| `A100` | **no** | - | `Backend rejected accelerator 'A100'. You may not have quota or entitlement` |
| `L4` | **no** | - | same rejection |
| `G4` | **no** | - | same rejection |
| `H100` | **no** | - | same rejection |
| **TPU v5e1** | **yes** | `Hardware: V5E1`, `Variant: TPU` | TPU |
| TPU v6e1 | not probed | - | the v5e1 probe established TPU entitlement exists |

## Account limits

- `colab usage`: **balance 0.00 compute units**, rate ~1.1/hr, 1 active assignment. T4 allocation did
  NOT consume balance, so T4 is subscription-included; the rejected accelerators would need purchased
  compute units (or a Pro+ tier).
- Free/Pro idle behaviour applies: unstopped sessions are reaped by the backend (shorter on Free).
- All probes were stopped; the only session remaining is a pre-existing CPU session with no local record
  (`[?]`), which `colab exec` cannot attach to. Left untouched.

## Fit with the Mega XO plan

Colab is **not** a substitute for the DGX Sparks for the serious training programme: a GB10 Spark
(much higher throughput, 128 GB unified, no per-hour meter, persistent filesystem) trained the 714k-param
candidate on 80,250 records in **418 s**. A T4 is a small fraction of that compute and has a transient
filesystem.

Where Colab is genuinely useful here:

1. **Portability proof** - run the actual `training/bot/train.py` + `export.py` pipeline on a stock
   Colab T4 to show the compact-CNN research is reproducible on a third, independent runtime.
2. **Overflow** - small sweeps/labels while both Sparks are saturated (as they were for most of the 72 h
   programme).
3. **TPU v5e1** - the only TPU path available; would need a JAX / torch-xla port, so it is a separate
   investigation, not a drop-in.
4. **Notebook/Drive workflows** - `colab exec -f nb.ipynb`, `colab drivemount` for shareable experiment
   notebooks.

Compute units stay at 0.00; T4 runs are subscription-metered by the hour, so any non-trivial Colab job is
a spend-bearing action and needs owner confirmation before launch.
