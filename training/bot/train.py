"""Reproducible single-device bootstrap training. DGX execution and model promotion are separate gates."""
from __future__ import annotations
import argparse, gzip, hashlib, json, os, platform, random, re, time, subprocess
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
    parser=argparse.ArgumentParser();parser.add_argument('dataset',type=Path);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--source-commit',required=True);parser.add_argument('--epochs',type=int,default=5);parser.add_argument('--batch',type=int,default=64);parser.add_argument('--seed',type=int,default=51);parser.add_argument('--device',choices=['cpu','cuda'],default='cpu');args=parser.parse_args()
    if not re.fullmatch('[0-9a-f]{40}',args.source_commit) or not 1 <= args.epochs <= 10000 or not 1 <= args.batch <= 4096: parser.error('invalid commit or training limits')
    if args.output.exists(): raise ValueError('OUTPUT_ALREADY_EXISTS')
    if args.device=='cuda' and not torch.cuda.is_available(): raise RuntimeError('CUDA_UNAVAILABLE')
    os.environ.setdefault('CUBLAS_WORKSPACE_CONFIG', ':4096:8');random.seed(args.seed);torch.manual_seed(args.seed);torch.use_deterministic_algorithms(True);torch.set_num_threads(2)
    if torch.cuda.is_available(): torch.cuda.manual_seed_all(args.seed)
    root=Path(__file__).resolve().parents[2];subprocess.run(['node',str(root/'training/bot/validate-data.cjs'),str(args.dataset.resolve())],cwd=root,check=True,capture_output=True)
    manifest,splits=load_records(args.dataset);device=torch.device(args.device);model=TinyPolicyValue().to(device);optimizer=torch.optim.AdamW(model.parameters(),lr=0.001,weight_decay=0.0001);start=time.monotonic();curves=[]
    for epoch in range(args.epochs):
        model.train();indices=list(range(len(splits['train'])));random.Random(args.seed+epoch).shuffle(indices);total=0.;count=0
        for offset in range(0,len(indices),args.batch):
            rows=[splits['train'][i] for i in indices[offset:offset+args.batch]];x,mask,policy,y=tensors(rows,device);optimizer.zero_grad(set_to_none=True);logits,value=model(x);pl,vl=masked_loss(logits,value,mask,policy,y);loss=pl+vl
            if not torch.isfinite(loss): raise ValueError('NONFINITE_LOSS')
            loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.);optimizer.step();total+=float(loss.detach())*len(rows);count+=len(rows)
        model.eval();metrics={'policyLoss':0.,'valueMSE':0.,'top1Agreement':0.,'count':0}
        with torch.no_grad():
            for offset in range(0,len(splits['validation']),args.batch):
                rows=splits['validation'][offset:offset+args.batch];x,mask,policy,y=tensors(rows,device);logits,value=model(x);pl,vl=masked_loss(logits,value,mask,policy,y);n=len(rows);metrics['policyLoss']+=float(pl)*n;metrics['valueMSE']+=float(vl)*n;metrics['top1Agreement']+=float((logits.masked_fill(~mask,-1e9).argmax(1)==policy.argmax(1)).sum());metrics['count']+=n
        curves.append({'epoch':epoch+1,'trainLoss':total/count,'validation':{k:v/metrics['count'] for k,v in metrics.items() if k!='count'}})
    args.output.mkdir(parents=True);checkpoint=args.output/'candidate.pt';model=model.cpu();torch.save({'state_dict':model.state_dict(),'config':model.config,'encodingVersion':ENCODING_VERSION},checkpoint);raw=checkpoint.read_bytes()
    report={'schemaVersion':1,'sourceCommit':args.source_commit,'datasetSha256':manifest['sha256'],'sourceFileHashes':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in ['training/bot/train.py','training/bot/model.py','training/bot/generate.cjs','training/bot/validate-data.cjs','src/bot/encoding.js','src/bot/search.js','src/game.js']},'modelSha256':hashlib.sha256(raw).hexdigest(),'parameters':sum(p.numel() for p in model.parameters()),'checkpointBytes':len(raw),'checkpointGzipBytes':len(gzip.compress(raw,mtime=0)),'modelConfig':model.config,'seed':args.seed,'epochs':args.epochs,'device':str(device),'hardware':torch.cuda.get_device_name() if args.device=='cuda' else platform.processor() or platform.machine(),'torchVersion':torch.__version__,'pythonVersion':platform.python_version(),'elapsedSeconds':time.monotonic()-start,'peakCudaBytes':torch.cuda.max_memory_allocated() if args.device=='cuda' else None,'energyJoules':None,'curves':curves,'splitGames':manifest['counts'],'holdoutUsedForTraining':False,'deploymentStatus':'UNAPPROVED_BOOTSTRAP_CANDIDATE','strengthMeasured':False,'licenseReview':'Original network architecture; dependency/model distribution license sign-off still required'}
    (args.output/'training-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
if __name__=='__main__': main()
