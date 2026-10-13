"""Reproducible single-device bootstrap training. DGX execution and model promotion are separate gates."""
from __future__ import annotations
import argparse, gzip, hashlib, json, os, platform, random, re, threading, time, subprocess
from pathlib import Path
import torch
from model import TinyPolicyValue, masked_loss, ENCODING_VERSION

def load_records(path: Path, value_source: str = 'all') -> tuple[dict, dict[str, list]]:
    manifest = json.loads(Path(str(path) + '.manifest.json').read_text())
    if hashlib.sha256(path.read_bytes()).hexdigest() != manifest['sha256']:
        raise ValueError('DATASET_HASH_MISMATCH')
    splits = {name: [] for name in ('train', 'validation', 'holdout')}
    games, families, sources = {}, {}, {}
    filtered = 0
    for line in path.open():
        row = json.loads(line); split = row['split']
        if split not in splits or row['encodingVersion'] != ENCODING_VERSION or row['terminalOutcome'] not in ('X', 'O', 'DRAW'):
            raise ValueError('INVALID_TRAINING_RECORD')
        # Leakage tables are built from EVERY row (even filtered ones) so a source filter can never
        # hide a train/validation family overlap.
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
        # SEPARATE LABEL TARGET TYPES. A row's `valueTarget` is only comparable to another row's when
        # both declare the SAME source. A "terminal-outcome" target is the actual game result (a noisy
        # but honest label); a "deep-search-root-score" target is a bounded look-ahead evaluation. They
        # must never be silently averaged together as if equivalent. Canonicalise the source, count each
        # kind, and record the mix on the manifest so it is always visible in the training report.
        source = row.get('valueTargetSource') or 'terminal-outcome'
        if source == 'terminal-outcome':
            if row['valueTarget'] != expected: raise ValueError('WRONG_VALUE_PERSPECTIVE')
        else:
            if not isinstance(row['valueTarget'], (int, float)) or not -1.0 <= row['valueTarget'] <= 1.0:
                raise ValueError('INVALID_VALUE_TARGET')
            if row.get('terminalValue') != expected: raise ValueError('TERMINAL_VALUE_MISMATCH')
        sources[source] = sources.get(source, 0) + 1
        # Optional: restrict training to one target type (a clean same-semantics experiment). Rows of
        # other sources are still validated and still count for leakage, but are not fed to the model.
        if value_source == 'all' or source == value_source:
            splits[split].append(row)
        else:
            filtered += 1
    if not splits['train'] or not splits['validation']: raise ValueError('TRAIN_AND_VALIDATION_GAMES_REQUIRED')
    manifest['valueTargetSources'] = dict(sorted(sources.items()))
    manifest['mixedValueTargets'] = len(sources) > 1
    manifest['valueTargetSourceFilter'] = value_source
    manifest['valueTargetRowsFilteredOut'] = filtered
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
    parser.add_argument('--interim-dir',type=Path,default=None)
    parser.add_argument('--resume',type=Path,default=None)
    parser.add_argument('--value-source',type=str,default='all',choices=['all','terminal-outcome','deep-search-root-score'],help='Restrict training to rows of ONE value-target semantics (never silently mix terminal outcomes and search-root scores). "all" keeps every row but records the mix.')
    parser.add_argument('--early-stop-patience',type=int,default=0,help='Stop after this many epochs with no improvement in the best-validation metric (0 disables).')
    args=parser.parse_args()
    if not re.fullmatch('[0-9a-f]{40}',args.source_commit) or not 1 <= args.epochs <= 10000 or not 1 <= args.batch <= 4096 or not 1 <= args.blocks <= 6:
        parser.error('invalid commit or training limits')
    if args.output.exists() and args.resume is None: raise ValueError('OUTPUT_ALREADY_EXISTS')
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
    manifest,splits=load_records(args.dataset, args.value_source)
    device=torch.device(args.device)
    model=TinyPolicyValue(width=args.width,blocks=args.blocks).to(device)
    optimizer=torch.optim.AdamW(model.parameters(),lr=args.lr,weight_decay=args.weight_decay)
    resume_meta=None
    if args.resume is not None:
        # Warm start from a prior checkpoint (or an operator-persisted interim checkpoint): restore the
        # model AND optimizer, and continue at the recorded epoch. The dataset hash and config must
        # match, so a resumed run never silently drifts onto different data or hyperparameters.
        ck=torch.load(args.resume,map_location=device,weights_only=False)
        if ck.get('datasetSha256')!=manifest['sha256']: raise ValueError('RESUME_DATASET_MISMATCH')
        if ck.get('modelConfig',{}).get('width')!=args.width or ck.get('modelConfig',{}).get('blocks')!=args.blocks: raise ValueError('RESUME_CONFIG_MISMATCH')
        model.load_state_dict(ck['state_dict'])
        if 'optimizer' in ck: optimizer.load_state_dict(ck['optimizer'])
        if 'rng' in ck:
            random.setstate(ck['rng']['python']); torch.set_rng_state(ck['rng']['torch'])
        resume_meta={'resumedFromEpoch':int(ck.get('epoch',0)),'resumedFrom':str(args.resume)}
    start_epoch = resume_meta['resumedFromEpoch'] if resume_meta else 0
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
    # Best-validation model selection (the audit finding: the final-epoch model was always kept, and
    # the checkpoint was written before the validation metric existed). We now keep the model state at
    # the epoch with the lowest validation policy+value loss and export THAT, and record which epoch and
    # what score it won on, so the exported artifact provably corresponds to the reported validation.
    best_metric=float('inf');best_epoch=0;best_state=None;best_summary=None;epochs_without_improvement=0
    for epoch in range(start_epoch,args.epochs):
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
        # Keep the best-validation model state (a deep copy off the GPU so memory stays bounded).
        metric = val_summary['policyLoss'] + val_summary['valueMSE']
        if metric < best_metric - 1e-9:
            best_metric = metric; best_epoch = epoch + 1
            best_state = {k: v.detach().to('cpu').clone() for k, v in model.state_dict().items()}
            best_summary = {'epoch': best_epoch, 'policyLoss': val_summary['policyLoss'], 'valueMSE': val_summary['valueMSE'],
                            'top1Agreement': val_summary['top1Agreement'], 'combinedMetric': metric}
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
        if args.interim_dir is not None:
            # Durable interim checkpoint after EVERY epoch: a killed process resumes from the last
            # completed epoch. Written atomically via a temp file + rename so a crash mid-write cannot
            # leave a half-written checkpoint that resume would then reject.
            args.interim_dir.mkdir(parents=True,exist_ok=True)
            interim={'state_dict':model.state_dict(),'optimizer':optimizer.state_dict(),
                     'rng':{'python':random.getstate(),'torch':torch.get_rng_state()},
                     'config':model.config,'modelConfig':model.config,'encodingVersion':ENCODING_VERSION,
                     'epoch':epoch+1,'datasetSha256':manifest['sha256'],'seed':args.seed,
                     'width':args.width,'blocks':args.blocks,'sourceCommit':args.source_commit,
                     'bestEpoch':best_epoch,'bestMetric':best_metric}
            tmp=args.interim_dir/('interim.pt.tmp')
            torch.save(interim,tmp);os.replace(tmp,args.interim_dir/'interim.pt')
        # Early stopping (opt-in): stop once validation has not improved for N epochs. The BEST
        # checkpoint is still the one exported, so stopping early never degrades the artifact.
        if args.early_stop_patience and epochs_without_improvement >= args.early_stop_patience:
            print(json.dumps({'earlyStop': True, 'atEpoch': epoch + 1, 'bestEpoch': best_epoch, 'bestMetric': best_metric}))
            break
    if power_thread:
        stop_power.set()
        power_thread.join(timeout=2)
    energy_joules = sum(dt * p for dt, p in power_samples) if power_samples else None
    mean_power_watts = (sum(p for _, p in power_samples) / len(power_samples)) if power_samples else None
    peak_power_watts = max((p for _, p in power_samples), default=None)
    args.output.mkdir(parents=True);checkpoint=args.output/'candidate.pt'
    # Export the BEST-validation state, not the final epoch (which is typically overfit). If no epoch
    # improved on the initial metric, fall back to the live model rather than writing nothing.
    selection = {'policy': 'best-validation (lowest validation policyLoss+valueMSE)', 'bestEpoch': best_epoch,
                 'bestMetric': best_metric, 'bestValidation': best_summary, 'epochsRun': len(curves),
                 'finalEpochCombinedMetric': (curves[-1]['validation']['policyLoss'] + curves[-1]['validation']['valueMSE']) if curves else None,
                 'earlyStopped': bool(args.early_stop_patience and epochs_without_improvement >= args.early_stop_patience)}
    if best_state is not None:
        model.load_state_dict(best_state)
    model=model.cpu();torch.save({'state_dict':model.state_dict(),'config':model.config,'encodingVersion':ENCODING_VERSION},checkpoint);raw=checkpoint.read_bytes()
    report={'schemaVersion':1,'sourceCommit':args.source_commit,'datasetSha256':manifest['sha256'],'sourceFileHashes':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in ['training/bot/train.py','training/bot/model.py','training/bot/generate.cjs','training/bot/validate-data.cjs','src/bot/encoding.js','src/bot/search.js','src/game.js']},'modelSha256':hashlib.sha256(raw).hexdigest(),'parameters':sum(p.numel() for p in model.parameters()),'checkpointBytes':len(raw),'checkpointGzipBytes':len(gzip.compress(raw,mtime=0)),'modelConfig':model.config,'seed':args.seed,'epochs':args.epochs,'device':str(device),'hardware':torch.cuda.get_device_name() if args.device=='cuda' else platform.processor() or platform.machine(),'torchVersion':torch.__version__,'pythonVersion':platform.python_version(),'elapsedSeconds':time.monotonic()-start,'peakCudaBytes':torch.cuda.max_memory_allocated() if args.device=='cuda' else None,'peakCudaReservedBytes':torch.cuda.max_memory_reserved() if args.device=='cuda' else None,'energyJoules':energy_joules,'meanPowerWatts':mean_power_watts,'peakPowerWatts':peak_power_watts,'determinism':determinism,'curves':curves,'splitGames':manifest['counts'],'valueTargetSources':manifest.get('valueTargetSources'),'mixedValueTargets':manifest.get('mixedValueTargets'),'valueTargetSourceFilter':manifest.get('valueTargetSourceFilter'),'selection':selection,'holdoutUsedForTraining':False,'deploymentStatus':'UNAPPROVED_BOOTSTRAP_CANDIDATE','strengthMeasured':False,'licenseReview':'Original network architecture; dependency/model distribution license sign-off still required','resume':resume_meta}
    (args.output/'training-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
if __name__=='__main__': main()
