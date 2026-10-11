import datetime
import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path.cwd()
manifest = root / 'assets/p21/art/PROVENANCE.json'
provenance = json.loads(manifest.read_text())
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
files = []
for item in provenance['file_inventory']:
    working = (root / item['path']).read_bytes()
    committed = subprocess.run(['git', 'show', sha + ':' + item['path']], capture_output=True)
    digest = hashlib.sha256(working).hexdigest()
    files.append({
        'path': item['path'], 'sha256': digest, 'bytes': len(working),
        'result': 'PASS' if committed.returncode == 0 and committed.stdout == working
                  and digest == item['sha256'] and len(working) == item['bytes'] else 'FAIL',
        'committed_bytes_match': committed.returncode == 0 and committed.stdout == working,
        'provenance_hash_matches': digest == item['sha256'],
    })
report = {
    'case_id': 'P21-NEON-ASSET-GIT-PROVENANCE', 'source_commit': sha,
    'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'command': 'python3 .artifacts/p21-theme-review/verify-assets.py',
    'environment': 'Local macOS; read-only Git/working-tree comparison; no provider calls',
    'manifest': str(manifest.relative_to(root)),
    'manifest_sha256': hashlib.sha256(manifest.read_bytes()).hexdigest(),
    'files': files, 'file_count': len(files),
    'result': 'PASS' if all(item['result'] == 'PASS' for item in files) else 'FAIL',
}
output = root / '.artifacts/p21-theme-review/asset-verification.json'
output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'result': report['result'], 'files': len(files), 'source_commit': sha}))
raise SystemExit(0 if report['result'] == 'PASS' else 1)
