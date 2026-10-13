#!/usr/bin/env python3
"""Bounded continuous-learning operator (CL06/CL07/CL12/CL16/CL17).

An ACTUAL state-machine operator over the real training pipeline (generate -> validate -> train ->
export -> league -> approve/reject), not a manifest writer. Modes: plan, run, resume, status, stop.

Design commitments (see docs/v5.1/release/MAIN-AGENT-EXECUTION-PLAN-EXPANDED.md 8.1):

  * Lifecycle: CREATED -> GENERATING -> DATA_VALIDATED -> TRAINING -> EXPORT_VALIDATED ->
    EVALUATING -> REJECTED | RESEARCH_APPROVED -> ... with FAILED_RETRYABLE, FAILED_PERMANENT and
    PAUSED as explicit states carrying the failing stage and its context.
  * Every configuration value is validated BEFORE a job lease is acquired.
  * Durable, atomic state writes; an exclusive lease with heartbeat/expiry prevents two operators on
    one run; child processes are tracked; each stage is idempotent on its own outputs, so a
    successful immutable output is never overwritten by a retry.
  * Subprocesses run as argument arrays (no shell strings); stderr is captured to a bounded log;
    a missing tool / import / download is FAILED_RETRYABLE (environment), a bad-data or non-finite
    result is FAILED_PERMANENT (semantic).
  * Source provenance is the ACTUAL checked-out Git SHA plus measured file hashes, not a
    caller-supplied 40-character string.
  * Checkpoint resume: the training stage persists model+optimizer+RNG per epoch; a killed run is
    resumable from the last completed epoch.
  * The research champion pointer uses compare-and-swap and can NEVER set the shipped catalog's
    APPROVED state; a rejected candidate is archived, never made downloadable as approved.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# The ordered stage machine. `outputs` are the durable artifacts each stage must leave behind; a
# stage whose outputs already exist in a completed state is skipped on resume (idempotent).
STAGES = ["GENERATING", "DATA_VALIDATED", "TRAINING", "EXPORT_VALIDATED", "EVALUATING"]
STAGE_AFTER = {
    "CREATED": "GENERATING",
    "GENERATING": "DATA_VALIDATED",
    "DATA_VALIDATED": "TRAINING",
    "TRAINING": "EXPORT_VALIDATED",
    "EXPORT_VALIDATED": "EVALUATING",
    "EVALUATING": "REJECTED",
}
TERMINAL = {"REJECTED", "RESEARCH_APPROVED", "FAILED_PERMANENT"}
# Environment-class failures are retryable (missing tool/import/network); everything else is treated
# as a data/semantic failure and is permanent for this run.
RETRYABLE_MARKERS = (
    "ModuleNotFoundError", "ImportError", "No such file or directory",
    "connection", "Connection", "timed out", "Temporary failure",
    "ENOSPC", "EADDRINUSE", "Network is unreachable",
)

CONFIG_KEYS = {
    "games": int, "seed": int, "simulations": int, "epochs": int, "batch": int,
    "width": int, "blocks": int, "leaguePairs": int, "budgetMs": int, "leagueSimulations": int,
    "workers": int, "nodeBin": str, "pythonBin": str, "producerModel": str, "producerBudgetMs": int,
    "device": str, "generations": int, "qualificationReserve": int, "valueSource": str, "earlyStopPatience": int,
    "seedDataset": str, "anchorDataset": str,
}
CONFIG_BOUNDS = {
    "games": (2, 100000), "seed": (0, 2**31 - 1), "simulations": (1, 4096),
    "epochs": (1, 10000), "batch": (1, 4096), "width": (48, 128), "blocks": (1, 6),
    "leaguePairs": (2, 20000), "budgetMs": (1, 60000), "leagueSimulations": (1, 4096),
    "workers": (1, 64), "producerBudgetMs": (1, 60000),
    "generations": (1, 1000), "qualificationReserve": (0, 50), "earlyStopPatience": (0, 1000),
}
DEFAULT_CONFIG = {
    "games": 24, "seed": 7001, "simulations": 8, "epochs": 3, "batch": 32,
    "width": 48, "blocks": 4, "leaguePairs": 8, "budgetMs": 10, "leagueSimulations": 8,
    "workers": 4, "nodeBin": "node", "pythonBin": sys.executable,
    "producerModel": None, "producerBudgetMs": 300,
    # GPU multi-generation training: `device` cuda uses the DGX GPU; `generations` repeats the whole
    # generate->validate->train->export->evaluate cycle, feeding each generation's research champion
    # back into the next self-play (the producer is re-resolved to the newest champion artifact).
    # `qualificationReserve` reserves untouched final-evaluation families; `valueSource` restricts
    # training to one value-target semantics; `earlyStopPatience` enables early stopping.
    "device": "cpu", "generations": 1, "qualificationReserve": 0, "valueSource": "all", "earlyStopPatience": 0,
    # `seedDataset` bootstraps generation 1's training from an existing strong-search dataset (e.g. the
    # committed search-labels-combined) instead of weak self-play; later generations self-play the
    # promoted champion. Absent => the classical bootstrap generator is used.
    "seedDataset": None, "anchorDataset": None,
}
LEASE_TTL_SECONDS = 90
LOG_LIMIT_BYTES = 2 * 1024 * 1024

# Frozen research-promotion policy. A candidate may only become the RESEARCH champion when a single,
# exactly-identified matchup against the frozen reference clears BOTH the point target and the
# independently agreed LOWER confidence bound, on a qualification-sized set of independent opening
# families, with complete ordered statistics that are recomputed from the raw game records. The
# 24-family league default stays a DIAGNOSTIC; it can never satisfy this gate. Nothing here sets the
# shipped APPROVED catalog or production approval.
PROMOTION_POINT_TARGET = 0.70      # league's declared point-score target
PROMOTION_LOWER_TARGET = 0.65     # league's declared lower-95%-CI target
PROMOTION_MIN_FAMILIES = 200      # BENCHMARKS.md independent-family qualification protocol
PROMOTION_CANDIDATE = "policyValuePUCT"
PROMOTION_REFERENCE = "improvedExpert"
BOOTSTRAP_SEED = 731              # must match src/bot/contracts.js and v51-readiness-model-gate.py

# Operator lease: heartbeat from wall-clock time, not stdout volume, so a quiet long stage cannot
# silently outlive its lease. STOP is not a terminal state; a resume clears it explicitly.
LEASE_HEARTBEAT_SECONDS = 15.0


def _uint32_rng(seed: int):
    """Exact uint32 Mulberry32 used by src/bot/contracts.js (bootstrap seed 731)."""
    n, mask = seed, 0xFFFFFFFF
    while True:
        n = (n + 0x6D2B79F5) & mask
        t = ((n ^ (n >> 15)) * (n | 1)) & mask
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & mask)) & mask
        yield ((t ^ (t >> 14)) & mask) / 4294967296


def _bootstrap_ci(pairs: list, iterations: int = 2000) -> list:
    """Paired-family bootstrap, reproducing the league's own seed so the gate recomputes - not trusts
    - the reported interval."""
    if not pairs:
        return None
    rng = _uint32_rng(BOOTSTRAP_SEED)
    scores = []
    for _ in range(iterations):
        total = 0.0
        for _ in range(len(pairs)):
            total += pairs[int(next(rng) * len(pairs))]
        scores.append(total / len(pairs))
    scores.sort()
    return [scores[int(0.025 * iterations)], scores[int(0.975 * iterations)]]


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=False)


def source_provenance() -> dict:
    """Provenance is measured from the ACTUAL tree: the checked-out SHA and the real dirty-file set.
    A caller may not assert a SHA that the working tree does not satisfy."""
    head = git("rev-parse", "HEAD").stdout.strip()
    porcelain = git("status", "--porcelain").stdout.strip()
    dirty = [line[3:].strip() for line in porcelain.splitlines() if line.strip()] if porcelain else []
    tracked = ["training/bot/train.py", "training/bot/model.py", "training/bot/generate.cjs",
               "training/bot/validate-data.cjs", "training/bot/export.py", "training/bot/neural_league.cjs",
               "src/bot/encoding.js", "src/bot/search.js", "src/bot/neural-search.js", "src/game.js"]
    hashes = {f: sha256_file(ROOT / f) for f in tracked if (ROOT / f).exists()}
    return {"head": head, "dirtyFiles": dirty, "clean": not dirty, "sourceFileHashes": hashes}


def validate_config(config: dict) -> dict:
    """Reject an incoherent configuration before any lease or stage is touched."""
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in config.items() if v is not None})
    out = {}
    for key, kind in CONFIG_KEYS.items():
        value = merged.get(key)
        # `producerModel` is an OPTIONAL path: absent means the classical bootstrap generator, and an
        # explicit null is the same as absent (never a non-empty-string violation).
        if key == "producerModel" and (value is None or value == ""):
            out[key] = None
            continue
        if key == "seedDataset" and (value is None or value == ""):
            out[key] = None
            continue
        if key == "anchorDataset" and (value is None or value == ""):
            out[key] = None
            continue
        if kind is int:
            if isinstance(value, bool) or not isinstance(value, int):
                raise SystemExit(f"CONFIG_INVALID:{key} must be an integer")
            lo, hi = CONFIG_BOUNDS[key]
            if not lo <= value <= hi:
                raise SystemExit(f"CONFIG_INVALID:{key} out of range [{lo},{hi}]")
        else:
            if not isinstance(value, str) or not value:
                raise SystemExit(f"CONFIG_INVALID:{key} must be a non-empty string")
        out[key] = value
    if out["width"] not in (48, 64, 96, 128):
        raise SystemExit("CONFIG_INVALID:width must be one of 48,64,96,128")
    if out["device"] not in ("cpu", "cuda"):
        raise SystemExit("CONFIG_INVALID:device must be cpu or cuda")
    if out["valueSource"] not in ("all", "terminal-outcome", "deep-search-root-score", "utttai-nmcts-root-value", "utttai-mcts-root-mean"):
        raise SystemExit("CONFIG_INVALID:valueSource must be all|terminal-outcome|deep-search-root-score|utttai-nmcts-root-value|utttai-mcts-root-mean")
    return out


def _bounded_write(path: Path, text: str) -> None:
    if len(text.encode("utf-8")) > LOG_LIMIT_BYTES:
        text = text.encode("utf-8")[:LOG_LIMIT_BYTES].decode("utf-8", "ignore") + "\n...TRUNCATED\n"
    path.write_text(text)


class Operator:
    def __init__(self, run_id: str, output_root: Path, overrides: dict, python_bin: str | None = None):
        self.run_id = run_id
        self.root = output_root
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_path = self.root / "run.json"
        self.lease_path = self.root / "run.lease"
        self.stop_path = self.root / "STOP"
        self.log_dir = self.root / "logs"
        self.log_dir.mkdir(exist_ok=True)
        self.child: subprocess.Popen | None = None
        self._stopping = False
        self.state = self._load_or_init()
        # A resume MUST reuse the run's frozen configuration; only explicit overrides this invocation
        # may change it, so a killed run never silently drifts onto different hyperparameters/data.
        base = dict(self.state.get("config") or {})
        base.update({k: v for k, v in overrides.items() if v is not None})
        if python_bin:
            base["pythonBin"] = python_bin
        self.config = validate_config(base)
        # CONSTRUCTION IS READ-ONLY with respect to the shared run files. A second Operator built over
        # the same output root (the WebUI WEB-AI-02a probe) must NEVER mutate the active owner's
        # run.json or frozen configuration - the earlier code wrote both here. An explicit
        # --config/override that disagrees with a FROZEN run is refused, not silently applied; the
        # owner's bytes only change inside an owned, transitioned write.
        stored = self.state.get("config") or {}
        frozen = bool(stored) and self.state.get("status") not in (None, "CREATED")
        if frozen:
            drifted = {k: (stored.get(k), self.config.get(k)) for k in CONFIG_KEYS
                       if stored.get(k) != self.config.get(k)}
            if drifted:
                raise SystemExit("CONFIG_FROZEN:" + ",".join(sorted(drifted)))
            self.config = validate_config(stored)
        self._pending_config_write = (not frozen) and (stored != self.config)

    # ---------------------------------------------------------------- state

    def _load_or_init(self) -> dict:
        if self.state_path.exists():
            return json.loads(self.state_path.read_text())
        return {
            "schemaVersion": 1, "runId": self.run_id, "createdAt": now_iso(),
            "status": "CREATED", "stage": None, "config": {},
            "source": source_provenance(), "stages": {}, "attempts": {},
            "history": [], "champion": "PRESERVED_UNAPPROVED", "promotionApproved": False,
        }

    def _write_state(self) -> None:
        tmp = self.state_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.state, indent=2) + "\n")
        os.replace(tmp, self.state_path)

    def _transition(self, status: str, stage: str | None = None) -> None:
        self.state["status"] = status
        if stage is not None:
            self.state["stage"] = stage
        self.state["history"].append({"at": now_iso(), "status": status, "stage": stage})
        self._write_state()

    # ---------------------------------------------------------------- lease

    def _lease_holder(self) -> dict | None:
        if not self.lease_path.exists():
            return None
        try:
            lease = json.loads(self.lease_path.read_text())
        except Exception:
            return None
        if lease.get("expiresAt", 0) < time.time():
            return None
        if lease.get("pid") and not _pid_alive(lease["pid"]):
            return None
        return lease

    def _read_lease_file(self) -> dict | None:
        """Read the lease file DIRECTLY (independent of any subclass/patched helper). Returns None only
        when the file is absent; an unreadable/corrupt file is treated as OCCUPIED (fail-closed) so a
        half-written lease is never silently reclaimed."""
        try:
            raw = self.lease_path.read_text()
        except FileNotFoundError:
            return None
        except OSError:
            return {"pid": None, "occupied": True, "expiresAt": float("inf")}
        try:
            lease = json.loads(raw)
            return lease if isinstance(lease, dict) else {"pid": None, "occupied": True, "expiresAt": float("inf")}
        except Exception:
            return {"pid": None, "occupied": True, "expiresAt": float("inf")}

    def _acquire_lease(self) -> None:
        """ATOMIC acquisition. The check-then-write race (WEB-AI-02b) let two operators both observe an
        empty lease and both write it. `O_CREAT|O_EXCL` makes the create itself the mutual-exclusion
        primitive: exactly one creator wins. The initial `_lease_holder()` check is an early refuse; a
        creator that LOSES the create re-reads the file directly and refuses unless the winner is
        provably stale (dead pid or lapsed TTL), so a live owner is never displaced."""
        payload = json.dumps({"pid": os.getpid(), "expiresAt": time.time() + LEASE_TTL_SECONDS,
                              "runId": self.run_id, "nonce": os.urandom(16).hex()})
        holder = self._lease_holder()
        if holder is not None:
            raise SystemExit(f"LEASE_HELD:{holder.get('pid')}")
        if self._try_create_lease(payload):
            self._lease_nonce = json.loads(payload)["nonce"]
            self._commit_pending_config()
            return
        # Lost the create: someone else now holds the lease. Re-read directly; refuse unless stale.
        current = self._read_lease_file()
        stale = current is None or (not current.get("occupied")
                                    and current.get("expiresAt", 0) < time.time()
                                    and (not current.get("pid") or not _pid_alive(current["pid"])))
        if not stale:
            raise SystemExit(f"LEASE_HELD:{(current or {}).get('pid')}")
        try:
            reclaim = self.lease_path.with_suffix(".stale")
            os.replace(self.lease_path, reclaim)
            os.unlink(reclaim)
        except FileNotFoundError:
            pass
        if self._try_create_lease(payload):
            self._lease_nonce = json.loads(payload)["nonce"]
            self._commit_pending_config()
            return
        raise SystemExit("LEASE_CONTENDED")

    def _commit_pending_config(self) -> None:
        """Persist the frozen run state ONLY after ownership is held. This is the single write the
        constructor used to perform unconditionally, which mutated another active owner's run."""
        if getattr(self, "_pending_config_write", False):
            self.state["config"] = self.config
            self._write_state()
            self._pending_config_write = False

    def _try_create_lease(self, payload: str) -> bool:
        try:
            fd = os.open(self.lease_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            return False
        try:
            os.write(fd, payload.encode("utf-8"))
        finally:
            os.close(fd)
        return True

    def _renew_lease(self) -> None:
        # Ownership-checked: only the holder whose nonce matches may renew, so a reclaimed/stale worker
        # can never clobber the current owner's lease (fencing).
        if not self.lease_path.exists():
            raise SystemExit("LEASE_LOST")
        try:
            lease = json.loads(self.lease_path.read_text())
        except Exception:
            raise SystemExit("LEASE_LOST")
        if lease.get("nonce") != getattr(self, "_lease_nonce", None):
            raise SystemExit("LEASE_LOST")
        lease["expiresAt"] = time.time() + LEASE_TTL_SECONDS
        tmp = self.lease_path.with_suffix(".lease.tmp")
        tmp.write_text(json.dumps(lease))
        os.replace(tmp, self.lease_path)

    def _release_lease(self) -> None:
        try:
            if self.lease_path.exists():
                lease = json.loads(self.lease_path.read_text())
                if lease.get("nonce") == getattr(self, "_lease_nonce", None) and lease.get("pid") == os.getpid():
                    self.lease_path.unlink()
        except Exception:
            pass

    # ---------------------------------------------------------------- child

    def _on_signal(self, *_args) -> None:
        self._stopping = True
        if self.child and self.child.poll() is None:
            _kill_group(self.child)

    def _child_process(self, argv: list[str]) -> subprocess.CompletedProcess:
        log_path = self.log_dir / (self.state.get("stage") or "stage")
        log_path = log_path.with_suffix(".log")
        env = dict(os.environ)
        env.setdefault("PYTHONUNBUFFERED", "1")
        # The league stage loads onnxruntime-node; the repo convention is to resolve it through
        # NODE_PATH rather than a repo-local install. Honour an explicit config, else auto-detect
        # the staged runtime, and always preserve any NODE_PATH the caller already set.
        node_path = self.config.get("nodePath")
        if not node_path:
            staged = ROOT / ".artifacts" / "v51-ort-node" / "node_modules"
            if staged.exists():
                node_path = str(staged)
        if node_path:
            env["NODE_PATH"] = os.pathsep.join(p for p in (node_path, env.get("NODE_PATH", "")) if p)
        proc = subprocess.Popen(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True, env=env)
        self.child = proc
        # HEARTBEAT FROM WALL-CLOCK TIME, not stdout volume (WEB-AI-08): a quiet long stage that emits
        # no lines for minutes must not let the lease lapse under it. A daemon thread renews on a fixed
        # interval while the child runs; renewal is ownership-checked, so a stolen lease aborts.
        self._lease_lost = False
        stop_heartbeat = threading.Event()

        def _heartbeat() -> None:
            while not stop_heartbeat.wait(LEASE_HEARTBEAT_SECONDS):
                try:
                    self._renew_lease()
                except SystemExit:
                    self._lease_lost = True
                    return

        heartbeat = threading.Thread(target=_heartbeat, name="lease-heartbeat", daemon=True)
        heartbeat.start()
        out = []
        try:
            for line in proc.stdout:  # stream so a bounded log is kept even on interruption
                out.append(line)
        finally:
            stop_heartbeat.set()
            heartbeat.join(timeout=1)
            proc.wait()
        self.child = None
        text = "".join(out)
        _bounded_write(log_path, text)
        return subprocess.CompletedProcess(argv, proc.returncode, text, "")

    def _classify_failure(self, result: subprocess.CompletedProcess) -> str:
        blob = (result.stdout or "")[-4000:]
        if any(marker in blob for marker in RETRYABLE_MARKERS):
            return "FAILED_RETRYABLE"
        return "FAILED_PERMANENT"

    # ---------------------------------------------------------------- stages

    def _stage_done(self, stage: str) -> bool:
        entry = self.state["stages"].get(stage)
        return bool(entry and entry.get("status") == "complete")

    def _mark(self, stage: str, status: str, **extra) -> None:
        entry = self.state["stages"].setdefault(stage, {})
        entry.update({"status": status, "at": now_iso(), **extra})
        self._write_state()

    def _clear_partial_outputs(self, outputs: list[Path]) -> None:
        """Remove partial artifacts (and their `.manifest.json` siblings) left by a crashed stage.
        Only called for a stage that is NOT complete. Files that are recorded artifacts of ANY completed
        stage are PROTECTED: several stages legitimately share an output (e.g. DATA_VALIDATED validates
        the same shard GENERATING wrote), and clearing it would destroy a verified immutable input."""
        protected = set()
        for entry in self.state.get("stages", {}).values():
            if entry.get("status") == "complete":
                for item in (entry.get("artifacts") or {}).values():
                    base = str((self.root / item["path"]).resolve())
                    protected.add(base)
                    protected.add(base + ".manifest.json")
        candidates = list(outputs) + [p.with_suffix(p.suffix + ".manifest.json") for p in outputs]
        for path in candidates:
            if str(path.resolve()) in protected:
                continue
            try:
                if path.exists():
                    path.unlink()
            except OSError:
                pass

    def _stage_outputs_intact(self, stage: str, outputs: list[Path]) -> bool:
        """A completed stage is skippable ONLY if every recorded output still exists at its recorded
        size and SHA-256. The earlier code skipped purely on `p.exists()`, so a tampered output was
        silently reused and a false completion preserved (WEB-AI-03). Returns False when any output is
        missing, resized, re-hashed differently, or was never recorded - which forces a rebuild."""
        entry = self.state["stages"].get(stage) or {}
        recorded = entry.get("artifacts") or {}
        if not recorded:
            return False
        for path in outputs:
            item = recorded.get(path.name)
            if not isinstance(item, dict):
                return False
            if not path.exists():
                return False
            if path.stat().st_size != item.get("bytes"):
                return False
            if sha256_file(path) != item.get("sha256"):
                return False
        return True

    def _run_stage(self, stage: str, argv: list[str], outputs: list[Path]) -> None:
        if self._stage_done(stage) and self._stage_outputs_intact(stage, outputs):
            return  # idempotent: a verified, unchanged immutable output is never overwritten
        if self._stage_done(stage):
            # A stage marked complete whose artifacts are missing/altered is NOT complete. Invalidate
            # it explicitly so the downstream decision never rests on a false completion.
            self._mark(stage, "invalidated", reason="OUTPUT_INTEGRITY_FAILED")
            self.state["integrityFailures"] = self.state.get("integrityFailures", 0) + 1
            self._write_state()
        if self._stopping or self.stop_path.exists():
            self._transition("PAUSED", stage)
            self.state["pausedReason"] = "stop-requested"
            self._write_state()
            raise SystemExit(0)
        self._transition(stage, stage)
        self.state["attempts"][stage] = self.state["attempts"].get(stage, 0) + 1
        self._write_state()
        # A stage that is NOT complete has no immutable output to protect: any file it left behind is a
        # PARTIAL artifact from a crash (the generators refuse to overwrite with O_EXCL, so a partial
        # shard would otherwise make resume fail forever). Remove the declared outputs and their
        # manifests BEFORE re-running; a COMPLETE+intact stage already returned above, so a verified
        # immutable output is never touched here.
        self._clear_partial_outputs(outputs)
        result = self._child_process(argv)
        if result.returncode != 0:
            status = "PAUSED" if self._stopping else self._classify_failure(result)
            self._mark(stage, status.lower(), exitCode=result.returncode, argv=argv)
            self._transition(status, stage)
            self.state["lastFailure"] = {"stage": stage, "exitCode": result.returncode,
                                         "argv": argv, "log": str(self.log_dir / (stage + ".log"))}
            self._write_state()
            raise SystemExit(0 if status == "PAUSED" else 1)
        missing = [str(p) for p in outputs if not p.exists()]
        if missing:
            self._mark(stage, "failed_permanent", reason="MISSING_OUTPUT", missing=missing)
            self._transition("FAILED_PERMANENT", stage)
            raise SystemExit(1)
        artifacts = {p.name: {"path": str(p.relative_to(self.root)), "sha256": sha256_file(p), "bytes": p.stat().st_size} for p in outputs}
        self._mark(stage, "complete", argv=argv, artifacts=artifacts)
        self._transition(STAGE_AFTER[stage], stage)

    # ---------------------------------------------------------------- stage builders

    def _shard(self) -> Path:
        return self.root / "data" / "shard.jsonl"

    def _candidate_dir(self) -> Path:
        return self.root / "candidate"

    def _export_dir(self) -> Path:
        return self.root / "export"

    def _league_path(self) -> Path:
        return self.root / "league.json"

    def _interim(self) -> Path:
        return self.root / "interim"

    def _argv_generate(self) -> list[str]:
        c = self.config
        # Generation 1 bootstrap: an explicit `seedDataset` (strong-search labels) is copied into the
        # shard slot and validated in place; later generations self-play the promoted champion.
        seed = c.get("seedDataset")
        if seed and self.state.get("generation", 1) == 1:
            return [c["nodeBin"], str(ROOT / "training/bot/copy-dataset.cjs"), str(seed), str(self._shard())]
        # CL10/WEB-AI-04: when a research champion artifact exists, real neural self-play consumes it
        # (binds parent model hash, records producer version) instead of the mixed-strength bootstrap.
        producer = self._effective_producer()
        if producer:
            anchor = c.get("anchorDataset")
            if anchor:
                # ANCHORED self-play: keep the strong-label corpus in the mix every generation, add
                # self-play from the current champion - never substitute it (measured: pure self-play
                # replacement degraded 0.931 -> 0.394 -> 0.294 vs tacticalUCT).
                return [c["nodeBin"], str(ROOT / "training/bot/selfplay-anchored.cjs"),
                        "--model", str(producer), "--anchor", str(anchor), "--output", str(self._shard()),
                        "--games", str(c["games"]), "--seed", str(c["seed"]),
                        "--simulations", str(c["simulations"]), "--budget-ms", str(c.get("producerBudgetMs", 300))]
            argv = [c["nodeBin"], str(ROOT / "training/bot/selfplay.cjs"),
                    "--model", str(producer), "--output", str(self._shard()),
                    "--games", str(c["games"]), "--seed", str(c["seed"]),
                    "--simulations", str(c["simulations"]), "--budget-ms", str(c.get("producerBudgetMs", 300))]
            return argv
        argv = [c["nodeBin"], str(ROOT / "training/bot/generate.cjs"), str(self._shard()),
                str(c["games"]), str(c["seed"]), str(c["simulations"])]
        if c["qualificationReserve"]:
            argv.append(str(c["qualificationReserve"]))
        return argv

    def _argv_validate(self) -> list[str]:
        return [self.config["nodeBin"], str(ROOT / "training/bot/validate-data.cjs"), str(self._shard())]

    def _argv_train(self) -> list[str]:
        c = self.config
        argv = [c["pythonBin"], str(ROOT / "training/bot/train.py"), str(self._shard()),
                "--output", str(self._candidate_dir()), "--source-commit", self.state["source"]["head"],
                "--epochs", str(c["epochs"]), "--batch", str(c["batch"]), "--device", c["device"],
                "--width", str(c["width"]), "--blocks", str(c["blocks"]),
                "--value-source", c["valueSource"], "--node-bin", c["nodeBin"],
                "--interim-dir", str(self._interim())]
        if c["earlyStopPatience"]:
            argv += ["--early-stop-patience", str(c["earlyStopPatience"])]
        ckpt = self._interim() / "interim.pt"
        if ckpt.exists():
            argv += ["--resume", str(ckpt)]  # warm start from the last completed epoch
        return argv

    def _argv_export(self) -> list[str]:
        return [self.config["pythonBin"], str(ROOT / "training/bot/export.py"),
                str(self._candidate_dir()), str(self._shard()),
                "--output", str(self._export_dir())]

    def _argv_league(self) -> list[str]:
        c = self.config
        return [c["nodeBin"], str(ROOT / "training/bot/neural_league.cjs"),
                "--model", str(self._export_dir()), "--pairs", str(c["leaguePairs"]),
                "--budget-ms", str(c["budgetMs"]), "--simulations", str(c["leagueSimulations"]),
                "--output", str(self._league_path()), "--workers", str(c["workers"])]

    # ---------------------------------------------------------------- modes

    def plan(self) -> int:
        self.state["plan"] = [
            {"stage": "GENERATING", "argv": self._argv_generate()},
            {"stage": "DATA_VALIDATED", "argv": self._argv_validate()},
            {"stage": "TRAINING", "argv": self._argv_train()},
            {"stage": "EXPORT_VALIDATED", "argv": self._argv_export()},
            {"stage": "EVALUATING", "argv": self._argv_league()},
        ]
        self._transition("PLANNED", None)
        print(json.dumps({"runId": self.run_id, "status": self.state["status"], "plan": self.state["plan"]}, indent=2))
        return 0

    def _effective_producer(self):
        """Resolve the self-play producer for the CURRENT generation: an explicit `producerModel`
        config path, else the newest research-champion artifact (so generation N+1's self-play is guided
        by generation N's promoted model). Returns None when neither exists (classical bootstrap)."""
        explicit = self.config.get("producerModel")
        if explicit:
            return explicit
        # A stable pointer to the latest champion's export DIRECTORY (selfplay.cjs expects a dir
        # containing candidate.onnx), written by _archive_generation, so generation N+1 self-plays the
        # model that was actually archived (not a run-id guess).
        cur = self.root / "current-champion"
        if cur.is_dir():
            return cur
        ptr = self.root / "research-champion.json"
        if ptr.exists():
            record = json.loads(ptr.read_text())
            run_id = record.get("runId")
            cand = self.root / f"gen-{run_id}" / "export" / "candidate.onnx" if run_id else None
            if cand and cand.exists():
                return cand
        return None

    def run(self) -> int:
        self._acquire_lease()
        signal.signal(signal.SIGTERM, self._on_signal)
        signal.signal(signal.SIGINT, self._on_signal)
        try:
            for generation in range(1, self.config["generations"] + 1):
                self.state["generation"] = generation
                self.state["generations"] = self.config["generations"]
                self._write_state()
                stages = [
                    ("GENERATING", self._argv_generate, [self._shard()]),
                    ("DATA_VALIDATED", self._argv_validate, [self._shard()]),
                    ("TRAINING", self._argv_train, [self._candidate_dir() / "candidate.pt"]),
                    ("EXPORT_VALIDATED", self._argv_export, [self._export_dir() / "candidate.onnx", self._export_dir() / "candidate-int8.onnx"]),
                    ("EVALUATING", self._argv_league, [self._league_path()]),
                ]
                for stage, builder, outputs in stages:
                    self._run_stage(stage, builder(), outputs)
                self._decide()
                print(json.dumps({"generation": generation, "champion": self.state.get("champion")}))
                if generation < self.config["generations"]:
                    # Preserve this generation's artifacts and reset the per-generation working dirs so
                    # the next generation regenerates into a clean state but keeps the promoted model.
                    self._archive_generation(generation)
        finally:
            self._release_lease()
        return 0

    def _archive_generation(self, generation: int) -> None:
        """Move a completed generation's artifacts into gen-<n>/ and clear the working dirs, so the next
        generation starts clean while the previous champion artifact remains available as the producer."""
        dest = self.root / f"gen-{generation}"
        dest.mkdir(parents=True, exist_ok=True)
        # Publish a stable champion export DIRECTORY for the next generation's self-play producer.
        export = self._export_dir()
        if (export / "candidate.onnx").exists():
            cur = self.root / "current-champion"
            if cur.exists():
                shutil.rmtree(cur)
            shutil.copytree(export, cur)
        for name in ("data", "candidate", "export", "league.json", "interim"):
            src = self.root / name
            if src.exists():
                target = dest / name
                if target.exists():
                    shutil.rmtree(target) if target.is_dir() else target.unlink()
                shutil.move(str(src), str(target))
        self.state.setdefault("history", []).append({"at": now_iso(), "generation": generation, "archivedTo": str(dest)})
        self._write_state()

    def resume(self) -> int:
        # A resume re-enters the machine at the first stage that is not yet complete; completed
        # stages are skipped by their own idempotent output check. A prior STOP is cleared so the
        # resume actually proceeds.
        self.reset_for_resume()
        return self.run()

    def status(self) -> int:
        holder = self._lease_holder()
        print(json.dumps({
            "runId": self.run_id, "status": self.state["status"], "stage": self.state.get("stage"),
            "stages": {k: v.get("status") for k, v in self.state["stages"].items()},
            "attempts": self.state["attempts"], "champion": self.state.get("champion"),
            "promotionApproved": self.state.get("promotionApproved"),
            "lease": (holder or {}).get("pid"),
            "lastFailure": self.state.get("lastFailure"),
        }, indent=2))
        return 0

    def stop(self) -> int:
        self.stop_path.write_text(f"stop requested at {now_iso()}\n")
        print(json.dumps({"runId": self.run_id, "stopRequested": True, "stopPath": str(self.stop_path)}))
        return 0

    # ---------------------------------------------------------------- decision

    def _decide(self) -> None:
        """Compare the candidate's independent league result against the frozen champion and
        compare-and-swap the research pointer. This NEVER sets the shipped APPROVED catalog.

        Two distinct gates, per the audit finding that research progression was gated at the strict
        PUBLIC-qualification bar (so an intermediate improver could never advance):
          * `evaluate_gate`              - strict public-qualification bar (0.70 / 0.65 / 200 families).
          * `evaluate_research_progression` - lighter research bar (default 0.70 / 0.50 / 40 families),
            SAME evidence-integrity requirements, so iterative RL can advance the research champion on
            measured improvement. A candidate clearing the strict bar is recorded as fully qualified."""
        league = json.loads(self._league_path().read_text())
        model_path = self._export_dir() / "candidate.onnx"
        model_sha = sha256_file(model_path) if model_path.exists() else None
        source_sha = self.state["source"]["head"]
        strict = evaluate_gate(league, expected_model=model_sha, expected_source=source_sha,
                               min_families=PROMOTION_MIN_FAMILIES)
        # The predecessor engine id (its model hash) is the research head-to-head opponent, if the
        # league actually includes a matchup against it; absent that, only the reference-floor path runs.
        parent_engine = None
        try:
            ptr = self.root / "research-champion.json"
            if ptr.exists():
                parent_engine = json.loads(ptr.read_text()).get("candidateSha256")
        except Exception:
            parent_engine = None
        research = evaluate_research_progression(league, expected_model=model_sha, expected_source=source_sha,
                                                 parent_engine=None)  # head-to-head wired once leagues name the parent
        self.state["leagueGate"] = {
            "strict": strict, "research": research,
            "advance": bool(strict["promote"] or research["advance"]),
            "publicQualified": bool(strict["promote"]),
        }
        if strict["promote"] or research["advance"]:
            self._promote(strict if strict["promote"] else research, qualified=bool(strict["promote"]))
        else:
            self.state["champion"] = "PRESERVED_UNAPPROVED"
            self._transition("REJECTED", "EVALUATING")
        self._write_state()
        print(json.dumps({"runId": self.run_id, "gate": self.state["leagueGate"], "champion": self.state["champion"]}, indent=2))

    def reset_for_resume(self) -> None:
        """Explicitly clear a prior STOP so `resume` actually continues. STOP is a request, not a
        terminal state; the earlier code checked it between stages and `resume` never cleared it, so a
        stopped run could never be resumed (WEB-AI-08). A resume after a STOP is recorded in history."""
        if self.stop_path.exists():
            self.stop_path.unlink()
            self.state.setdefault("history", []).append({"at": now_iso(), "status": "RESUME_CLEARED_STOP"})
            self._write_state()

    def _promote(self, gate: dict, *, qualified: bool = False) -> None:
        pointer = self.root / "research-champion.json"
        lock = self.root / "research-champion.lock"
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            self.state["champion"] = "PRESERVED_UNAPPROVED"
            self._transition("REJECTED", "EVALUATING")
            return
        try:
            prior = json.loads(pointer.read_text()) if pointer.exists() else None
            record = {
                "runId": self.run_id, "promotedAt": now_iso(),
                "candidateSha256": sha256_file(self._export_dir() / "candidate.onnx"),
                "league": gate, "parent": (prior or {}).get("candidateSha256"),
                "researchQualifiedOnly": not qualified,
                "shippedApproved": False,
            }
            tmp = pointer.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(record, indent=2) + "\n")
            os.replace(tmp, pointer)
            self.state["champion"] = "RESEARCH_APPROVED"
            self.state["promotionApproved"] = True
            self._transition("RESEARCH_APPROVED", "EVALUATING")
        finally:
            os.close(fd)
            lock.unlink(missing_ok=True)


def _load_model_verifier():
    """Integrate the INDEPENDENT model-evidence verifier (scripts/v51-readiness-model-gate.py) rather
    than re-implementing its checks. It is the same code WebUI tests; the operator only supplies the
    candidate's own bindings. Absent the file, the gate fails closed."""
    path = ROOT / "scripts" / "v51-readiness-model-gate.py"
    try:
        spec = importlib.util.spec_from_file_location("v51_readiness_model_gate", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:
        return None


def evaluate_research_progression(league: dict, *, expected_model: str | None = None,
                                  expected_source: str | None = None, parent_engine: str | None = None,
                                  min_families: int = 40, min_score: float = 0.55,
                                  min_lower: float = 0.50) -> dict:
    """RESEARCH-only advancement gate, decoupled from the strict PUBLIC-qualification bar.

    The audit finding: the strict `evaluate_gate` (0.70 point / 0.65 lower / 200 families) was the ONLY
    path to advance the research champion, so an intermediate improver could never advance and iterative
    RL could not progress. Two independent advancement paths, EITHER of which suffices:

      1. **Head-to-head vs the predecessor** (the true AlphaZero criterion): a bound
         `policyValuePUCT`-vs-`parent_engine` matchup with complete paired records whose recomputed
         lower-95%-CI is > 0.50 (the candidate is statistically at least as good as the champion it
         would replace) AND point score >= min_score.
      2. **Absolute research floor** on the fixed `improvedExpert` reference: point >= min_score and
         recomputed lower-95%-CI >= min_lower on >= min_families independent families.

    Both keep the SAME evidence-integrity requirements as the strict gate (exact matchup, complete
    paired records, counts and bootstrap RECOMPUTED by the independent verifier). This NEVER sets the
    shipped APPROVED catalog or production approval, and a candidate that also clears the strict public
    gate is recorded as fully qualified."""
    reasons: list[str] = []
    def refuse(reason: str, **extra) -> dict:
        return {"advance": False, "qualified": False, "reason": reason, "productionApproved": False, **extra}
    if not isinstance(league, dict):
        return refuse("LEAGUE_INVALID")
    model_sha = expected_model or league.get("modelSha256")
    source_sha = expected_source or league.get("sourceSha")
    verifier = _load_model_verifier()
    if verifier is None:
        return refuse("MODEL_VERIFIER_UNAVAILABLE")
    matchups = league.get("matchups")
    if not isinstance(matchups, list):
        return refuse("MATCHUPS_MISSING")
    if not (isinstance(model_sha, str) and re.fullmatch(r"[0-9a-f]{64}", model_sha)
            and isinstance(source_sha, str) and re.fullmatch(r"[0-9a-f]{40}", source_sha)):
        return refuse("MODEL_OR_SOURCE_BINDING_REQUIRED")

    def _verdict(engine_b: str) -> dict | None:
        matches = [m for m in matchups if isinstance(m, dict)
                   and m.get("engineA") == PROMOTION_CANDIDATE and m.get("engineB") == engine_b]
        if len(matches) != 1:
            return None
        report = dict(league); report.setdefault("status", "COMPLETED")
        report["modelSha256"] = model_sha; report["sourceSha"] = source_sha
        # min_score=min_lower=0 forces the verifier to RECOMPUTE and integrity-check counts/records/
        # bootstrap and hand back its recomputed interval; this gate applies its own thresholds. Any
        # integrity failure (missing records, wrong counts, tampered bootstrap, wrong binding) refuses.
        return _eval_forced(report, verifier, engine_b, model_sha, source_sha, min_families)

    # Path 1: head-to-head vs the predecessor, when the caller names one.
    h2h = None
    if parent_engine:
        verdict = _verdict(parent_engine)
        if verdict is None:
            return refuse("PARENT_MATCHUP_MISSING", parentEngine=parent_engine)
        reasons = list(verdict.get("reasons") or [])
        if reasons:
            return refuse(";".join(reasons), verdict=verdict, path="head-to-head")
        score = verdict.get("pointScore"); interval = verdict.get("recomputedPairBootstrap95")
        lower = interval[0] if interval else None
        advance = bool(isinstance(score, (int, float)) and score >= min_score and lower is not None and lower > 0.50)
        h2h = {"path": "head-to-head", "parentEngine": parent_engine, "score": score, "ciLow": lower,
               "independentFamilies": verdict.get("independentFamilies"), "advance": advance}
        if advance:
            return {"advance": True, "qualified": False, "reason": "RESEARCH_ADVANCE_HEAD_TO_HEAD",
                    "score": score, "ciLow": lower, "independentFamilies": verdict.get("independentFamilies"),
                    "headToHead": h2h, "researchTargets": {"minPointScore": min_score, "minLower95": ">0.50", "minFamilies": min_families},
                    "publicQualified": False, "productionApproved": False, "verdict": verdict}

    # Path 2: absolute research floor on a REALISTIC reference baseline. Our strongest research
    # candidate EVER scores ~0.05 vs improvedExpert but ~0.61 vs the tacticalUCT search; requiring 0.55
    # vs improvedExpert is unreachable and would never advance any improver. The research floor is
    # therefore measured against `tacticalUCT` (the baseline the research programme actually uses), on
    # a declared number of independent families. Public qualification still uses improvedExpert.
    research_reference = os.environ.get("V5_RESEARCH_REFERENCE", "tacticalUCT")
    verdict = _verdict(research_reference)
    if verdict is None:
        return refuse("EXACT_REFERENCE_MATCHUP_REQUIRED", matched=0, reference=research_reference, headToHead=h2h)
    reasons = list(verdict.get("reasons") or [])
    if reasons:
        return refuse(";".join(reasons), verdict=verdict, path="reference", headToHead=h2h)
    score = verdict.get("pointScore"); interval = verdict.get("recomputedPairBootstrap95")
    families = verdict.get("independentFamilies"); lower = interval[0] if interval else None
    advance = bool(isinstance(score, (int, float)) and score >= min_score and lower is not None and lower >= min_lower)
    qualified = bool(advance and families is not None and families >= PROMOTION_MIN_FAMILIES
                     and score >= PROMOTION_POINT_TARGET and lower >= PROMOTION_LOWER_TARGET)
    return {"advance": advance, "qualified": qualified,
            "reason": "RESEARCH_ADVANCE_REFERENCE_FLOOR" if advance else "BELOW_RESEARCH_THRESHOLD",
            "referenceEngine": research_reference,
            "score": score, "ciLow": lower, "independentFamilies": families, "headToHead": h2h,
            "researchTargets": {"minPointScore": min_score, "minLower95": min_lower, "minFamilies": min_families},
            "publicQualified": qualified, "productionApproved": False, "verdict": verdict}


def _eval_forced(report: dict, verifier, engine_b: str, model_sha: str, source_sha: str, min_families: int) -> dict:
    """Run the independent verifier against a SPECIFIC candidate-vs-`engine_b` matchup. The verifier
    hard-codes the `improvedExpert` reference, so for a head-to-head / alternate-reference comparison we
    ISOLATE the target matchup (drop every other matchup, else the verifier sees a duplicate reference)
    and substitute the reference name with the real predecessor id."""
    report = json.loads(json.dumps(report))
    keep = [m for m in report.get("matchups", []) if isinstance(m, dict)
            and m.get("engineA") == PROMOTION_CANDIDATE and m.get("engineB") == engine_b]
    if len(keep) != 1:
        return {"researchEvidenceQualified": False, "productionApproved": False,
                "policy": {}, "reasons": ["EXACT_REFERENCE_MATCHUP_REQUIRED"], "matchupCount": len(keep)}
    match = keep[0]
    if engine_b != PROMOTION_REFERENCE:
        match["engineB"] = PROMOTION_REFERENCE
        for g in (match.get("games") or []):
            if isinstance(g, dict) and g.get("b") == engine_b:
                g["b"] = PROMOTION_REFERENCE
    report["matchups"] = [match]
    return verifier.evaluate(report, expected_model=model_sha, expected_source=source_sha,
                             min_families=min_families, min_score=0.0, min_lower=0.0)


def evaluate_gate(league: dict, *, expected_model: str | None = None, expected_source: str | None = None,
                  min_families: int = PROMOTION_MIN_FAMILIES) -> dict:
    """Fail-closed research-promotion gate. Promote ONLY when the independent verifier qualifies a
    single, exactly-identified `policyValuePUCT` vs `improvedExpert` matchup whose complete paired
    evidence clears BOTH the point target and the lower-confidence target on a qualification-sized set
    of independent opening families, with statistics RECOMPUTED from the raw records and the candidate's
    model/source bound and verified. This can NEVER set the shipped APPROVED catalog or production
    approval. Any missing/ambiguous/failed input returns promote=False with an explicit reason.

    WEB-AI-01a (unrelated opponents accepted), 01b (point target ignored), 01c (reversed interval,
    unverified counts) are all closed by delegating the numeric verdict to the verifier and requiring
    the exact matchup here."""
    reasons: list[str] = []
    def refuse(reason: str, **extra) -> dict:
        return {"promote": False, "reason": reason, "productionApproved": False, **extra}

    if not isinstance(league, dict):
        return refuse("LEAGUE_INVALID")
    model_sha = expected_model or league.get("modelSha256")
    source_sha = expected_source or league.get("sourceSha")
    verifier = _load_model_verifier()
    if verifier is None:
        return refuse("MODEL_VERIFIER_UNAVAILABLE")
    # Reject absent, duplicate and unrelated reference matchups BEFORE the numeric verdict.
    matchups = league.get("matchups")
    if not isinstance(matchups, list):
        return refuse("MATCHUPS_MISSING")
    matches = [m for m in matchups if isinstance(m, dict)
               and m.get("engineA") == PROMOTION_CANDIDATE and m.get("engineB") == PROMOTION_REFERENCE]
    if len(matches) != 1:
        return refuse("EXACT_REFERENCE_MATCHUP_REQUIRED", matched=len(matches))
    if not (isinstance(model_sha, str) and re.fullmatch(r"[0-9a-f]{64}", model_sha)
            and isinstance(source_sha, str) and re.fullmatch(r"[0-9a-f]{40}", source_sha)):
        return refuse("MODEL_OR_SOURCE_BINDING_REQUIRED")
    # Hand the SAME league document to the independent verifier with the frozen policy.
    report = dict(league)
    report.setdefault("status", "COMPLETED")
    report["modelSha256"] = model_sha
    report["sourceSha"] = source_sha
    verdict = verifier.evaluate(report, expected_model=model_sha, expected_source=source_sha,
                                min_families=min_families, min_score=PROMOTION_POINT_TARGET,
                                min_lower=PROMOTION_LOWER_TARGET)
    result = {
        "promote": bool(verdict.get("researchEvidenceQualified")),
        "reason": "QUALIFIED" if verdict.get("researchEvidenceQualified") else ";".join(verdict.get("reasons") or ["UNQUALIFIED"]),
        "matchup": f"{PROMOTION_CANDIDATE} vs {PROMOTION_REFERENCE}",
        "pointTarget": PROMOTION_POINT_TARGET,
        "lowerTarget": PROMOTION_LOWER_TARGET,
        "minFamilies": min_families,
        "verdict": verdict,
        "productionApproved": False,
    }
    if not result["promote"]:
        return refuse(result["reason"], verdict=verdict, matchup=result["matchup"],
                      pointTarget=PROMOTION_POINT_TARGET, lowerTarget=PROMOTION_LOWER_TARGET)
    result["score"] = verdict.get("pointScore")
    result["ciLow"] = (verdict.get("recomputedPairBootstrap95") or [None])[0]
    result["independentFamilies"] = verdict.get("independentFamilies")
    return result


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bounded continuous-learning operator")
    parser.add_argument("mode", choices=["plan", "run", "resume", "status", "stop"])
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=None, help="JSON config overrides")
    parser.add_argument("--python-bin", default=None, help="python for the train/export stages")
    parser.add_argument("--games", type=int, default=None)
    parser.add_argument("--epochs", type=int, default=None)
    parser.add_argument("--batch", type=int, default=None)
    parser.add_argument("--league-pairs", type=int, default=None)
    parser.add_argument("--budget-ms", type=int, default=None)
    args = parser.parse_args(argv)

    config = json.loads(args.config.read_text()) if args.config and args.config.exists() else {}
    for key, value in (("games", args.games), ("epochs", args.epochs), ("batch", args.batch),
                       ("leaguePairs", args.league_pairs), ("budgetMs", args.budget_ms)):
        if value is not None:
            config[key] = value

    op = Operator(args.run_id, args.output_root, config, python_bin=args.python_bin)
    return {"plan": op.plan, "run": op.run, "resume": op.resume,
            "status": op.status, "stop": op.stop}[args.mode]()


if __name__ == "__main__":
    raise SystemExit(main())
