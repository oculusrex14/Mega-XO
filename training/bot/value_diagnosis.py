"""Portable value-head diagnosis (runs on the DGX nodes). No provider, no publication.

Answers, cheaply: is the value head's failure optimisation, capacity, or a genuinely hard target?
  * material-feature baseline MSE and sign-accuracy on the frozen holdout;
  * value-only training (policy frozen out) to find the best achievable value MSE;
  * per-split (train/validation/holdout) numbers so leakage is visible.
"""
from __future__ import annotations
import argparse, json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import torch
from torch import nn
from model import TinyPolicyValue  # noqa: E402


def load(path: Path):
    rows = [json.loads(l) for l in path.open() if l.strip()]
    man = json.loads((Path(str(path) + '.manifest.json')).read_text())
    return rows, man


def material_sign(row) -> int:
    """A deterministic side-to-move material feature from the encoded planes: mini-boards already
    captured by the mover minus those captured by the opponent. This is the trivial baseline any
    value head must beat."""
    p = row['planes'][162:243]
    o = row['planes'][243:324]
    diff = sum(1 for x in p if x > 0) - sum(1 for x in o if x > 0)
    return 1 if diff > 0 else (-1 if diff < 0 else 0)


def tensors(rows, device):
    x = torch.tensor([r['planes'] for r in rows], dtype=torch.float32, device=device).reshape(len(rows), 8, 9, 9)
    y = torch.tensor([r['valueTarget'] for r in rows], dtype=torch.float32, device=device).reshape(len(rows), 1)
    return x, y


def d4_transform(planes_flat, mask_flat, sym):
    """Apply one of the 8 D4 symmetries to a flattened (8*81) plane bundle and the 81-legal mask.
    Every plane is spatial-indexed (81 entries); the value target is invariant under a board symmetry,
    so this is the standard augmentation for this side-to-move encoding."""
    def s_to_bc(s):
        sub, cell = divmod(s, 9)
        br, bc = divmod(sub, 3)
        cr, cc = divmod(cell, 3)
        return br * 3 + cr, bc * 3 + cc
    def bc_to_s(b, c):
        return (b // 3 * 3 + c // 3) * 9 + (b % 3 * 3 + c % 3)
    perm = [bc_to_s(*[_map_idx(x, sym) for x in s_to_bc(s)]) for s in range(81)]
    plane = [0.0] * 648
    for ch in range(8):
        off = ch * 81
        for s in range(81):
            plane[off + perm[s]] = planes_flat[off + s]
    mask = [0.0] * 81
    for s in range(81):
        if mask_flat[s]:
            mask[perm[s]] = 1.0
    return plane, mask


def _map_idx(index, symmetry):
    r, c = divmod(index, 3)
    if symmetry >= 4:
        c = 2 - c
    for _ in range(symmetry % 4):
        r, c = c, 2 - r
    return r * 3 + c


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('dataset', type=Path)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--epochs', type=int, default=60)
    ap.add_argument('--batch', type=int, default=128)
    ap.add_argument('--width', type=int, default=64)
    ap.add_argument('--blocks', type=int, default=4)
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--augment', action='store_true', help='D4 symmetry augmentation during training')
    ap.add_argument('--weight-decay', type=float, default=1e-4)
    ap.add_argument('--dropout', type=float, default=0.0)
    args = ap.parse_args()
    device = 'cuda' if torch.cuda.is_available() else 'cpu'

    rows, man = load(args.dataset)
    splits = {'train': [], 'validation': [], 'holdout': []}
    for r in rows:
        splits[r.get('split', 'train')].append(r)
    report = {'dataset': str(args.dataset), 'device': device, 'counts': {k: len(v) for k, v in splits.items()}}

    # 1. Material-feature baseline (deterministic, no learning).
    base = {}
    for name, rs in splits.items():
        if not rs:
            continue
        mse = sum((material_sign(r) - r['valueTarget']) ** 2 for r in rs) / len(rs)
        zero = sum(r['valueTarget'] ** 2 for r in rs) / len(rs)
        acc = sum(1 for r in rs if material_sign(r) == (0 if r['valueTarget'] == 0 else math.copysign(1, r['valueTarget']))) / len(rs)
        base[name] = {'materialMSE': mse, 'zeroMSE': zero, 'materialSignAcc': acc, 'n': len(rs)}
    report['materialBaseline'] = base

    # 2. Value-only training: a fresh model, policy loss excluded, so we find the best value MSE the
    #    architecture can reach on this data.
    torch.manual_seed(0)
    model = TinyPolicyValue(width=args.width, blocks=args.blocks).to(device)
    if args.dropout:
        # insert dropout before the value head's penultimate linear is not trivial; apply a global
        # dropout on the trunk output via a wrapper
        model.trunk = nn.Sequential(model.trunk, nn.Dropout(args.dropout))
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    tr_x, tr_y = tensors(splits['train'], device)
    # D4-augmented copies: an epoch over 8x the data if --augment. Each symmetry duplicates every
    # position under a board automorphism that leaves the value target invariant, so the 8-fold
    # augmentation is legitimate, leakage-free extra supervision on the SAME frozen split.
    if args.augment:
        aug_x, aug_y = [], []
        for sym in range(8):
            for r in splits['train']:
                p, _ = d4_transform(r['planes'], r['legalMask'], sym)
                aug_x.append(p); aug_y.append(r['valueTarget'])
        tr_x = torch.tensor(aug_x, dtype=torch.float32, device=device).reshape(len(aug_x), 8, 9, 9)
        tr_y = torch.tensor(aug_y, dtype=torch.float32, device=device).reshape(len(aug_y), 1)
    curves = []
    for ep in range(args.epochs):
        model.train()
        perm = torch.randperm(len(tr_x), device=device)
        tot = 0.0
        for i in range(0, len(perm), args.batch):
            idx = perm[i:i + args.batch]
            _, value = model(tr_x[idx])
            loss = (value.flatten() - tr_y[idx].flatten()).square().mean()
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            tot += float(loss.detach()) * len(idx)
        model.eval()
        entry = {'epoch': ep + 1, 'trainMSE': tot / len(perm)}
        for name in ('validation', 'holdout'):
            if splits[name]:
                with torch.no_grad():
                    vx, vy = tensors(splits[name], device)
                    _, v = model(vx)
                    entry[name + 'MSE'] = float((v.flatten() - vy.flatten()).square().mean())
        curves.append(entry)
    best = min((c for c in curves if 'validationMSE' in c), key=lambda c: c['validationMSE'], default=curves[-1])
    report['valueOnly'] = {'config': {'width': args.width, 'blocks': args.blocks, 'epochs': args.epochs, 'lr': args.lr,
                                      'augment': args.augment, 'weightDecay': args.weight_decay, 'dropout': args.dropout},
                           'final': curves[-1], 'bestValidation': best, 'curves': curves}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'device': device, 'counts': report['counts'],
                      'materialBaseline': base, 'valueOnlyFinal': report['valueOnly']['final']}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
