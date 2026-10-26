"""Independent read-only live checks; each retains its own evidence."""
from release_operator import *
from concurrent.futures import ThreadPoolExecutor

assert read('hosting-promotion.json')['status'] == 'passed'
commands = [
    [sys.executable, str(OUT/'frontend.py'), 'parity', 'live'],
    ['node', 'scripts/check-hosted-release.mjs', HOST, str(OUT/'live-shell.json')],
    ['node', 'scripts/check-hosted-installer.mjs', HOST, str(OUT/'live-installer.json'), '--screenshots'],
    [sys.executable, str(OUT/'verify_cleanup.py'), 'verify'],
]
def one(command):
    result = subprocess.run(command, capture_output=True, encoding='utf-8', errors='replace', timeout=240,
                            env={**os.environ, 'PLAYWRIGHT_BROWSERS_PATH': 'C:/Users/12273/AppData/Local/ms-playwright'})
    return {'command': command, 'exitCode': result.returncode, 'output': result.stdout + result.stderr}
with ThreadPoolExecutor(max_workers=4) as pool:
    results = list(pool.map(one, commands))
for result in results:
    print(result['output'], flush=True)
write('live-checks-summary.json', {'status': 'passed' if all(r['exitCode'] == 0 for r in results) else 'failed',
                                 'atUtc': now(), 'commands': results})
assert all(r['exitCode'] == 0 for r in results), 'Inspect failed check; no deployment repeated'
