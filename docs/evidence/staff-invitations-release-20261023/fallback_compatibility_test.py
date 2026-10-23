"""Synthetic fallback guard/acceptance test; network blocked, no email."""
from pathlib import Path
from contextlib import ExitStack
from tempfile import TemporaryDirectory
from unittest.mock import patch
import json, os, socket

with TemporaryDirectory(prefix='staff-fallback-') as directory, ExitStack() as stack:
    os.environ.update({'DATABASE_URL':'sqlite:///'+(Path(directory)/'test.db').as_posix(),
        'APP_ENV':'development','K_SERVICE':'','AUTO_MIGRATE':'false','GEO_SECRET_KEY':'synthetic-fallback-only',
        'UPLOAD_STORAGE_BACKEND':'local','UPLOAD_DIR':directory,'SMTP_HOST':'','SMTP_FROM_EMAIL':'',
        'REGISTRATION_EMAIL_ENABLED':'false','REPORT_PDF_EMAIL_WORKER_ENABLED':'false'})
    with patch.object(socket,'create_connection',side_effect=AssertionError('Network forbidden')):
        from fastapi import HTTPException
        from sqlmodel import Session, create_engine, select
        from app.migrations import run_migrations
        from app.models import Department, User
        from app.schemas import StaffInvitationCreateRequest, WorkerInvitationCreateRequest, WorkerInvitationAcceptRequest
        from app.use_cases import worker_invitations as invitations
        engine=create_engine(os.environ['DATABASE_URL'])
        stack.callback(engine.dispose)
        assert run_migrations(engine)[-1]=='0026_staff_invitations'
        checks=[]
        with Session(engine) as session:
            actor=User(id=9001,name='Synthetic Admin',email='admin@example.invalid',role='supervisor',department_id=9901,is_global_admin=True,password_hash='unused')
            session.add_all([Department(id=9901,name='Synthetic'),actor]); session.commit()
            for role, grant in [('worker',False),('supervisor',False),('supervisor',True)]:
                try: invitations.create_staff_invitation(StaffInvitationCreateRequest(name='Pending',email='new@example.invalid',role=role,is_global_admin=grant),actor,session)
                except HTTPException as error: assert error.status_code==503
                else: raise AssertionError('Fallback creation guard missing')
            assert len(session.exec(select(User)).all())==1
            checks.append('new staff creation guard makes no account')
            for global_admin in (False,True):
                user=User(name='Pending',email=f'pending-{global_admin}@example.invalid',role='supervisor',department_id=9901,is_global_admin=global_admin,password_hash='unused',password_setup_required=True,invitation_generation=1)
                session.add(user); session.flush()
                issued=invitations._new_invitation(user,actor,session)
                session.commit()
                token=issued['token']
                result=invitations.accept_worker_invitation(WorkerInvitationAcceptRequest(token=token,password='SyntheticPass123!'),session)
                session.refresh(user)
                assert user.role=='supervisor' and user.is_global_admin==global_admin and not user.password_setup_required
                try: invitations.accept_worker_invitation(WorkerInvitationAcceptRequest(token=token,password='SyntheticPass123!'),session)
                except HTTPException: pass
                else: raise AssertionError('Token reused')
            checks.append('existing pending Supervisor/admin single-use acceptance preserved')
            invitations.create_worker_invitation(WorkerInvitationCreateRequest(name='Worker',email='worker@example.invalid'),actor,session)
            checks.append('legacy Worker invitation creation preserved without send')
        engine.dispose()
print(json.dumps({'status':'passed','checks':checks,'networkAllowed':False,'smtpAttempted':False}))
