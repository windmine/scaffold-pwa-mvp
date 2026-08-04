revision = "0017_global_admin_supervisor_invariant"


CONSTRAINT_ERROR = "Global admin access requires the Supervisor role"


def upgrade(context):
    if not context.table_exists("user"):
        return

    context.execute(
        """
        UPDATE "user"
        SET is_global_admin = FALSE
        WHERE COALESCE(is_global_admin, FALSE) <> FALSE
          AND COALESCE(role, '') <> 'supervisor'
        """
    )

    if context.connection.dialect.name == "sqlite":
        context.execute(
            f"""
            CREATE TRIGGER IF NOT EXISTS trg_user_global_admin_supervisor_insert
            BEFORE INSERT ON "user"
            WHEN COALESCE(NEW.is_global_admin, FALSE) <> FALSE
              AND COALESCE(NEW.role, '') <> 'supervisor'
            BEGIN
                SELECT RAISE(ABORT, '{CONSTRAINT_ERROR}');
            END
            """
        )
        context.execute(
            f"""
            CREATE TRIGGER IF NOT EXISTS trg_user_global_admin_supervisor_update
            BEFORE UPDATE OF role, is_global_admin ON "user"
            WHEN COALESCE(NEW.is_global_admin, FALSE) <> FALSE
              AND COALESCE(NEW.role, '') <> 'supervisor'
            BEGIN
                SELECT RAISE(ABORT, '{CONSTRAINT_ERROR}');
            END
            """
        )
        return

    context.execute(
        """
        ALTER TABLE "user"
        ADD CONSTRAINT ck_user_global_admin_requires_supervisor
        CHECK (NOT COALESCE(is_global_admin, FALSE) OR COALESCE(role, '') = 'supervisor')
        """
    )
