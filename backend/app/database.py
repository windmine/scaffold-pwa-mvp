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
        user_columns = {
            row[1]
            for row in connection.exec_driver_sql("PRAGMA table_info(user)")
        }

        if "status" not in user_columns:
            connection.exec_driver_sql("ALTER TABLE user ADD COLUMN status VARCHAR DEFAULT 'active'")

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
        if "photo_urls" not in task_log_columns:
            connection.exec_driver_sql("ALTER TABLE tasklog ADD COLUMN photo_urls VARCHAR")
        if "status" not in task_log_columns:
            connection.exec_driver_sql("ALTER TABLE tasklog ADD COLUMN status VARCHAR DEFAULT 'pending'")

        attendance_columns = {
            row[1]
            for row in connection.exec_driver_sql("PRAGMA table_info(attendancerecord)")
        }

        if "distance_from_site_m" not in attendance_columns:
            connection.exec_driver_sql("ALTER TABLE attendancerecord ADD COLUMN distance_from_site_m FLOAT")
        if "within_site_radius" not in attendance_columns:
            connection.exec_driver_sql("ALTER TABLE attendancerecord ADD COLUMN within_site_radius BOOLEAN")

        form_submission_columns = {
            row[1]
            for row in connection.exec_driver_sql("PRAGMA table_info(workformsubmission)")
        }

        if "status" not in form_submission_columns:
            connection.exec_driver_sql("ALTER TABLE workformsubmission ADD COLUMN status VARCHAR DEFAULT 'pending'")


def get_session():
    with Session(engine) as session:
        yield session
