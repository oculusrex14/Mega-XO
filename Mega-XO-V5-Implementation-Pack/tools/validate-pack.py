#!/usr/bin/env python3
"""Validate pack structure, JSON, links, task graph, original sources and checksums."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys


def digest(p:Path)->str:return hashlib.sha256(p.read_bytes()).hexdigest()

def inside(root:Path,name:str)->Path:
    p=PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or '\\' in name:raise ValueError('Unsafe manifest path: '+name)
    result=root/name
    if result.is_symlink():raise ValueError('Symlinks are not allowed in the package: '+name)
    if root not in result.resolve().parents:raise ValueError('Path escapes package: '+name)
    return result

def validate(root:Path,structure_only:bool)->dict:
    errors=[]; files=[p for p in root.rglob('*') if p.is_file()]
    for p in files:
        if p.is_symlink():errors.append('Symlink: '+str(p.relative_to(root)))
        if p.suffix=='.json':
            try:json.loads(p.read_text(encoding='utf-8'))
            except (ValueError,UnicodeError) as exc:errors.append('Invalid JSON '+p.name+': '+str(exc))
        if p.suffix=='.py':
            try:compile(p.read_text(encoding='utf-8'),str(p),'exec')
            except (SyntaxError,UnicodeError) as exc:errors.append('Invalid Python '+p.name+': '+str(exc))
    graph=json.loads((root/'tasks.json').read_text()); phases=graph['phases']; tasks=graph['tasks']
    pmap={p['id']:p for p in phases}; tmap={t['id']:t for t in tasks}
    if len(pmap)!=len(phases) or set(pmap)!={f'P{i:02d}' for i in range(25)}:errors.append('Phase IDs must be unique P00-P24.')
    if len(tmap)!=len(tasks):errors.append('Duplicate task IDs.')
    if pmap.get('P21',{}).get('execution_mode')!='DEFERRED_BY_OWNER':errors.append('P21 must remain owner-deferred.')
    if 'P21' in pmap.get('P22',{}).get('depends_on',[]):errors.append('P22 incorrectly depends on deferred website.')
    visited=set();active=set()
    def visit(pid:str)->None:
        if pid in active:raise ValueError('Phase dependency cycle at '+pid)
        if pid in visited:return
        if pid not in pmap:raise ValueError('Unknown phase prerequisite '+pid)
        active.add(pid)
        for dep in pmap[pid]['depends_on']:visit(dep)
        active.remove(pid);visited.add(pid)
    try:
        for pid in pmap:visit(pid)
    except ValueError as exc:errors.append(str(exc))
    for p in phases:
        if not inside(root,p['file']).is_file():errors.append('Missing phase file '+p['file'])
        for tid in p['task_ids']:
            if tid not in tmap or tmap[tid]['phase']!=p['id']:errors.append('Task-phase mismatch '+tid)
    for t in tasks:
        if t['phase'] not in pmap:errors.append('Unknown task phase '+t['id'])
        for d in t['depends_on_tasks']:
            if d not in tmap:errors.append('Unknown task dependency '+d)
        for d in t['requires_phase_gates']:
            if d not in pmap:errors.append('Unknown required phase gate '+d)
    task_seen=set();task_active=set()
    def visit_task(tid:str)->None:
        if tid in task_active:raise ValueError('Task dependency cycle at '+tid)
        if tid in task_seen:return
        task_active.add(tid)
        for d in tmap[tid]['depends_on_tasks']:visit_task(d)
        task_active.remove(tid);task_seen.add(tid)
    try:
        for tid in tmap:visit_task(tid)
    except (ValueError,KeyError) as exc:errors.append(str(exc))
    original_names={'HANDOFF-V5.md','NewArchitecture.md'}
    link_count=0
    for p in root.rglob('*.md'):
        if p.parent.name=='sources' and p.name in original_names:continue
        for url in re.findall(r'\[[^\]]*\]\(([^)]+)\)',p.read_text(encoding='utf-8')):
            if re.match(r'^[a-z]+:',url,re.I) or url.startswith('#'):continue
            path=url.split('#',1)[0]
            if not path:continue
            link_count+=1
            if not (p.parent/path).exists():errors.append('Broken relative link '+str(p.relative_to(root))+': '+url)
    source=json.loads((root/'source-manifest.json').read_text())
    for entry in source['source_files']:
        target=inside(root,entry['path'])
        if not target.is_file() or digest(target)!=entry['sha256'] or target.stat().st_size!=entry['bytes']:
            errors.append('Original source changed: '+entry['path'])
    checksums=0
    if not structure_only:
        manifest=root/'SHA256SUMS'
        if not manifest.exists():errors.append('Missing SHA256SUMS')
        else:
            names=set()
            for line in manifest.read_text().splitlines():
                if not line:continue
                match=re.fullmatch(r'([0-9a-f]{64})  (.+)',line)
                if not match:errors.append('Invalid checksum line');continue
                wanted,name=match.groups();names.add(name);checksums+=1
                path=inside(root,name)
                if not path.is_file() or digest(path)!=wanted:errors.append('Checksum mismatch: '+name)
            actual={str(p.relative_to(root)) for p in files if p.name!='SHA256SUMS'}
            if names!=actual:errors.append('Checksum file inventory mismatch: '+repr(sorted(names^actual)))
    acceptance=json.loads((root/'acceptance.json').read_text())['cases']
    if len({x['id'] for x in acceptance})!=len(acceptance):errors.append('Duplicate acceptance case IDs.')
    return {'ok':not errors,'errors':errors,'files':len(files),'phases':len(phases),'tasks':len(tasks),
            'acceptance_cases':len(acceptance),'relative_links_checked':link_count,'checksums_verified':checksums,
            'source_integrity_checked':True,'mode':'structure-only' if structure_only else 'full'}

def main()->int:
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('root',type=Path,nargs='?',default=Path('.'));p.add_argument('--structure-only',action='store_true');a=p.parse_args()
    try:result=validate(a.root.resolve(),a.structure_only)
    except (OSError,ValueError,KeyError) as exc:result={'ok':False,'errors':[str(exc)]}
    print(json.dumps(result,indent=2));return 0 if result['ok'] else 1

if __name__=='__main__':sys.exit(main())
