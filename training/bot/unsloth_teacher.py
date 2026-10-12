#!/usr/bin/env python3
"""CL18-CL20: Unsloth Qwen3.5-0.8B legal-option decision TEACHER (approach B), offline only.

Runs in an ISOLATED DGX venv (`unsloth-env`); it never touches the compact-CNN env, ComfyUI/TTS, or
any system package. It does not serve inference to players and does not publish anything.

Pipeline:
  1. Load the legal-option decision JSONL (produced by training/bot/decision-dataset.cjs) and convert
     each row to the Unsloth decision format (state string + questions/criteria + gold labels).
  2. Family-safe split: the dataset is already split by D4 opening family; we use train for training
     and validation+holdout for evaluation - never train on the held-out families.
  3. Fine-tune Qwen3.5-0.8B with a Clef-style decision head (LoRA) via FastDecisionModel/DecisionTrainer.
  4. Calibrate on the held-out rows and report held-out accuracy, ECE and loss.
  5. Emit a JSON report with model revision, license, hashes, metrics and honest status flags.

If Unsloth's decision API differs from the documented signatures in this environment, the script
reports `UNSLOTH_API_UNAVAILABLE` with the real error instead of fabricating a result.
"""
from __future__ import annotations
import argparse, hashlib, json, os, platform, sys, time
from pathlib import Path

def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def load_rows(path: Path):
    rows = [json.loads(line) for line in path.open() if line.strip()]
    return rows

def questions_block(r):
    """Unsloth decision questions: type + instructions + criteria (all legal moves as options)."""
    return {
        "winNow": {"type": "noul", "instructions": r["questions"]["winNow"]["instructions"]},
        "opponentThreat": {"type": "noul", "instructions": r["questions"]["opponentThreat"]["instructions"]},
        "bestMove": {"type": "choice", "instructions": r["questions"]["bestMove"]["instructions"],
                     "criteria": r["questions"]["bestMove"]["criteria"]},
    }

def gold_block(r):
    """Per-question gold objects matching the typed-decisions schema: each question maps to an answer
    object carrying at least `label` and `type` (and probabilities for a choice). A bare bool/string is
    rejected by the builder ('bool' object is not subscriptable)."""
    return {
        "winNow": {"type": "noul", "label": "true" if r["gold"]["winNow"]["label"] == "true" else "false",
                   "noul": 0.999 if r["gold"]["winNow"]["label"] == "true" else 0.001},
        "opponentThreat": {"type": "noul", "label": "true" if r["gold"]["opponentThreat"]["label"] == "true" else "false",
                           "noul": 0.999 if r["gold"]["opponentThreat"]["label"] == "true" else 0.001},
        "bestMove": {"type": "choice", "label": r["gold"]["bestMove"]["label"],
                     "probabilities": r["gold"]["bestMove"].get("probabilities") or {r["gold"]["bestMove"]["label"]: 1.0}},
    }

def to_unsloth(items):
    """Row wrapper kept for callers/tests: state + questions + gold + split metadata."""
    out = []
    for r in items:
        out.append({"state": r["state"], "questions": questions_block(r), "gold": gold_block(r),
                    "split": r["split"], "id": r["id"]})
    return out

QUESTION_NAMES = ("winNow", "opponentThreat", "bestMove")


def split_evaluation(rows):
    """Family-safe three-way split (WEB-AI-06). The previous evaluation POOLED validation and holdout,
    so the holdout was not untouched confirmation:
      * train        - fit the decision head;
      * calibration  - choose thresholds/early-stop (VALIDATION ONLY);
      * confirmation - the frozen holdout, scored ONCE after calibration, never calibrated on.
    A row missing a family is placed in confirmation only if its split says so; unknown/missing split
    is treated as confirmation (never trained or calibrated on)."""
    train = [r for r in rows if r.get("split") == "train"]
    calibration = [r for r in rows if r.get("split") == "validation"]
    confirmation = [r for r in rows if r.get("split") not in ("train", "validation")]
    return {"train": train, "calibration": calibration, "confirmation": confirmation}


def _label_of(gold):
    value = gold.get("label") if isinstance(gold, dict) else gold
    return str(value)


def _answer_of(answers, name):
    if name not in answers:
        return None
    ans = answers[name]
    return ans.get("answer") if isinstance(ans, dict) else ans


def score_answers(items, answers_by_id, calibration=None):
    """Per-question accuracy over independent families, counting a MISSING/INVALID answer as a FAILURE
    (WEB-AI-06). The earlier loop advanced the denominator only for returned question names, so missing
    answers silently disappeared from the accuracy. Returns per-question and family-level results so a
    binary-question-dominated aggregate cannot hide the choice accuracy."""
    per_question = {name: {"correct": 0, "total": 0, "families": {}} for name in QUESTION_NAMES}
    for r in items:
        family = r.get("family") or r.get("openingFamily") or r.get("id")
        answers = answers_by_id.get(r["id"], {})
        for name in QUESTION_NAMES:
            gold = (r.get("gold") or {}).get(name)
            if gold is None:
                continue
            per_question[name]["total"] += 1
            got = _answer_of(answers, name)
            ok = got is not None and str(got).lower() == _label_of(gold).lower()
            if ok:
                per_question[name]["correct"] += 1
            bucket = per_question[name]["families"].setdefault(family, {"correct": 0, "total": 0})
            bucket["total"] += 1
            bucket["correct"] += 1 if ok else 0
    for name in QUESTION_NAMES:
        entry = per_question[name]
        entry["accuracy"] = (entry["correct"] / entry["total"]) if entry["total"] else None
    return {"perQuestion": per_question,
            "families": sorted({f for name in QUESTION_NAMES for f in per_question[name]["families"]})}

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset", type=Path)
    ap.add_argument("--model", default="unsloth/Qwen3.5-0.8B")
    ap.add_argument("--model-revision", default=None,
                    help="Pinned model revision/commit to load (WEB-AI-06). Required for a qualified run; "
                         "'main'/None is recorded as UNPINNED and blocks qualification.")
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--max-steps", type=int, default=120)
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--max-seq-length", type=int, default=2048)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--eval-only", action="store_true")
    args = ap.parse_args()

    report = {
        "schemaVersion": 1, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": args.model, "modelRevision": args.model_revision,
        "dataset": str(args.dataset), "datasetSha256": sha256_file(args.dataset),
        "host": platform.node(), "python": platform.python_version(), "unsloth": None, "torch": None,
        "cuda": None, "gpu": None, "license": None, "status": "STARTED", "metrics": None,
        "note": "offline teacher evaluation only; no player inference, no publication",
    }
    try:
        import torch  # noqa
        report["torch"] = torch.__version__
        report["cuda"] = bool(torch.cuda.is_available())
        if torch.cuda.is_available():
            report["gpu"] = torch.cuda.get_device_name(0)
        import unsloth  # noqa
        report["unsloth"] = getattr(unsloth, "__version__", "unknown")
        from unsloth import FastDecisionModel, DecisionTrainer  # noqa
    except Exception as exc:  # the real, honest failure - never a fabricated pass
        report["status"] = "UNSLOTH_API_UNAVAILABLE"
        report["error"] = f"{type(exc).__name__}: {exc}"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
        return 2

    rows = to_unsloth(load_rows(args.dataset))
    # Family-safe: TRAIN fits, CALIBRATION is validation-only, CONFIRMATION is the untouched holdout
    # (WEB-AI-06). The teacher must never calibrate on the confirmation families it then reports.
    splits = split_evaluation(rows)
    train_items, eval_items = splits["train"], splits["calibration"]
    confirmation_items = splits["confirmation"]
    report["counts"] = {"train": len(train_items), "calibration": len(eval_items),
                        "confirmation": len(confirmation_items), "total": len(rows)}
    if not train_items or not eval_items:
        report["status"] = "INSUFFICIENT_SPLIT"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
        return 3

    try:
        model, tokenizer = FastDecisionModel.from_pretrained(model_name=args.model, max_seq_length=args.max_seq_length, load_in_4bit=True,
                                                             revision=args.model_revision)
        # The license must be READ from the resolved model card, not hardcoded (WEB-AI-06). A missing
        # license blocks qualification; the revision above pins the exact weights loaded.
        try:
            from huggingface_hub import HfApi
            info = HfApi().model_info(args.model, revision=args.model_revision)
            report["license"] = getattr(info, "cardData", {}).get("license") if getattr(info, "cardData", None) else None
            report["resolvedRevision"] = getattr(info, "sha", None)
        except Exception as exc:
            report["licenseError"] = f"{type(exc).__name__}: {exc}"
        if not args.model_revision:
            report["licensingNote"] = "UNPINNED_REVISION: a qualified result requires --model-revision"
        model = FastDecisionModel.get_peft_model(model, r=args.rank, lora_alpha=args.rank, lora_dropout=0,
                                                 use_gradient_checkpointing="unsloth", random_state=3407)
        # FastDecisionModel consumes a HuggingFace dataset whose rows carry {state, questions, gold}
        # (the typed-decisions schema). Build items through the real builder rather than passing raw
        # dicts - passing raw dicts fails with KeyError: 'input_ids'.
        from datasets import Dataset
        def hf(rows):
            return Dataset.from_list([{"state": r["state"], "questions": questions_block(r), "gold": gold_block(r)} for r in rows])
        if hasattr(FastDecisionModel, "build_dataset"):
            built, build_report = FastDecisionModel.build_dataset(hf(train_items), tokenizer, model)
            eval_built, eval_report = FastDecisionModel.build_dataset(hf(eval_items), tokenizer, model)
            report["buildReport"] = {"train": build_report, "eval": eval_report}
        else:
            built, eval_built = train_items, eval_items
        if not args.eval_only:
            from transformers import TrainingArguments
            trainer = DecisionTrainer(
                model=model, processing_class=tokenizer, train_dataset=built, eval_dataset=eval_built,
                args=TrainingArguments(per_device_train_batch_size=args.batch, gradient_accumulation_steps=args.grad_accum, warmup_steps=10,
                                       max_steps=args.max_steps, learning_rate=args.lr, lr_scheduler_type="cosine",
                                       weight_decay=0.01, bf16=False, fp16=False, eval_strategy="no", logging_steps=5,
                                       output_dir=str(args.output.parent / "trainer"), report_to="none", seed=3407),
            )
            stats = trainer.train()
            report["trainSeconds"] = getattr(stats, "metrics", {}).get("train_runtime")
        metrics = FastDecisionModel.calibrate(model, tokenizer, eval_built) if hasattr(FastDecisionModel, "calibrate") else None
        report["metrics"] = metrics
        report["calibratedOn"] = "validation-only"
        # Per-question breakdown scored ONCE on the untouched CONFIRMATION (holdout) families, with a
        # missing/invalid answer counted as a FAILURE and every independent family present as a
        # denominator (WEB-AI-06). The aggregate is not allowed to hide the bestMove choice accuracy.
        try:
            FastDecisionModel.for_inference(model)
            answers_by_id = {}
            for r in confirmation_items:
                answers_by_id[r["id"]] = FastDecisionModel.predict(model, tokenizer, r["state"], r["questions"]) or {}
            scored = score_answers(confirmation_items, answers_by_id)
            report["perQuestion"] = {k: {"correct": v["correct"], "total": v["total"], "accuracy": v["accuracy"]}
                                     for k, v in scored["perQuestion"].items()}
            report["confirmationFamilies"] = scored["families"]
        except Exception as exc:
            report["perQuestion"] = {"error": f"{type(exc).__name__}: {exc}"}
        report["status"] = "COMPLETED"
    except Exception as exc:
        report["status"] = "TEACHER_RUN_FAILED"
        report["error"] = f"{type(exc).__name__}: {exc}"

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "COMPLETED" else 4

if __name__ == "__main__":
    raise SystemExit(main())
