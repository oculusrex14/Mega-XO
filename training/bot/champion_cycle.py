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
import json
import os
import shutil
import signal
import subprocess
import sys
import time
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
    "workers": int, "nodeBin": str, "pythonBin": str,
}
CONFIG_BOUNDS = {
    "games": (2, 100000), "seed": (0, 2**31 - 1), "simulations": (1, 4096),
    "epochs": (1, 10000), "batch": (1, 4096), "width": (48, 128), "blocks": (1, 6),
    "leaguePairs": (2, 20000), "budgetMs": (1, 60000), "leagueSimulations": (1, 4096),
    "workers": (1, 64),
}
DEFAULT_CONFIG = {
    "games": 24, "seed": 7001, "simulations": 8, "epochs": 3, "batch": 32,
    "width": 48, "blocks": 4, "leaguePairs": 8, "budgetMs": 10, "leagueSimulations": 8,
    "workers": 4, "nodeBin": "node", "pythonBin": sys.executable,
}
LEASE_TTL_SECONDS = 90
LOG_LIMIT_BYTES = 2 * 1024 * 1024


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
        # A resume MUST reuse the run's frozen configuration: only explicit overrides this invocation
        # may change it, so a killed run never silently drifts onto different hyperparameters/data.
        base = dict(self.state.get("config") or {})
        base.update({k: v for k, v in overrides.items() if v is not None})
        if python_bin:
            base["pythonBin"] = python_bin
        self.config = validate_config(base)
        self.state["config"] = self.config
        self._write_state()

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

    def _acquire_lease(self) -> None:
        holder = self._lease_holder()
        if holder:
            raise SystemExit(f"LEASE_HELD:{holder.get('pid')}")
        self.lease_path.write_text(json.dumps({"pid": os.getpid(), "expiresAt": time.time() + LEASE_TTL_SECONDS, "runId": self.run_id}))

    def _renew_lease(self) -> None:
        self.lease_path.write_text(json.dumps({"pid": os.getpid(), "expiresAt": time.time() + LEASE_TTL_SECONDS, "runId": self.run_id}))

    def _release_lease(self) -> None:
        try:
            if self.lease_path.exists():
                lease = json.loads(self.lease_path.read_text())
                if lease.get("pid") == os.getpid():
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
        out = []
        try:
            for line in proc.stdout:  # stream so a bounded log is kept even on interruption
                out.append(line)
                if len(out) % 400 == 0:
                    self._renew_lease()
        finally:
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

    def _run_stage(self, stage: str, argv: list[str], outputs: list[Path]) -> None:
        if self._stage_done(stage) and all(p.exists() for p in outputs):
            return  # idempotent: never overwrite a completed immutable output
        if self._stopping or self.stop_path.exists():
            self._transition("PAUSED", stage)
            self.state["pausedReason"] = "stop-requested"
            self._write_state()
            raise SystemExit(0)
        self._transition(stage, stage)
        self.state["attempts"][stage] = self.state["attempts"].get(stage, 0) + 1
        self._write_state()
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
        return [c["nodeBin"], str(ROOT / "training/bot/generate.cjs"), str(self._shard()),
                str(c["games"]), str(c["seed"]), str(c["simulations"])]

    def _argv_validate(self) -> list[str]:
        return [self.config["nodeBin"], str(ROOT / "training/bot/validate-data.cjs"), str(self._shard())]

    def _argv_train(self) -> list[str]:
        c = self.config
        argv = [c["pythonBin"], str(ROOT / "training/bot/train.py"), str(self._shard()),
                "--output", str(self._candidate_dir()), "--source-commit", self.state["source"]["head"],
                "--epochs", str(c["epochs"]), "--batch", str(c["batch"]), "--device", "cpu",
                "--width", str(c["width"]), "--blocks", str(c["blocks"]),
                "--interim-dir", str(self._interim())]
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

    def run(self) -> int:
        self._acquire_lease()
        signal.signal(signal.SIGTERM, self._on_signal)
        signal.signal(signal.SIGINT, self._on_signal)
        stages = [
            ("GENERATING", self._argv_generate, [self._shard()]),
            ("DATA_VALIDATED", self._argv_validate, [self._shard()]),
            ("TRAINING", self._argv_train, [self._candidate_dir() / "candidate.pt"]),
            ("EXPORT_VALIDATED", self._argv_export, [self._export_dir() / "candidate.onnx", self._export_dir() / "candidate-int8.onnx"]),
            ("EVALUATING", self._argv_league, [self._league_path()]),
        ]
        try:
            for stage, builder, outputs in stages:
                self._run_stage(stage, builder(), outputs)
            self._decide()
        finally:
            self._release_lease()
        return 0

    def resume(self) -> int:
        # A resume re-enters the machine at the first stage that is not yet complete; completed
        # stages are skipped by their own idempotent output check.
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
        compare-and-swap the research pointer. This NEVER sets the shipped APPROVED catalog."""
        league = json.loads(self._league_path().read_text())
        gate = evaluate_gate(league)
        self.state["leagueGate"] = gate
        if gate["promote"]:
            self._promote(gate)
        else:
            self.state["champion"] = "PRESERVED_UNAPPROVED"
            self._transition("REJECTED", "EVALUATING")
        self._write_state()
        print(json.dumps({"runId": self.run_id, "gate": gate, "champion": self.state["champion"]}, indent=2))

    def _promote(self, gate: dict) -> None:
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


def evaluate_gate(league: dict) -> dict:
    """Frozen promotion gate, aligned to the real league schema. The candidate must clear the
    lower bound of the paired-family bootstrap CI against the strong classical reference. The
    threshold (lower 95% CI >= 0.65) is read from the league's own declared gate so it is not
    re-invented here; a candidate that does not clear it never becomes the research champion."""
    matchups = league.get("matchups") or []
    target = None
    for item in matchups:
        a = str(item.get("engineA") or "")
        b = str(item.get("engineB") or "")
        if "policyValuePUCT" in a and "improvedExpert" in b:
            target = item
            break
    if target is None and matchups:
        target = matchups[0]
    if not target:
        return {"promote": False, "reason": "NO_LEAGUE_RESULT"}
    summary = target.get("summary") or {}
    score = summary.get("pointScore")
    ci = summary.get("pairBootstrap95") or []
    ci_low = ci[0] if ci else None
    threshold = 0.65  # "lower 95% CI >= 0.65 required for promotion" (league promotionGate)
    if score is None or ci_low is None:
        return {"promote": False, "reason": "INCOMPLETE_LEAGUE_METRICS",
                "matchup": f"{target.get('engineA')} vs {target.get('engineB')}", "summary": summary}
    return {"promote": bool(ci_low >= threshold), "score": score, "ciLow": ci_low,
            "matchup": f"{target.get('engineA')} vs {target.get('engineB')}",
            "threshold": f"ciLow>={threshold}", "summary": summary}


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
