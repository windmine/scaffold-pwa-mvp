"""Prove that a test-only follow-up commit has identical packaged runtime bytes."""
from pathlib import Path
import hashlib,io,json,subprocess,tarfile
out=Path(__file__).resolve().parent
packages=json.loads((out/'source-packages.json').read_text())
release=json.loads((out/'source-ci-id.json').read_text())['sourceCommit']
files=packages['packages']['candidate']['files']
archive=subprocess.check_output(['git','archive',release,'Dockerfile','requirements.txt','.dockerignore','.gcloudignore','backend'])
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    actual={item.name:hashlib.sha256(tar.extractfile(item).read()).hexdigest() for item in tar.getmembers() if item.isfile()}
assert actual==files, [name for name in set(actual)|set(files) if actual.get(name)!=files.get(name)]
before=packages['sourceCommit']
changes=subprocess.check_output(['git','diff','--name-only',before,release],text=True).splitlines()
assert all(name.startswith(('scripts/','docs/')) for name in changes),changes
overlay=packages['packages']['fallback']['fallbackGuard']
assert hashlib.sha256((out/'fallback_overlay.py').read_bytes()).hexdigest()==hashlib.sha256(subprocess.check_output(['git','show',release+':'+out.relative_to(Path.cwd()).as_posix()+'/fallback_overlay.py'])).hexdigest()
value={'status':'passed','releaseCommit':release,'imageSourceCommit':before,'allPackagedFilesByteIdentical':True,
       'verifiedFileCount':len(files),'followupChanges':changes,'fallbackOverlayUnchanged':True}
(out/'image-source-equivalence.json').write_text(json.dumps(value,indent=2)+'\n')
print(json.dumps(value))
