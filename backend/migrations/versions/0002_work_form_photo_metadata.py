revision = "0002_work_form_photo_metadata"


def upgrade(context):
    context.add_column_if_missing("workformsubmission", "photo_metadata", "TEXT")
