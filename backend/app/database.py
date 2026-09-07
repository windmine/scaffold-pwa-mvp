from sqlmodel import create_engine, Session

from app.config import DATABASE_URL, SQL_ECHO


connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(
    DATABASE_URL,
    echo=SQL_ECHO,
    connect_args=connect_args,
    pool_pre_ping=True,
)


def migrate_database():
    from app.migrations import run_migrations

    run_migrations(engine)


def verify_database_migrations():
    from app.migrations import verify_migrations

    with engine.connect() as connection:
        verify_migrations(connection)


def get_session():
    with Session(engine) as session:
        yield session
