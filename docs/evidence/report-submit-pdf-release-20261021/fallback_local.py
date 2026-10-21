"""Verify the exact fallback overlays using isolated local data; no cloud access."""
from release_operator import *
import ast
import importlib.util
import io
import tarfile

BASE='35204d8884ce751ffed3deb67896e9e0139b6313'
paths=['backend/migrations/versions/0024_report_pdf_email.py','backend/app/models.py','backend/app/use_cases/record_trash.py']
spec=importlib.util.spec_from_file_location('localchecks',ROOT/'.github/scripts/run_local_checks.py')
local=importlib.util.module_from_spec(spec); spec.loader.exec_module(local)
proof={'startedAtUtc':now(),'base':BASE,'overlaySource':SOURCE,'overlays':paths,'checks':[],'networkAllowed':False}
with tempfile.TemporaryDirectory(prefix='rf-pdf-fallback-check-') as directory:
    target=Path(directory)
    archive=subprocess.check_output(['git','archive',BASE,'backend'])
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar: tar.extractall(target,filter='data')
    for path in paths: (target/path).write_bytes(subprocess.check_output(['git','show',SOURCE+':'+path]))
    env=local.isolated_environment(target)
    env['PYTHONPATH']=str(target/'backend')
    for test in ['registration_email_test.py','invitation_email_test.py']:
        code="import socket,runpy; socket.create_connection=lambda *a,**k: (_ for _ in ()).throw(AssertionError('Network prohibited')); runpy.run_path("+repr(str(target/'backend'/test))+",run_name='__main__')"
        result=subprocess.run([sys.executable,'-c',code],cwd=target/'backend',env=env,capture_output=True,encoding='utf-8',errors='replace',timeout=120)
        assert result.returncode==0,test+' failed in isolated fallback'
        proof['checks'].append({'test':test,'passed':True})
    tree=ast.parse((OUT/'build_images.py').read_text())
    purge=next(node.value.value for node in ast.walk(tree) if isinstance(node,ast.Assign)
        and any(isinstance(x,ast.Name) and x.id=='purge_code' for x in node.targets))
    purge=purge.replace("sqlite:////tmp/fallback-purge.db",'sqlite:///'+(target/'fallback-purge.db').as_posix())
    prefix="import socket\nsocket.create_connection=lambda *a,**k: (_ for _ in ()).throw(AssertionError('Network prohibited'))\n"
    result=subprocess.run([sys.executable,'-c',prefix+purge],cwd=target/'backend',env=env,capture_output=True,encoding='utf-8',errors='replace',timeout=90)
    assert result.returncode==0,'Fallback migration/purge check failed'
    proof['checks'].append({'test':'exact migration24 plus uncertain outbox purge','passed':True})
proof.update(status='passed',finishedAtUtc=now(),cleanupComplete=True)
write('fallback-local.json',proof)
print(json.dumps({'status':'passed','checks':len(proof['checks']),'cleanupComplete':True,'cloudActions':False}))
