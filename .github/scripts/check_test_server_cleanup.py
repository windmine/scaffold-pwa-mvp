"""Regress the real disposable server's process and temporary-file lifecycle."""

from pathlib import Path
import socket
import sys
from tempfile import TemporaryDirectory

from run_local_checks import isolated_environment


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))


def main():
    import os
    with TemporaryDirectory(prefix="reportflow-cleanup-regression-") as temporary:
        environment = isolated_environment(Path(temporary))
        os.environ.clear()
        os.environ.update(environment)
        from invitation_test import InvitationServer
        for _ in range(3):
            with InvitationServer() as server:
                directory = Path(server.directory.name)
                port = int(server.base_url.rsplit(":", 1)[1])
                assert server.process.poll() is None
                assert server.database_path.is_file()
            assert server.process.poll() is not None, "Owned launcher must exit"
            assert not directory.exists(), "Owned database and uploads must be removed"
            try:
                connection = socket.create_connection(("127.0.0.1", port), timeout=0.1)
            except OSError:
                pass
            else:
                connection.close()
                raise AssertionError("Owned backend listener survived cleanup")
    print("Three real disposable backend lifecycles passed with strict cleanup")


if __name__ == "__main__":
    main()
