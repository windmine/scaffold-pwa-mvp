"""Verify the single-guard fallback in isolated local files; no cloud actions."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from tempfile import TemporaryDirectory
from fallback_overlay import apply

ROOT = Path.cwd()
OUT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--working-tree', action='store_true')
    args = parser.parse_args()
    source = 'working-tree' if args.working_tree else json.loads((OUT / 'source-ci-id.json').read_text(encoding='utf-8-sig'))['sourceCommit']
    spec = importlib.util.spec_from_file_location('localchecks', ROOT / '.github/scripts/run_local_checks.py')
    local = importlib.util.module_from_spec(spec); spec.loader.exec_module(local)
    scratch = ROOT / 'output/browser-checks/manual-site-release'
    scratch.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix='fallback-', dir=scratch) as directory:
        target = Path(directory)
        if args.working_tree:
            paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', 'backend'], cwd=ROOT).decode().split('\0')
            for name in filter(None, paths):
                assert not name.endswith(('.db', '.sqlite', '.pyc')) and '/uploads/' not in name
                dest = target / name; dest.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(ROOT / name, dest)
        else:
            archive = subprocess.check_output(['git', 'archive', source, 'backend'], cwd=ROOT)
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar: tar.extractall(target, filter='data')
        overlay = apply(target)
        env = local.isolated_environment(target); env['PYTHONPATH'] = str(target / 'backend')
        env['TEMP'] = env['TMP'] = env['TMPDIR'] = str(target)
        code = (OUT / 'fallback_compatibility_test.py').read_text(encoding='utf-8')
        result = subprocess.run([sys.executable, '-c', code], cwd=target / 'backend', env=env,
                                capture_output=True, encoding='utf-8', errors='replace', timeout=180)
        if result.returncode:
            print(result.stdout); print(result.stderr); raise RuntimeError('Local isolated fallback failed')
        proof = json.loads(result.stdout)
        proof.update(atUtc=datetime.now(timezone.utc).isoformat(), sourceCommit=source, overlay=overlay,
                     verifierSha256=hashlib.sha256(code.encode()).hexdigest(), cloudActions=False)
    proof['cleanupComplete'] = True
    name = 'fallback-working-tree.json' if args.working_tree else 'fallback-local.json'
    (OUT / name).write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': proof['status'], 'checks': len(proof['checks']), 'sourceCommit': source, 'cloudActions': False}))


if __name__ == '__main__':
    main()
