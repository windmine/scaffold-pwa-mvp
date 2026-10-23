"""Bind pending staff setup to the permissions authorized when issued.

Historical invitations remain Worker invitations. No existing User is changed.
"""
revision = "0026_staff_invitations"


def upgrade(context):
    context.add_column_if_missing("workerinvitation", "invited_role", "VARCHAR NOT NULL DEFAULT 'worker'")
    context.add_column_if_missing("workerinvitation", "invited_is_global_admin", "BOOLEAN NOT NULL DEFAULT FALSE")
