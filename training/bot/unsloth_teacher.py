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
    return {
        "winNow": bool(r["gold"]["winNow"]["label"] == "true"),
        "opponentThreat": bool(r["gold"]["opponentThreat"]["label"] == "true"),
        "bestMove": r["gold"]["bestMove"]["label"],
    }

def to_unsloth(items):
    """Row wrapper kept for callers/tests: state + questions + gold + split metadata."""
    out = []
    for r in items:
        out.append({"state": r["state"], "questions": questions_block(r), "gold": gold_block(r),
                    "split": r["split"], "id": r["id"]})
    return out

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset", type=Path)
    ap.add_argument("--model", default="unsloth/Qwen3.5-0.8B")
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--max-steps", type=int, default=120)
    ap.add_argument("--max-seq-length", type=int, default=2048)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--eval-only", action="store_true")
    args = ap.parse_args()

    report = {
        "schemaVersion": 1, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": args.model, "dataset": str(args.dataset), "datasetSha256": sha256_file(args.dataset),
        "host": platform.node(), "python": platform.python_version(), "unsloth": None, "torch": None,
        "cuda": None, "gpu": None, "license": "apache-2.0", "status": "STARTED", "metrics": None,
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
    train_items = [r for r in rows if r["split"] == "train"]
    eval_items = [r for r in rows if r["split"] in ("validation", "holdout")]
    report["counts"] = {"train": len(train_items), "eval": len(eval_items), "total": len(rows)}
    if not train_items or not eval_items:
        report["status"] = "INSUFFICIENT_SPLIT"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
        return 3

    try:
        model, tokenizer = FastDecisionModel.from_pretrained(model_name=args.model, max_seq_length=args.max_seq_length, load_in_4bit=True)
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
                args=TrainingArguments(per_device_train_batch_size=2, gradient_accumulation_steps=4, warmup_steps=10,
                                       max_steps=args.max_steps, learning_rate=args.lr, lr_scheduler_type="cosine",
                                       weight_decay=0.01, bf16=True, eval_strategy="no", logging_steps=5,
                                       output_dir=str(args.output.parent / "trainer"), report_to="none", seed=3407),
            )
            stats = trainer.train()
            report["trainSeconds"] = getattr(stats, "metrics", {}).get("train_runtime")
        metrics = FastDecisionModel.calibrate(model, tokenizer, eval_built) if hasattr(FastDecisionModel, "calibrate") else None
        report["metrics"] = metrics
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
