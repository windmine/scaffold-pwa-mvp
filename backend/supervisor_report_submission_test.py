"""Supervisor self-submission: isolated HTTP/database tests; no SMTP or network."""
import asyncio
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

_environment = TemporaryDirectory(prefix="supervisor-report-config-")
os.environ.update({"DATABASE_URL": "sqlite:///" + (Path(_environment.name) / "unused.db").as_posix(),
    "GEO_SECRET_KEY": "synthetic-supervisor-report-test-only", "APP_ENV": "development", "K_SERVICE": "",
    "AUTO_MIGRATE": "false", "SQL_ECHO": "false", "RATE_LIMIT_ENABLED": "false",
    "SMTP_HOST": "", "SMTP_PASSWORD": "", "SMTP_FROM_EMAIL": "", "SMTP_USERNAME": "",
    "REGISTRATION_EMAIL_ENABLED": "false", "REPORT_PDF_EMAIL_WORKER_ENABLED": "false",
    "UPLOAD_STORAGE_BACKEND": "local", "UPLOAD_DIR": str(Path(_environment.name) / "uploads")})
from sqlmodel import Session, SQLModel, create_engine, select
from app import main as application
from app.auth import create_access_token
from app.models import Department, ReportPdfEmail, Site, User, WorkForm, WorkFormSubmission

class SupervisorReportTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory(prefix="supervisor-report-db-"))
        self.engine = create_engine("sqlite:///" + (Path(directory) / "test.db").as_posix(), connect_args={"check_same_thread": False})
        self.addCleanup(self.engine.dispose)
        SQLModel.metadata.create_all(self.engine)
        with Session(self.engine) as session:
            session.add_all([Department(id=1,name="Home"),Department(id=2,name="Other"),
                User(id=1,department_id=1,email="worker@example.invalid",name="Worker",password_hash="unused"),
                User(id=2,department_id=1,email="supervisor@example.invalid",name="Supervisor",role="supervisor",password_hash="unused"),
                User(id=3,department_id=2,email="other@example.invalid",name="Other",role="supervisor",password_hash="unused"),
                User(id=4,department_id=1,email="global@example.invalid",name="Global",role="supervisor",is_global_admin=True,password_hash="unused"),
                WorkForm(id=1,department_id=1,name="Own inspection",fields_json=json.dumps([{"id":"answer","label":"Answer","type":"text","required":True}])),
                WorkForm(id=2,department_id=2,name="Foreign report",fields_json="[]"),
                WorkForm(id=3,department_id=1,name="Legacy Daywork",template_purpose="daywork",fields_json="[]"),
                WorkForm(id=4,department_id=1,name="Archived",status="archived",fields_json="[]"),
                Site(id=1,department_id=1,name="Home Site",address="Synthetic",latitude=0,longitude=0),
                Site(id=2,department_id=2,name="Other Site",address="Synthetic",latitude=0,longitude=0)])
            session.commit()
        def sessions():
            with Session(self.engine) as session: yield session
        self.enterContext(patch.dict(application.app.dependency_overrides,{application.get_session:sessions}))
        self.enterContext(patch("socket.create_connection",side_effect=AssertionError("No external network")))
        self.smtp=self.enterContext(patch("app.email_transport.send_email",side_effect=AssertionError("No email")))

    def request(self, actor=2, path="/supervisor/my-report-submissions", method="POST", payload=None,
                cookie=False, csrf=True, scope=True, headers=None, query=""):
        body=json.dumps(payload if payload is not None else {"form_id":1,"work_date":"2026-10-21",
            "expected_definition_version":1,"client_submission_id":"stable-self-report","answers":{"answer":"Own report"}}).encode()
        request_headers={"content-type":"application/json"}
        if actor:
            with Session(self.engine) as session:
                user=session.get(User,actor)
                token=create_access_token({"sub":user.email,"user_id":user.id,"auth_generation":user.auth_generation,"csrf":"test-csrf"})
                request_headers.update({"cookie":"__session="+token} if cookie else {"authorization":"Bearer "+token})
                if csrf:request_headers["x-csrf-token"]="test-csrf"
                if scope:request_headers.update({"x-report-recovery-worker":str(user.id),"x-report-recovery-department":str(user.department_id),"x-report-recovery-role":user.role})
        request_headers.update(headers or {})
        async def run():
            messages=[]
            async def receive():return {"type":"http.request","body":body,"more_body":False}
            async def send(message):messages.append(message)
            await application.app({"type":"http","asgi":{"version":"3.0","spec_version":"2.4"},"http_version":"1.1",
                "method":method,"scheme":"http","path":path,"raw_path":path.encode(),"query_string":query.encode(),
                "root_path":"","headers":[(k.encode(),v.encode()) for k,v in request_headers.items()],
                "client":("127.0.0.1",12345),"server":("test.invalid",80)},receive,send)
            start=next(m for m in messages if m["type"]=="http.response.start")
            return start["status"],json.loads(b"".join(m.get("body",b"") for m in messages)),dict(start["headers"])
        return asyncio.run(run())

    def test_self_attribution_and_immutable_replay(self):
        status,report,_=self.request(payload={"form_id":1,"work_date":"2026-10-21","expected_definition_version":1,
            "worker_id":1,"client_submission_id":"stable-self-report","answers":{"answer":"Supervisor authored"}})
        self.assertEqual(status,200);self.assertEqual(report["worker_id"],2)
        self.assertEqual(report["department_id"],1);self.assertEqual(report["workflow_status"],"submitted")
        self.assertEqual(self.request()[1]["answers"],{"answer":"Supervisor authored"})
        self.assertTrue(self.request()[1]["idempotent_replay"])
        with Session(self.engine) as session:self.assertEqual(len(session.exec(select(WorkFormSubmission)).all()),1)
        self.smtp.assert_not_called()

    def test_role_routes_and_anonymous_boundaries(self):
        self.assertEqual(self.request(actor=None)[0],401)
        self.assertEqual(self.request(actor=1)[0],403)
        self.assertEqual(self.request(path="/form-submissions",scope=False)[0],403)
        self.assertEqual(self.request(actor=1,path="/form-submissions",scope=False)[0],200)

    def test_home_department_even_for_global_admin(self):
        for actor in (2,4):
            for form_id in (2,3,4):
                self.assertEqual(self.request(actor=actor,payload={"form_id":form_id,"work_date":"2026-10-21","answers":{}})[0],404)
            self.assertEqual(self.request(actor=actor,payload={"form_id":1,"site_id":2,"work_date":"2026-10-21","answers":{"answer":"No"}})[0],404)
        self.assertEqual(self.request(actor=3)[0],404)

    def test_identity_headers_and_csrf_fail_before_write(self):
        self.assertEqual(self.request(scope=False)[0],409)
        for key,value in [("x-report-recovery-worker","1"),("x-report-recovery-department","2"),("x-report-recovery-role","worker")]:
            self.assertEqual(self.request(headers={key:value})[0],409)
        self.assertEqual(self.request(cookie=True,csrf=False)[0],403)
        self.assertEqual(self.request(cookie=True)[0],200)

    def test_validation_and_definition_version(self):
        for payload in [{"form_id":1,"answers":{"answer":"Date missing"}},
                        {"form_id":1,"work_date":"2026-02-30","answers":{"answer":"Bad date"}},
                        {"form_id":1,"work_date":"2026-10-21","answers":{}}]:
            self.assertEqual(self.request(payload=payload)[0],400)
        self.assertEqual(self.request(payload={"form_id":1,"work_date":"2026-10-21","expected_definition_version":2,"answers":{"answer":"Old"}})[0],409)

    def test_own_history_lookup_and_no_cross_account_disclosure(self):
        self.request()
        path="/supervisor/my-report-submissions/by-client-id"
        query="client_submission_id=stable-self-report&purpose=report"
        status,result,headers=self.request(path=path,method="GET",query=query)
        self.assertEqual(status,200);self.assertEqual(result["status"],"submitted")
        self.assertIn(b"no-store",headers[b"cache-control"])
        self.assertEqual(self.request(actor=3,path=path,method="GET",query=query)[1]["status"],"not_found")
        self.assertEqual(self.request(actor=1,path=path,method="GET",query=query)[0],403)
        self.assertEqual(len(self.request(path="/my-form-submissions",method="GET",query="purpose=report")[1]),1)
        self.assertEqual(self.request(actor=1,path="/my-form-submissions",method="GET",query="purpose=report")[1],[])

    def test_optional_pdf_outbox_once_without_sending(self):
        with Session(self.engine) as session:
            form=session.get(WorkForm,1);form.pdf_email_enabled=True;form.pdf_email_recipient="reports@example.invalid";session.add(form);session.commit()
        self.assertEqual(self.request()[0],200);self.assertEqual(self.request()[0],200)
        with Session(self.engine) as session:
            rows=session.exec(select(ReportPdfEmail)).all();self.assertEqual(len(rows),1)
            self.assertEqual(rows[0].status,"pending");self.assertEqual(json.loads(rows[0].snapshot_json)["worker_id"],2)
        self.smtp.assert_not_called()

    def test_transfer_cannot_replay_or_read_prior_department_report(self):
        self.request()
        with Session(self.engine) as session:
            user=session.get(User,2);user.department_id=2;session.add(user);session.commit()
        self.assertEqual(self.request()[0],409)
        self.assertEqual(self.request(path="/my-form-submissions",method="GET",query="purpose=report")[1],[])
        self.assertEqual(self.request(path="/supervisor/my-report-submissions/by-client-id",method="GET",query="client_submission_id=stable-self-report&purpose=report")[0],409)

if __name__=="__main__":
    unittest.main()
