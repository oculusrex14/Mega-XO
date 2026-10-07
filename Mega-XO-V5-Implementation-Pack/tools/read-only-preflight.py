#!/usr/bin/env python3
"""Collect nonsecret local/optional public/SSH observations. Never deploys or edits Git."""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

BASELINE = '8a77d3f4eb95e363fb967efe9b01f814a703dbae'
PUBLIC_PATHS = ('/', '/livez', '/opsz', '/metrics', '/server/production/main.js')


def utc() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sanitize(text: str) -> str:
    text = re.sub(r'(https?://)[^/\s:@]+:[^@\s/]+@', r'\1[REDACTED]@', text)
    text = re.sub(r'(?i)(token|password|secret|authorization|api[_-]?key)(\s*[=:]\s*)[^\s,;]+', r'\1\2[REDACTED]', text)
    return text[:10000]


def run(argv: list[str], timeout: int = 15) -> dict:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
        return {'executed': True, 'exit_code': p.returncode, 'stdout': sanitize(p.stdout), 'stderr': sanitize(p.stderr)}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {'executed': False, 'error_type': type(exc).__name__, 'error': sanitize(str(exc))}


def public_probe(path: str) -> dict:
    url = 'https://play.antimatterinnovations.com' + path
    out = {'url': url, 'checked_at_utc': utc()}
    req = urllib.request.Request(url, headers={'User-Agent': 'MegaXO-V5-ReadOnly-Preflight/1.0'})
    try:
        try:
            response = urllib.request.urlopen(req, timeout=10)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            body = response.read(65536)
            out.update(status=response.status, body_prefix_sha256=hashlib.sha256(body).hexdigest(), bytes_read=len(body))
            # Deliberately do not retain raw bodies, cookies, or arbitrary headers.
            out['security_headers'] = {k: response.headers.get(k) for k in (
                'Content-Type', 'Cache-Control', 'X-Content-Type-Options', 'Referrer-Policy', 'Strict-Transport-Security', 'Server')}
            if path in ('/livez', '/opsz'):
                try:
                    value = json.loads(body)
                    if isinstance(value, dict) and isinstance(value.get('ok'), bool):
                        out['public_ok'] = value['ok']
                except (ValueError, UnicodeDecodeError):
                    pass
    except (OSError, ValueError, urllib.error.URLError) as exc:
        out.update(error_type=type(exc).__name__, error=sanitize(str(exc)), interpretation='Probe failure is not proof of a global service outage.')
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New JSON file outside the repository; never overwritten.')
    parser.add_argument('--public-probes', action='store_true', help='Read the five fixed public URLs; no auth/provider requests.')
    parser.add_argument('--ssh', action='store_true', help='Run a fixed read-only inspection over verified SSH host keys.')
    parser.add_argument('--ssh-alias', default='command')
    args = parser.parse_args()
    repo = args.repo.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not repo.is_dir():
        parser.error('Repository directory does not exist.')
    if output == repo or repo in output.parents:
        parser.error('Output must be outside the Git checkout to prevent accidental evidence commits.')
    if output.exists():
        parser.error('Output exists; choose a new filename. This tool never overwrites evidence.')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', args.ssh_alias):
        parser.error('SSH alias must be a simple configured host alias, not options or a command.')
    top = run(['git', '-C', str(repo), 'rev-parse', '--show-toplevel'])
    if top.get('exit_code') != 0:
        parser.error('The supplied directory is not a readable Git working tree.')
    report = {'schema_version': 1, 'checked_at_utc': utc(), 'mode': 'READ_ONLY_OBSERVATION',
              'review_baseline_sha': BASELINE, 'repository_path': str(repo),
              'notes': ['No branches, refs, files in the checkout, provider resources, databases or services are changed.',
                        'Provider authentication, store readiness, backups and device acceptance still require their phase-specific checks.']}
    commands = {
        'working_tree_root': ['rev-parse', '--show-toplevel'],
        'branch': ['branch', '--show-current'], 'head': ['rev-parse', 'HEAD'],
        'status': ['status', '--porcelain=v1', '--untracked-files=normal'],
        'recent_commits': ['log', '-5', '--format=%H %cI %s'],
        'review_baseline_available': ['cat-file', '-e', BASELINE+'^{commit}']}
    report['git'] = {k: run(['git', '-C', str(repo)]+v) for k, v in commands.items()}
    tools = ('git', 'node', 'npm', 'python3', 'gh', 'vercel', 'neon', 'hostinger', 'wrangler', 'ssh', 'docker', 'psql', 'pg_dump', 'pg_restore', 'restic', 'java', 'adb', 'xcodebuild')
    report['installed_tool_paths'] = {x: shutil.which(x) for x in tools}
    report['local_versions'] = {x: run([x, '--version']) for x in ('git', 'node', 'python3') if shutil.which(x)}
    report['public_probes'] = [public_probe(p) for p in PUBLIC_PATHS] if args.public_probes else []
    if args.ssh:
        # No environment inspection, secret-file reads, container exec, restarts or writes.
        fixed = {
            'machine': 'uname -srm',
            'containers': "sudo -n docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'",
            'monitor_timers': 'systemctl is-active mega-xo-health.timer mega-xo-db-integrity.timer',
            'listening_tcp': 'ss -lnt',
            'production_disk': 'df -P /opt/mega-xo'}
        prefix = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=7', '-o', 'StrictHostKeyChecking=yes', args.ssh_alias]
        report['ssh'] = {k: run(prefix+[v], timeout=20) for k, v in fixed.items()}
        report['ssh_host_alias'] = args.ssh_alias
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(report, handle, indent=2, ensure_ascii=True)
        handle.write('\n')
    print(f'Observation report created: {output}')
    print('Failures/missing tools are recorded; this is not an all-gates-passed health assertion.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
