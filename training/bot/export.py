"""Export an unapproved candidate; numerical/size checks never promote playing strength."""
from __future__ import annotations
import argparse, gzip, hashlib, json, random
from pathlib import Path
import numpy as np
import torch
import onnx
import onnxruntime as ort
from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static
from model import TinyPolicyValue, ENCODING_VERSION
from train import load_records

def facts(path: Path) -> dict:
    raw=path.read_bytes()
    return {'file':path.name,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'gzipBytes':len(gzip.compress(raw,mtime=0))}

def main() -> None:
    parser=argparse.ArgumentParser();parser.add_argument('candidate',type=Path);parser.add_argument('dataset',type=Path);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    if args.output.exists(): raise ValueError('OUTPUT_ALREADY_EXISTS')
    report=json.loads((args.candidate/'training-report.json').read_text());checkpoint=args.candidate/'candidate.pt'
    if facts(checkpoint)['sha256']!=report['modelSha256']: raise ValueError('CHECKPOINT_HASH_MISMATCH')
    saved=torch.load(checkpoint,map_location='cpu',weights_only=True)
    if saved['encodingVersion']!=ENCODING_VERSION: raise ValueError('ENCODING_MISMATCH')
    model=TinyPolicyValue(width=saved['config']['width'],blocks=saved['config']['blocks']);model.load_state_dict(saved['state_dict']);model.eval();torch.set_num_threads(2)
    manifest,splits=load_records(args.dataset)
    if manifest['sha256']!=report['datasetSha256']: raise ValueError('WRONG_DATASET')
    rows=[r for split in splits.values() for r in split];random.Random(5101).shuffle(rows);rows=rows[:512]
    if len(rows)<200: raise ValueError('AT_LEAST_200_FROZEN_STATES_REQUIRED')
    args.output.mkdir(parents=True);static=args.output/'candidate.onnx';dynamic=args.output/'candidate-dynamic.onnx';quant=args.output/'candidate-int8.onnx'
    options=dict(input_names=['planes'],output_names=['policy','value'],external_data=False,opset_version=18)
    try:
        torch.onnx.export(model,(torch.zeros(1,8,9,9),),str(static),dynamo=True,**options)
        torch.onnx.export(model,(torch.zeros(2,8,9,9),),str(dynamic),dynamo=True,dynamic_shapes=({0:torch.export.Dim('batch',min=1,max=64)},),**options)
    except Exception:
        torch.onnx.export(model,(torch.zeros(1,8,9,9),),str(static),dynamo=False,**options)
        torch.onnx.export(model,(torch.zeros(2,8,9,9),),str(dynamic),dynamo=False,dynamic_axes={'planes':{0:'batch'},'policy':{0:'batch'},'value':{0:'batch'}},**options)
    for file in (static,dynamic): onnx.checker.check_model(str(file))
    options_ort=ort.SessionOptions();options_ort.intra_op_num_threads=1;options_ort.inter_op_num_threads=1
    single=ort.InferenceSession(str(static),sess_options=options_ort,providers=['CPUExecutionProvider']);batch=ort.InferenceSession(str(dynamic),sess_options=options_ort,providers=['CPUExecutionProvider'])
    max_policy=0.;max_value=0.;rank_changes=0;golden=[]
    for row in rows:
        x=np.asarray(row['planes'],dtype=np.float32).reshape(1,8,9,9);mask=np.asarray(row['legalMask'],dtype=bool)
        with torch.no_grad(): p,v=model(torch.from_numpy(x));p=p.numpy();v=v.numpy()
        op,ov=single.run(None,{'planes':x});max_policy=max(max_policy,float(np.max(np.abs(p-op))));max_value=max(max_value,float(np.max(np.abs(v-ov))))
        np.testing.assert_allclose(op,p,rtol=1e-4,atol=1e-4);np.testing.assert_allclose(ov,v,rtol=1e-4,atol=1e-4)
        if np.argmax(np.where(mask,p[0],-1e9))!=np.argmax(np.where(mask,op[0],-1e9)):rank_changes+=1
        golden.append({'first':row['first'],'moves':row['moves'],'planes':row['planes'],'legalMask':row['legalMask'],'policy':p[0].tolist(),'value':float(v[0,0])})
    for n in (1,7):
        x=np.asarray([r['planes'] for r in rows[:n]],dtype=np.float32).reshape(n,8,9,9)
        with torch.no_grad(): p,v=model(torch.from_numpy(x))
        op,ov=batch.run(None,{'planes':x});np.testing.assert_allclose(op,p.numpy(),rtol=1e-4,atol=1e-4);np.testing.assert_allclose(ov,v.numpy(),rtol=1e-4,atol=1e-4)
    class Calibration(CalibrationDataReader):
        def __init__(self): self.rows=iter(splits['train'][:128])
        def get_next(self):
            row=next(self.rows,None)
            return None if row is None else {'planes':np.asarray(row['planes'],dtype=np.float32).reshape(1,8,9,9)}
    quantize_static(str(static),str(quant),Calibration(),quant_format=QuantFormat.QDQ,activation_type=QuantType.QInt8,weight_type=QuantType.QInt8,per_channel=True)
    onnx.checker.check_model(str(quant));qsession=ort.InferenceSession(str(quant),sess_options=options_ort,providers=['CPUExecutionProvider']);quant_changes=0;qerror=0.
    for row,g in zip(rows,golden):
        x=np.asarray(row['planes'],dtype=np.float32).reshape(1,8,9,9);p,v=qsession.run(None,{'planes':x});mask=np.asarray(row['legalMask'],dtype=bool)
        if not np.isfinite(p).all() or not np.isfinite(v).all(): raise ValueError('NONFINITE_QUANTIZED_OUTPUT')
        quant_changes+=int(np.argmax(np.where(mask,p[0],-1e9))!=np.argmax(np.where(mask,g['policy'],-1e9)));qerror=max(qerror,float(np.max(np.abs(p[0]-np.asarray(g['policy'])))))
    artifacts=[facts(file) for file in (static,dynamic,quant)]
    result={'schemaVersion':1,'sourceCommit':report['sourceCommit'],'trainingModelSha256':report['modelSha256'],'datasetSha256':manifest['sha256'],'encodingVersion':ENCODING_VERSION,'frozenStates':len(rows),'numericalStatesPurpose':'parity only; includes train/validation/holdout, not a strength benchmark','floatPolicyMaxAbsError':max_policy,'floatValueMaxAbsError':max_value,'floatLegalArgmaxChanges':rank_changes,'dynamicBatches':[1,7],'quantization':{'format':'QDQ signed INT8 per-channel','calibration':'128 training records only','legalArgmaxChanges':quant_changes,'maxPolicyAbsError':qerror,'matchScoreRegression':'NOT_MEASURED'},'artifacts':artifacts,'sizeGate':all(x['gzipBytes']<=5*1024*1024 for x in artifacts),'ortRuntimeBytes':'NOT_INCLUDED_IN_MODEL_SIZE','browserMemory':'NOT_MEASURED','torchVersion':torch.__version__,'onnxVersion':onnx.__version__,'ortVersion':ort.__version__,'deploymentStatus':'UNAPPROVED','strengthGate':'NOT_PASSED','deviceGate':'NOT_PASSED'}
    (args.output/'export-report.json').write_text(json.dumps(result,indent=2)+'\n');(args.output/'golden.json').write_text(json.dumps(golden)+'\n');print(json.dumps(result,indent=2))
    if not result['sizeGate'] or rank_changes: raise ValueError('FLOAT_PARITY_OR_SIZE_GATE_FAILED')
if __name__=='__main__':main()
