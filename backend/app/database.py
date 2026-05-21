from sqlmodel import SQLModel, create_engine, Session

from app.config import DATABASE_URL

engine = create_engine(
    DATABASE_URL,
    echo=True,
    connect_args={"check_same_thread": False}
)


def create_db_and_tables():
    SQLModel.metadata.create_all(engine)

    with engine.begin() as connection:
        task_log_columns = {
            row[1]
            for row in connection.exec_driver_sql("PRAGMA table_info(tasklog)")
        }

        if "work_date" not in task_log_columns:
            connection.exec_driver_sql("ALTER TABLE tasklog ADD COLUMN work_date VARCHAR")
        if "hours_worked" not in task_log_columns:
            connection.exec_driver_sql("ALTER TABLE tasklog ADD COLUMN hours_worked FLOAT")
        if "safety_notes" not in task_log_columns:
            connection.exec_driver_sql("ALTER TABLE tasklog ADD COLUMN safety_notes VARCHAR")


def get_session():
    with Session(engine) as session:
        yield session
