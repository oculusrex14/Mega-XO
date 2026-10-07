#!/usr/bin/env python3
"""Capture/check approved-source hashes. Hash review supplements, not replaces, UI tests."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys

EXACT = {'index.html', 'src/game.js', 'src/domain.js', 'src/tournament.js', 'src/monetization.js',
         'src/icons.js', 'src/lan-icons.js', 'src/app.js', 'src/community.js', 'src/party-ui.js', 'src/monetization-ui.js'}
ASSET_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.html', '.css'}


def git(repo: Path, *args: str) -> bytes:
    p = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, check=False, timeout=30)
    if p.returncode:
        raise ValueError('Git read failed: '+p.stderr.decode('utf-8', 'replace')[:500])
    return p.stdout


def protected(path: str) -> bool:
    p = PurePosixPath(path)
    return path in EXACT or (path.startswith('src/') and p.suffix == '.css') or (path.startswith('public/') and p.suffix.lower() in ASSET_SUFFIXES)


def validate_relative(path: str) -> None:
    p = PurePosixPath(path)
    if p.is_absolute() or '..' in p.parts or '\\' in path or not path:
        raise ValueError('Unsafe path in manifest: '+repr(path))


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_new(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(obj, handle, indent=2, ensure_ascii=True); handle.write('\n')


def capture(repo: Path, base: str, output: Path) -> int:
    commit = git(repo, 'rev-parse', '--verify', base+'^{commit}').decode().strip()
    paths = git(repo, 'ls-tree', '-r', '--name-only', '-z', commit).decode('utf-8').split('\0')
    files = []
    for path in sorted(p for p in paths if p and protected(p)):
        validate_relative(path)
        content = git(repo, 'show', commit+':'+path)
        files.append({'path':path, 'sha256':sha(content), 'bytes':len(content)})
    if not files:
        raise ValueError('No protected assets found; verify repository/base.')
    write_new(output, {'schema_version':1, 'base_sha':commit, 'purpose':'Approved source-change review; not visual equivalence proof.', 'files':files})
    print(json.dumps({'captured_files':len(files),'base_sha':commit,'output':str(output)}))
    return 0


def check(repo: Path, baseline: Path, exceptions: Path | None) -> int:
    manifest = json.loads(baseline.read_text(encoding='utf-8'))
    if manifest.get('schema_version') != 1 or not isinstance(manifest.get('files'), list):
        raise ValueError('Invalid baseline schema.')
    allowed = {}
    if exceptions:
        raw = json.loads(exceptions.read_text(encoding='utf-8'))
        for item in raw.get('changes', []):
            validate_relative(item['path'])
            if not item.get('reason') or not item.get('evidence') or not item.get('sha256'):
                raise ValueError('Every exception needs exact path/hash/reason/evidence.')
            allowed[item['path']] = item
    changed, accepted, expected = [], [], set()
    for entry in manifest['files']:
        path = entry['path']; validate_relative(path)
        if path in expected:
            raise ValueError('Duplicate baseline path: '+path)
        expected.add(path)
        target = repo/path
        # Never follow a symlink out of the checkout when reading an asset.
        if any(parent.is_symlink() for parent in [target, *list(target.parents)[:len(PurePosixPath(path).parts)-1]]):
            actual = 'SYMLINK_REQUIRES_MANUAL_REVIEW'
        elif target.is_file():
            actual = sha(target.read_bytes())
        else:
            actual = 'ABSENT'
        if actual != entry['sha256']:
            result={'path':path,'baseline_sha256':entry['sha256'],'current_sha256':actual}
            if path in allowed and allowed[path]['sha256']==actual and actual!='SYMLINK_REQUIRES_MANUAL_REVIEW':
                result['reason']=allowed[path]['reason']; result['evidence']=allowed[path]['evidence']; accepted.append(result)
            else:
                changed.append(result)
    current=git(repo,'ls-files','--cached','--others','--exclude-standard','-z').decode('utf-8').split('\0')
    for path in sorted(set(p for p in current if p and protected(p))-expected):
        validate_relative(path); target=repo/path
        blocked=any(parent.is_symlink() for parent in [target, *list(target.parents)[:len(PurePosixPath(path).parts)-1]])
        actual=sha(target.read_bytes()) if target.is_file() and not blocked else 'ABSENT_OR_SYMLINK'
        result={'path':path,'baseline_sha256':None,'current_sha256':actual,'kind':'new_protected_file'}
        if path in allowed and allowed[path]['sha256']==actual and actual!='ABSENT_OR_SYMLINK':
            result['reason']=allowed[path]['reason'];result['evidence']=allowed[path]['evidence'];accepted.append(result)
        else: changed.append(result)
    print(json.dumps({'base_sha':manifest.get('base_sha'),'unreviewed_changes':changed,'documented_exceptions':accepted,
                      'source_review_passed':not changed,'visual_tests_still_required':True},indent=2))
    return 0 if not changed else 1


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='operation',required=True)
    c=sub.add_parser('capture');c.add_argument('--repo',type=Path,required=True);c.add_argument('--base',required=True);c.add_argument('--output',type=Path,required=True)
    k=sub.add_parser('check');k.add_argument('--repo',type=Path,required=True);k.add_argument('--baseline',type=Path,required=True);k.add_argument('--exceptions',type=Path)
    args=parser.parse_args();repo=args.repo.expanduser().resolve()
    try:
        if args.operation=='capture': return capture(repo,args.base,args.output.expanduser().resolve())
        return check(repo,args.baseline,args.exceptions)
    except (OSError,ValueError,KeyError,subprocess.TimeoutExpired) as exc:
        print('ERROR: '+str(exc),file=sys.stderr);return 2

if __name__=='__main__':sys.exit(main())
