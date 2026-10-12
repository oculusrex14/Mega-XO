#!/usr/bin/env python3
"""Read-only R01 inventory. Source labels and execution/acceptance evidence stay separate.

Run: python3 scripts/v51-readiness-audit.py --output .artifacts/readiness/inventory.json
An exit code of zero means the inventory was produced, NEVER release acceptance.
--strict fails on structural ledger errors. All original ledgers remain untouched.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
from typing import Any

SOURCES = {
    "plan": "Mega-XO-V5-Implementation-Pack/tasks.json",
    "acceptance": "Mega-XO-V5-Implementation-Pack/acceptance.json",
    "progress": "docs/v5/progress.json",
    "bot": "docs/v5.1/bot-ai/progress.json",
    "website": "docs/p21-web/MASTER-CHECKLIST.md",
    "triage": "docs/co-dev/P0-ACCEPTANCE-TRIAGE.json",
    "owners": "docs/v5.1/release/OPEN-WORK-AND-OWNERS.md",
}
LEVELS = ("LOCAL", "CI", "STAGING", "PHYSICAL_DEVICE", "PROVIDER_CONFIGURED",
          "PROVIDER_SUBMITTED", "PROVIDER_APPROVED", "PRODUCTION_ACCEPTED")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def table_cells(line: str) -> list[str]:
    """Split Markdown cells without splitting escaped pipes or inline-code pipes."""
    line = line.strip().strip("|")
    cells, buf, ticks, i = [], [], 0, 0
    while i < len(line):
        if line[i] == "\\" and i + 1 < len(line):
            buf.extend(line[i:i + 2]); i += 2; continue
        if line[i] == "`":
            end = i
            while end < len(line) and line[end] == "`": end += 1
            count = end - i
            ticks = 0 if ticks == count else (count if not ticks else ticks)
            buf.append(line[i:end]); i = end; continue
        if line[i] == "|" and not ticks:
            cells.append("".join(buf).strip()); buf = []
        else:
            buf.append(line[i])
        i += 1
    return cells + ["".join(buf).strip()]


def table_errors(text: str) -> list[dict]:
    errors, width, previous = [], None, None
    for number, line in enumerate(text.splitlines(), 1):
        if not line.lstrip().startswith("|"):
            width, previous = None, None
            continue
        cells = table_cells(line)
        if all(re.fullmatch(r":?-{3,}:?", c) for c in cells):
            width = len(cells)
            if previous is not None and previous != width:
                errors.append({"line": number - 1, "kind": "TABLE_WIDTH", "expected": width, "actual": previous})
        elif width is not None and len(cells) != width:
            errors.append({"line": number, "kind": "TABLE_WIDTH", "expected": width, "actual": len(cells)})
        previous = len(cells)
    return errors


def checkbox_rows(text: str) -> list[dict]:
    rows, heading, occurrences = [], "", Counter()
    for number, line in enumerate(text.splitlines(), 1):
        if re.match(r"^#{1,6}\s", line): heading = line.lstrip("# ").strip()
        match = re.match(r"^\s*[-*]\s+\[([ xX])\]\s+(.+)$", line)
        if not match: continue
        title = match[2].strip()
        explicit = re.match(r"(P21-[A-Z]+\d+)\b", title)
        # Text identity is stable when other checkboxes are closed/reordered. K IDs in the
        # historical register are snapshot-relative and MUST NOT be reassigned here.
        key = explicit[1] if explicit else "P21-TEXT-" + digest((heading + "\n" + title).encode())[:16]
        occurrences[key] += 1
        rows.append({"id": key, "occurrence": occurrences[key], "line": number,
                     "heading": heading, "title": title, "recordedStatus": "CHECKED" if match[1].lower() == "x" else "UNCHECKED"})
    return rows


def resolve_bot(ledger: dict, task: dict) -> dict:
    checkpoint = task.get("checkpoint")
    if checkpoint and checkpoint not in ledger.get("checkpoints", {}):
        raise ValueError("UNKNOWN_BOT_CHECKPOINT:" + checkpoint)
    # The source ledger specifies replacement by field, NOT concatenation of inherited arrays.
    return {**ledger.get("defaults", {}), **ledger.get("checkpoints", {}).get(checkpoint, {}), **task}


def index(rows: list[dict], label: str) -> dict[str, dict]:
    result = {}
    for row in rows:
        key = row["id"]
        if key in result: raise ValueError("DUPLICATE_ID:" + label + ":" + key)
        result[key] = row
    return result


def view(row: dict, status: str, source: str) -> dict:
    return {**row, "source": source, "recordedStatus": status,
            "validation": {level: "NOT_INDEPENDENTLY_EVIDENCED" for level in LEVELS},
            "releaseAccepted": False,
            "disposition": "EXPLICITLY_DEFERRED" if status in ("DEFERRED", "DEFERRED_BY_OWNER", "NOT_TRIGGERED")
            else "BLOCKED" if status == "BLOCKED"
            else "RECORDED_COMPLETION_REQUIRES_ACCEPTANCE" if status in ("COMPLETE", "DONE", "PASS", "CHECKED")
            else "OPEN_REQUIRES_EVIDENCE_REVIEW"}


def source_identity(root: Path) -> dict:
    """Git identity is measured, never supplied as an unverified CLI SHA."""
    try:
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, stderr=subprocess.DEVNULL, text=True).strip()
        dirty = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root, text=True).splitlines()
        return {"head": head, "trackedDirty": dirty, "mode": "GIT_WORKTREE"}
    except (OSError, subprocess.CalledProcessError):
        return {"head": None, "mode": "SOURCE_FILES_ONLY", "note": "Use the independently verified archive manifest; no upstream Git history is inferred."}


def inventory(root: Path) -> dict[str, Any]:
    root = root.resolve()
    raw = {name: (root / path).read_bytes() for name, path in SOURCES.items()}
    data = {name: json.loads(body) for name, body in raw.items() if SOURCES[name].endswith(".json")}
    plan, progress, bot = data["plan"], data["progress"], data["bot"]
    tasks, cases = index(plan["tasks"], "tasks"), index(data["acceptance"]["cases"], "cases")
    live_cases = index(progress["acceptance_cases"], "live cases")
    phases = index(plan["phases"], "phases")
    triage = index(data["triage"]["cases"], "triage")
    evidence = progress["task_evidence"]
    errors = table_errors(raw["owners"].decode())
    for label, original, live in (("task_evidence", set(tasks), set(evidence)), ("acceptance_cases", set(cases), set(live_cases)), ("triage", set(cases), set(triage))):
        if original != live:
            errors.append({"kind": "ID_SET_MISMATCH", "ledger": label, "missing": sorted(original-live), "unknown": sorted(live-original)})
    for tid, row in tasks.items():
        if row["phase"] not in phases or any(dep not in tasks for dep in row.get("depends_on_tasks", [])):
            errors.append({"kind": "ORPHAN_TASK", "id": tid})
    for phase, row in phases.items():
        actual = {tid for tid, task in tasks.items() if task["phase"] == phase}
        if actual != set(row["task_ids"]): errors.append({"kind": "PHASE_MEMBERSHIP", "id": phase})
    records = []
    for tid, task in tasks.items():
        ev = evidence.get(tid, {})
        records.append(view({"id": tid, "phase": task["phase"], "title": task["title"],
                             "requiredVerification": task["verification"], "implementationEvidence": ev}, ev.get("status", "MISSING"), SOURCES["progress"]))
    acceptance = []
    for cid, contract in cases.items():
        live = live_cases.get(cid, {})
        original = {k:v for k,v in contract.items() if k != "status"}
        if any(live.get(k) != v for k,v in original.items()): errors.append({"kind": "ACCEPTANCE_CONTRACT_DRIFT", "id": cid})
        t = triage.get(cid, {})
        acceptance.append(view({**original, "historicalTriage": t, "ownerEvidence": live,
                                "scopeOverride": "A40 website-deferral clause superseded by AGENTS.md; remaining retirement/scaling obligations unchanged." if cid == "A40" else None}, live.get("status", "MISSING"), SOURCES["progress"]))
    bot_rows = [view({"id": tid, "phase": tid.split(".")[0], "resolvedEvidence": resolve_bot(bot, task)}, resolve_bot(bot, task).get("status", "MISSING"), SOURCES["bot"]) for tid, task in bot["tasks"].items()]
    website = [view(r, r["recordedStatus"], SOURCES["website"]) for r in checkbox_rows(raw["website"].decode())]
    for row in website:
        if row["occurrence"] > 1: errors.append({"kind": "DUPLICATE_CHECKBOX", "id": row["id"], "line": row["line"]})
    phase_rows = []
    for phase, row in phases.items():
        members = [r for r in records if r["phase"] == phase]
        phase_rows.append({"id": phase, "title": row["title"], "exitGate": row["exit_gate"],
            "taskStates": dict(Counter(r["recordedStatus"] for r in members)),
            "openTaskIds": [r["id"] for r in members if r["recordedStatus"] != "COMPLETE"],
            "releaseAccepted": False, "scope": "AUTHORIZED_WEBSITE: separate P21 checklist; not deferred" if phase == "P21" else "ORIGINAL_PHASE"})
    groups = {"platformTasks": records, "acceptanceCases": acceptance, "botTasks": bot_rows, "websiteChecks": website}
    return {"schemaVersion": 1, "sourceIdentity": source_identity(root),
        "policy": "Read-only inventory. NOT_INDEPENDENTLY_EVIDENCED does not mean unimplemented or never tested. Historical labels and references are retained, never promoted to release PASS.",
        "releaseAccepted": False,
        "sourceHashes": {SOURCES[k]: digest(v) for k,v in raw.items()},
        "counts": {k: {"total": len(v), "states": dict(Counter(r["recordedStatus"] for r in v))} for k,v in groups.items()},
        "structuralErrors": errors, "phases": phase_rows, **groups}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--strict", action="store_true")
    args = ap.parse_args()
    if args.output.resolve() in {(args.root / p).resolve() for p in SOURCES.values()}:
        ap.error("output must not replace a source ledger")
    try:
        report = inventory(args.root)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        ap.exit(2, f"READINESS_INVENTORY_REFUSED: {exc}\n")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"counts": report["counts"], "structuralErrors": report["structuralErrors"], "releaseAccepted": False}))
    return 2 if args.strict and report["structuralErrors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
