"""Reproducible single-device bootstrap training. DGX execution and model promotion are separate gates."""
from __future__ import annotations
import argparse, gzip, hashlib, json, os, platform, random, re, threading, time, subprocess
from pathlib import Path
import torch
from model import TinyPolicyValue, masked_loss, ENCODING_VERSION

def load_records(path: Path) -> tuple[dict, dict[str, list]]:
    manifest = json.loads(Path(str(path) + '.manifest.json').read_text())
    if hashlib.sha256(path.read_bytes()).hexdigest() != manifest['sha256']:
        raise ValueError('DATASET_HASH_MISMATCH')
    splits = {name: [] for name in ('train', 'validation', 'holdout')}
    games, families = {}, {}
    for line in path.open():
        row = json.loads(line); split = row['split']
        if split not in splits or row['encodingVersion'] != ENCODING_VERSION or row['terminalOutcome'] not in ('X', 'O', 'DRAW'):
            raise ValueError('INVALID_TRAINING_RECORD')
        for table, key in ((games, row['gameId']), (families, row['openingFamily'])):
            if key in table and table[key] != split: raise ValueError('SPLIT_LEAKAGE')
            table[key] = split
        if len(row['planes']) != 648 or len(row['legalMask']) != 81 or len(row['visitTarget']) != 81:
            raise ValueError('INVALID_TENSOR_SHAPE')
        if any(x not in (0, 1) for x in row['planes'] + row['legalMask']) or not any(row['legalMask']):
            raise ValueError('INVALID_PLANES_OR_LEGAL_MASK')
        policy = row['visitTarget']
        if any(not isinstance(p, (int, float)) or not 0 <= p <= 1 or (p and not m) for p, m in zip(policy, row['legalMask'])) or abs(sum(policy)-1) > 1e-5:
            raise ValueError('INVALID_VISIT_DISTRIBUTION')
        expected = 0 if row['terminalOutcome'] == 'DRAW' else 1 if row['terminalOutcome'] == row['player'] else -1
        if row['valueTarget'] != expected: raise ValueError('WRONG_VALUE_PERSPECTIVE')
        splits[split].append(row)
    if not splits['train'] or not splits['validation']: raise ValueError('TRAIN_AND_VALIDATION_GAMES_REQUIRED')
    return manifest, splits

def tensors(rows: list, device: torch.device) -> tuple:
    return (torch.tensor([r['planes'] for r in rows],dtype=torch.float32,device=device).reshape(-1,8,9,9),
            torch.tensor([r['legalMask'] for r in rows],dtype=torch.bool,device=device),
            torch.tensor([r['visitTarget'] for r in rows],dtype=torch.float32,device=device),
            torch.tensor([r['valueTarget'] for r in rows],dtype=torch.float32,device=device))

def main() -> None:
    parser=argparse.ArgumentParser()
    parser.add_argument('dataset',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--source-commit',required=True)
    parser.add_argument('--epochs',type=int,default=5)
    parser.add_argument('--batch',type=int,default=64)
    parser.add_argument('--seed',type=int,default=51)
    parser.add_argument('--device',choices=['cpu','cuda'],default='cpu')
    parser.add_argument('--width',type=int,default=64,choices=[48,64,96,128])
    parser.add_argument('--blocks',type=int,default=4)
    parser.add_argument('--lr',type=float,default=0.001)
    parser.add_argument('--weight-decay',type=float,default=0.0001)
    parser.add_argument('--node-bin',type=str,default='node')
    args=parser.parse_args()
    if not re.fullmatch('[0-9a-f]{40}',args.source_commit) or not 1 <= args.epochs <= 10000 or not 1 <= args.batch <= 4096 or not 1 <= args.blocks <= 6:
        parser.error('invalid commit or training limits')
    if args.output.exists(): raise ValueError('OUTPUT_ALREADY_EXISTS')
    if args.device=='cuda' and not torch.cuda.is_available(): raise RuntimeError('CUDA_UNAVAILABLE')
    os.environ.setdefault('CUBLAS_WORKSPACE_CONFIG', ':4096:8')
    random.seed(args.seed); torch.manual_seed(args.seed); torch.set_num_threads(2)
    determinism = 'enforced'
    try:
        torch.use_deterministic_algorithms(True)
    except Exception:
        try:
            torch.use_deterministic_algorithms(True, warn_only=True)
            determinism = 'warn_only'
        except Exception:
            determinism = 'disabled'
    if torch.cuda.is_available(): torch.cuda.manual_seed_all(args.seed)
    root=Path(__file__).resolve().parents[2]
    subprocess.run([args.node_bin,str(root/'training/bot/validate-data.cjs'),str(args.dataset.resolve())],cwd=root,check=True,capture_output=True)
    manifest,splits=load_records(args.dataset)
    device=torch.device(args.device)
    model=TinyPolicyValue(width=args.width,blocks=args.blocks).to(device)
    optimizer=torch.optim.AdamW(model.parameters(),lr=args.lr,weight_decay=args.weight_decay)
    power_samples = []
    stop_power = threading.Event()
    def sample_power():
        last = time.monotonic()
        while not stop_power.is_set():
            try:
                res = subprocess.run(['nvidia-smi', '--query-gpu=power.draw', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=2)
                if res.returncode == 0:
                    val = float(res.stdout.strip().split()[0])
                    now = time.monotonic()
                    power_samples.append((now - last, val))
                    last = now
            except Exception:
                pass
            time.sleep(0.5)
    power_thread = None
    if args.device == 'cuda':
        power_thread = threading.Thread(target=sample_power, daemon=True)
        power_thread.start()
    start=time.monotonic();curves=[]
    for epoch in range(args.epochs):
        model.train();indices=list(range(len(splits['train'])));random.Random(args.seed+epoch).shuffle(indices);total=0.;count=0
        for offset in range(0,len(indices),args.batch):
            rows=[splits['train'][i] for i in indices[offset:offset+args.batch]];x,mask,policy,y=tensors(rows,device);optimizer.zero_grad(set_to_none=True);logits,value=model(x);pl,vl=masked_loss(logits,value,mask,policy,y);loss=pl+vl
            if not torch.isfinite(loss): raise ValueError('NONFINITE_LOSS')
            loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.);optimizer.step();total+=float(loss.detach())*len(rows);count+=len(rows)
        model.eval()
        metrics={'policyLoss':0.,'valueMSE':0.,'top1Agreement':0.,'top3Agreement':0.,'policyEntropy':0.,'count':0}
        val_preds, val_targets = [], []
        with torch.no_grad():
            for offset in range(0,len(splits['validation']),args.batch):
                rows=splits['validation'][offset:offset+args.batch];x,mask,policy,y=tensors(rows,device);logits,value=model(x)
                pl,vl=masked_loss(logits,value,mask,policy,y);n=len(rows)
                metrics['policyLoss']+=float(pl)*n;metrics['valueMSE']+=float(vl)*n
                masked_logits = logits.masked_fill(~mask, -1e9)
                top1 = (masked_logits.argmax(1)==policy.argmax(1)).sum()
                metrics['top1Agreement']+=float(top1)
                top3 = (masked_logits.topk(min(3, masked_logits.shape[1]), dim=1).indices == policy.argmax(1, keepdim=True)).any(dim=1).sum()
                metrics['top3Agreement']+=float(top3)
                probs = torch.softmax(masked_logits, dim=1)
                entropy = -(probs * torch.log(probs + 1e-12)).sum(1).mean()
                metrics['policyEntropy']+=float(entropy)*n
                metrics['count']+=n
                val_preds.extend(value.flatten().tolist())
                val_targets.extend(y.flatten().tolist())
        # 5-bin value calibration
        bins = [(-1.0, -0.6), (-0.6, -0.2), (-0.2, 0.2), (0.2, 0.6), (0.6, 1.0)]
        calibration = []
        for lo, hi in bins:
            in_bin = [(p, t) for p, t in zip(val_preds, val_targets) if (lo <= p <= hi if hi == 1.0 else lo <= p < hi)]
            b_count = len(in_bin)
            b_pred = sum(p for p, _ in in_bin) / b_count if b_count else None
            b_target = sum(t for _, t in in_bin) / b_count if b_count else None
            b_err = abs(b_pred - b_target) if b_count else None
            calibration.append({'bin': [lo, hi], 'count': b_count, 'meanPredicted': b_pred, 'meanTarget': b_target, 'absError': b_err})
        val_summary = {k: v/metrics['count'] for k, v in metrics.items() if k != 'count'}
        val_summary['calibration'] = calibration
        curves.append({'epoch':epoch+1,'trainLoss':total/count,'validation':val_summary})
    if power_thread:
        stop_power.set()
        power_thread.join(timeout=2)
    energy_joules = sum(dt * p for dt, p in power_samples) if power_samples else None
    mean_power_watts = (sum(p for _, p in power_samples) / len(power_samples)) if power_samples else None
    peak_power_watts = max((p for _, p in power_samples), default=None)
    args.output.mkdir(parents=True);checkpoint=args.output/'candidate.pt';model=model.cpu();torch.save({'state_dict':model.state_dict(),'config':model.config,'encodingVersion':ENCODING_VERSION},checkpoint);raw=checkpoint.read_bytes()
    report={'schemaVersion':1,'sourceCommit':args.source_commit,'datasetSha256':manifest['sha256'],'sourceFileHashes':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in ['training/bot/train.py','training/bot/model.py','training/bot/generate.cjs','training/bot/validate-data.cjs','src/bot/encoding.js','src/bot/search.js','src/game.js']},'modelSha256':hashlib.sha256(raw).hexdigest(),'parameters':sum(p.numel() for p in model.parameters()),'checkpointBytes':len(raw),'checkpointGzipBytes':len(gzip.compress(raw,mtime=0)),'modelConfig':model.config,'seed':args.seed,'epochs':args.epochs,'device':str(device),'hardware':torch.cuda.get_device_name() if args.device=='cuda' else platform.processor() or platform.machine(),'torchVersion':torch.__version__,'pythonVersion':platform.python_version(),'elapsedSeconds':time.monotonic()-start,'peakCudaBytes':torch.cuda.max_memory_allocated() if args.device=='cuda' else None,'peakCudaReservedBytes':torch.cuda.max_memory_reserved() if args.device=='cuda' else None,'energyJoules':energy_joules,'meanPowerWatts':mean_power_watts,'peakPowerWatts':peak_power_watts,'determinism':determinism,'curves':curves,'splitGames':manifest['counts'],'holdoutUsedForTraining':False,'deploymentStatus':'UNAPPROVED_BOOTSTRAP_CANDIDATE','strengthMeasured':False,'licenseReview':'Original network architecture; dependency/model distribution license sign-off still required'}
    (args.output/'training-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
if __name__=='__main__': main()
