from sqlmodel import create_engine, Session

from app.config import DATABASE_URL, SQL_ECHO


connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, echo=SQL_ECHO, connect_args=connect_args)


def migrate_database():
    from app.migrations import run_migrations

    run_migrations(engine)


def get_session():
    with Session(engine) as session:
        yield session
