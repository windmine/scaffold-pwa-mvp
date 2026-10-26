"""Read-only anonymous checks of the frozen preview."""
from release_operator import *
from concurrent.futures import ThreadPoolExecutor

preview=read('hosting-preview.json'); assert preview['status']=='passed'
commands=[
    [sys.executable,str(OUT/'frontend.py'),'parity','preview'],
    ['node','scripts/check-hosted-release.mjs',preview['url'],str(OUT/'preview-shell.json')],
    ['node','scripts/check-hosted-installer.mjs',preview['url'],str(OUT/'preview-installer.json'),'--screenshots']]
def run(command):
    result=subprocess.run(command,capture_output=True,encoding='utf-8',errors='replace',timeout=240,
        env={**os.environ,'PLAYWRIGHT_BROWSERS_PATH':'C:/Users/12273/AppData/Local/ms-playwright'})
    return {'command':command,'exitCode':result.returncode,'output':result.stdout+result.stderr}
with ThreadPoolExecutor(max_workers=3) as pool: results=list(pool.map(run,commands))
for result in results: print(result['output'],flush=True)
write('preview-checks-summary.json',{'status':'passed' if all(r['exitCode']==0 for r in results) else 'failed','commands':results})
assert all(r['exitCode']==0 for r in results)
