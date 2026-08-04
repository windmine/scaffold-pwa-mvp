def user_is_global_admin(user):
    """Return effective global access, failing closed for malformed legacy users."""
    return bool(
        getattr(user, "role", None) == "supervisor"
        and getattr(user, "is_global_admin", False)
    )
