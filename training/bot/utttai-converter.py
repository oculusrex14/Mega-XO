#!/usr/bin/env python3
"""utttai -> Mega XOXO V5.1 off-policy supervision converter.

Reads ``arnowaczynski/utttai`` MCTS/NMCTS dataset rows (``depthNN.txt``, one
dataset row per line) and emits a NEW, non-complete-game record shape holding
only what the external corpus actually contains: our own ``planes``/``legalMask``
(re-encoded from their 93-byte state with OUR ``src/bot/encoding.js``), a
normalised visit target, and their root mean state value with an explicit
non-terminal source. It NEVER invents a game id, opening family, split, terminal
outcome or complete game (see docs/v5.1/research/utttai-analysis.md §5).

Design and rejection guards follow §5.2/§5.3 of
``docs/v5.1/research/utttai-analysis.md``. Every guard is counted; a rejected row
is dropped and never repaired.

Usage:
    python3 training/bot/utttai-converter.py \
        --archive /path/stage1-mcts.7z --member stage1-mcts/depth00.txt \
        --limit 200000 --split external --out .artifacts/v51/utttai-depth00.jsonl --stats
    python3 training/bot/utttai-converter.py --file depth00.txt --out out.jsonl
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GAME_JS = REPO / "src" / "game.js"
ENCODING_JS = REPO / "src" / "bot" / "encoding.js"

SCHEMA_VERSION = 1
SOURCE = "utttai"
SPLIT = "external"
VALUE_SOURCE = {
    "stage1": "utttai-mcts-root-mean",
    "stage2": "utttai-nmcts-root-value",
}
# Root-value / action-value consistency tolerance. Text format rounds to 6
# decimals; the analysis measured max|delta| = 2.0e-4 (stage2), 2.0e-6 (stage1).
VALUE_TOL = 1e-3
BATCH = 2000

ROW_RE = re.compile(r"^evaluatedState\{(?P<state>[^}]*)\}\s*evaluatedActions\{(?P<actions>.*)\}\s*$")

# --------------------------------------------------------------------------- #
# Node engine bridge: rebuild our canonical state, recompute legal set, encode.
# --------------------------------------------------------------------------- #
NODE_SCRIPT = r"""
'use strict';
const G=require(process.argv[2]),E=require(process.argv[3]);
const out=process.stdout;
function handle(it){
  const st=it.st;
  const board=Array.from({length:9},()=>Array(9).fill(null));
  for(let i=0;i<81;i++){const v=st[i];if(v)board[(i/9)|0][i%9]=v===1?'X':'O';}
  const mini=Array(9).fill(null);
  for(let b=0;b<9;b++){const v=st[81+b];mini[b]=v===1?'X':v===2?'O':v===3?'DRAW':null;}
  const turn=st[90]===1?'X':'O';
  const required=st[91]===9?null:st[91];
  const winner=st[92]===0?null:(st[92]===1?'X':st[92]===2?'O':'DRAW');
  const state={board,mini,turn,required,winner,line:null,moves:[]};
  // 4a. macro claims must be reproduced by our own winner() on the sub-board.
  for(let b=0;b<9;b++){
    const w=G.winner(board[b]);
    if(mini[b]==='X'||mini[b]==='O'){if(!w||w.player!==mini[b])return {ok:false,err:'MACRO_MISMATCH'};}
    else if(mini[b]==='DRAW'){if(w||!board[b].every(Boolean))return {ok:false,err:'MACRO_MISMATCH'};}
    else {if(w||board[b].every(Boolean))return {ok:false,err:'MACRO_MISMATCH'};}
  }
  // 4b. the mega result must agree with our winner() over the macro board.
  const big=G.winner(mini);
  const bigPlayer=big?big.player:null;
  if(winner==='DRAW'){if(bigPlayer||!mini.every(Boolean))return {ok:false,err:'MEGA_MISMATCH'};}
  else if(bigPlayer!==winner)return {ok:false,err:'MEGA_MISMATCH'};
  // 4c. routing to a resolved subgame must have been normalised to free (9).
  if(required!==null&&mini[required]!==null)return {ok:false,err:'RULE_CONSTRAINT'};
  // 4d. X-first parity: the mover may never have fewer stones than the opponent.
  let cx=0,co=0;for(let i=0;i<81;i++){const v=st[i];if(v===1)cx++;else if(v===2)co++;}
  if(turn==='X'?cx!==co:cx!==co+1)return {ok:false,err:'PARITY'};
  const legal=G.legal(state);
  if(!legal.length)return {ok:false,err:'NO_LEGAL'};
  const e=E.encode(state);
  return {ok:true,legal:legal.map(m=>m.b*9+m.c),
          planes:Buffer.from(e.planes).toString('base64'),mask:Buffer.from(e.mask).toString('base64'),player:e.player};
}
process.stdin.setEncoding('utf8');
let buf='';
process.stdin.on('data',d=>{
  buf+=d;let nl;
  while((nl=buf.indexOf('\n'))>=0){
    const line=buf.slice(0,nl);buf=buf.slice(nl+1);
    if(!line)continue;
    const items=JSON.parse(line);
    const res=items.map(handle);
    out.write(JSON.stringify(res)+'\n');
  }
});
process.stdin.on('end',()=>process.exit(0));
"""


class Stats:
    def __init__(self) -> None:
        self.rows_in = 0
        self.reject = {}
        self.rows_out = 0
        self.dup_dropped = 0
        self.legal_set_mismatch_samples: list = []
        self.value_delta_max = 0.0

    def bump(self, key: str) -> None:
        self.reject[key] = self.reject.get(key, 0) + 1

    def as_dict(self) -> dict:
        return {
            "rowsIn": self.rows_in,
            "rowsOut": self.rows_out,
            "dedupDropped": self.dup_dropped,
            "rejected": sum(self.reject.values()),
            "rejections": dict(sorted(self.reject.items())),
            "maxValueConsistencyDelta": self.value_delta_max,
        }


def parse_state(token: str):
    """Guard 1-2: 93 digits, cells in {0,1,2}, mover/routing/result in range."""
    if len(token) != 93 or not token.isdigit():
        return None, "state_parse"
    st = [ord(c) - 48 for c in token]
    for i in range(81):
        if st[i] > 2:
            return None, "state_parse"
    if st[90] not in (1, 2) or not (0 <= st[91] <= 9) or st[92] not in (0, 1, 2, 3):
        return None, "field_range"
    if st[92] != 0:
        return None, "terminal_row"
    return st, None


def parse_actions(kind: str, blob: str):
    """Guard 6: token grammar, index range/dup, symbol == mover."""
    acts = []
    parts = blob.split(",")
    want = 6 if kind == "stage1" else 4
    for p in parts:
        t = p.split()
        if len(t) != want:
            return None, "row_shape"
        if kind == "stage1":
            try:
                sym, idx, vis, w, d, l = (int(x) for x in t)
            except ValueError:
                return None, "row_shape"
            if vis <= 0 or w < 0 or d < 0 or l < 0:
                return None, "visit_invariants"
            acts.append({"sym": sym, "idx": idx, "vis": vis, "v": (w - l) / vis})
        else:
            try:
                sym = int(t[0]); idx = int(t[1]); vis = int(t[2]); mean = float(t[3])
            except ValueError:
                return None, "row_shape"
            if vis <= 0:
                return None, "visit_invariants"
            acts.append({"sym": sym, "idx": idx, "vis": vis, "v": mean})
    return acts, None


def main() -> int:
    ap = argparse.ArgumentParser(description="Convert utttai dataset rows to Mega XOXO off-policy supervision records.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--archive", type=Path, help=".7z archive containing depthNN.txt members")
    src.add_argument("--file", type=Path, help="a plain depthNN.txt file")
    ap.add_argument("--member", help="member name inside the archive, e.g. stage1-mcts/depth40.txt")
    ap.add_argument("--limit", type=int, default=0, help="max rows read from the member (0 = all)")
    ap.add_argument("--kind", choices=("auto", "stage1", "stage2"), default="auto",
                    help="row grammar (auto: detect from member/file name)")
    ap.add_argument("--split", default=SPLIT, help="external split label (only 'external' is supported)")
    ap.add_argument("--out", type=Path, required=True, help="output .jsonl path")
    ap.add_argument("--tmp", type=Path, default=None, help="scratch dir for member extraction (default: archive dir)")
    ap.add_argument("--stats", action="store_true", help="print the rejection histogram")
    args = ap.parse_args()

    if args.split != SPLIT:
        raise SystemExit(f"unsupported --split {args.split!r} (only {SPLIT!r} is supported; do not invent splits)")

    # ----- resolve source member -------------------------------------------- #
    tmpdir = None
    if args.archive:
        import py7zr  # imported lazily so --file needs no py7zr
        if not args.member:
            raise SystemExit("--member is required with --archive")
        arc = args.archive
        with py7zr.SevenZipFile(arc, "r") as z:
            names = [n for n in z.getnames() if n.endswith(".txt")]
        member = args.member
        if member not in names:
            cand = [n for n in names if n == member or n.endswith("/" + member)]
            if len(cand) != 1:
                raise SystemExit(f"--member {member!r} not found in {arc} ({len(cand)} candidates)")
            member = cand[0]
        kind = args.kind if args.kind != "auto" else ("stage1" if "stage1" in member or "stage1" in arc.name else "stage2")
        scratch = args.tmp or arc.parent
        keep = Path(tempfile.mkdtemp(prefix="utttai-", dir=str(scratch)))
        with py7zr.SevenZipFile(arc, "r") as z:
            z.extract(path=str(keep), targets=[member])
        txt = keep / member
        depth_file = member
    else:
        txt = args.file
        blob = str(txt)
        kind = args.kind if args.kind != "auto" else ("stage2" if "stage2" in blob else "stage1")
        depth_file = txt.name
        keep = Path(tempfile.mkdtemp(prefix="utttai-"))

    value_source = VALUE_SOURCE[kind]
    encoding_version = subprocess.check_output(
        ["node", "-e", f"process.stdout.write(require({json.dumps(str(ENCODING_JS))}).VERSION)"], text=True).strip()

    # ----- node bridge ------------------------------------------------------ #
    node_script = keep / "_bridge.cjs"
    node_script.write_text(NODE_SCRIPT)
    proc = subprocess.Popen(
        ["node", str(node_script), str(GAME_JS), str(ENCODING_JS)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
    )

    stats = Stats()
    seen: dict[str, tuple] = {}   # canonical state -> (root_visits, record)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    out_f = args.out.open("w")

    def flush(batch_items, batch_meta):
        """Send survivors to node, apply guards 4 & 5, emit records."""
        proc.stdin.write(json.dumps(batch_items) + "\n")
        proc.stdin.flush()
        results = json.loads(proc.stdout.readline())
        for meta, res in zip(batch_meta, results):
            if not res["ok"]:
                stats.bump("engine_reject:" + res["err"])
                continue
            legal = set(res["legal"])
            if legal != meta["their_set"]:
                stats.bump("legal_set_mismatch")
                if len(stats.legal_set_mismatch_samples) < 5:
                    stats.legal_set_mismatch_samples.append(
                        {"state": meta["state_token"], "ours": sorted(legal), "theirs": sorted(meta["their_set"])})
                continue
            planes = list(base64.b64decode(res["planes"]))
            mask = list(base64.b64decode(res["mask"]))
            total = meta["sum_vis"]
            visit = [0.0] * 81
            for a in meta["acts"]:
                visit[a["idx"]] = round(a["vis"] / total, 9)
            rec = {
                "schemaVersion": SCHEMA_VERSION,
                "encodingVersion": meta["encoding_version"],
                "source": SOURCE,
                "valueTargetSource": value_source,
                "planes": planes,
                "legalMask": mask,
                "visitTarget": visit,
                "valueTarget": meta["value"],
                "externalSplit": SPLIT,
                "utttai": {"depthFile": depth_file, "stateSha256": meta["state_sha"]},
            }
            key = meta["state_token"]
            prev = seen.get(key)
            if prev is not None:
                stats.dup_dropped += 1
                if meta["root_visits"] > prev[0]:
                    seen[key] = (meta["root_visits"], rec)
                continue
            seen[key] = (meta["root_visits"], rec)

    batch_items, batch_meta = [], []
    with txt.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            if args.limit and stats.rows_in >= args.limit:
                break
            stats.rows_in += 1
            m = ROW_RE.match(line)
            if not m:
                stats.bump("row_shape")
                continue
            head = m.group("state").split()
            if len(head) != (5 if kind == "stage1" else 3):
                stats.bump("row_shape")
                continue
            state_token = head[0]
            st, err = parse_state(state_token)
            if err:
                stats.bump(err)
                continue
            acts, err = parse_actions(kind, m.group("actions"))
            if err:
                stats.bump(err)
                continue
            their_set = set()
            bad = False
            for a in acts:
                if a["idx"] < 0 or a["idx"] > 80 or a["idx"] in their_set or a["sym"] != st[90]:
                    bad = True
                    break
                their_set.add(a["idx"])
            if bad:
                stats.bump("bad_action_index")
                continue
            sum_vis = sum(a["vis"] for a in acts)
            if kind == "stage1":
                try:
                    rv, w, d, l = (int(x) for x in head[1:5])
                except ValueError:
                    stats.bump("row_shape")
                    continue
                if rv <= 0 or w < 0 or d < 0 or l < 0 or w + d + l != rv:
                    stats.bump("visit_invariants")
                    continue
                root_visits = rv
                value = (w - l) / rv
            else:
                try:
                    root_visits = int(head[1]); value = float(head[2])
                except ValueError:
                    stats.bump("value_range")
                    continue
            if sum_vis <= 0 or sum_vis != root_visits - 1:
                stats.bump("visit_invariants")
                continue
            if not (-1.0 <= value <= 1.0):
                stats.bump("value_range")
                continue
            predicted = sum(a["vis"] * a["v"] for a in acts) / sum_vis
            delta = abs(predicted - value)
            stats.value_delta_max = max(stats.value_delta_max, delta)
            if delta > VALUE_TOL:
                stats.bump("value_range_consistency")
                continue
            batch_items.append({"st": st})
            batch_meta.append({
                "state_token": state_token,
                "state_sha": hashlib.sha256(state_token.encode()).hexdigest(),
                "their_set": their_set, "acts": acts, "sum_vis": sum_vis,
                "root_visits": root_visits, "value": round(value, 6),
                "encoding_version": encoding_version,
            })
            if len(batch_items) >= BATCH:
                flush(batch_items, batch_meta)
                batch_items, batch_meta = [], []
    if batch_items:
        flush(batch_items, batch_meta)

    proc.stdin.close()
    proc.wait()

    for _, (_, rec) in seen.items():
        out_f.write(json.dumps(rec, separators=(",", ":")) + "\n")
        stats.rows_out += 1
    out_f.close()

    if keep:
        import shutil
        shutil.rmtree(keep, ignore_errors=True)

    summary = {
        "member": depth_file, "kind": kind, "valueTargetSource": value_source,
        "split": SPLIT, "out": str(args.out), **stats.as_dict(),
        "sha256": hashlib.sha256(args.out.read_bytes()).hexdigest(),
    }
    if stats.legal_set_mismatch_samples:
        summary["legalSetMismatchSamples"] = stats.legal_set_mismatch_samples
    print(json.dumps(summary, indent=2))
    if args.stats:
        print("rejection histogram:", json.dumps(summary["rejections"], indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
