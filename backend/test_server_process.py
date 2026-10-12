"""Process cleanup for owned disposable loopback test servers only."""

import os
import socket
import subprocess
import time


def stop_owned_test_server(process, port):
    if os.name == "nt" and process.poll() is None:
        # A Windows venv executable launches another Python process. Waiting
        # for only the launcher can leave SQLite open while that child exits.
        subprocess.run(
            ["taskkill.exe", "/pid", str(process.pid), "/t", "/f"],
            check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    elif process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
    deadline = time.monotonic() + 15
    while True:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                pass
        except OSError:
            break
        if time.monotonic() >= deadline:
            raise AssertionError("Owned test backend did not stop")
        time.sleep(0.05)
    if process.stdout:
        process.stdout.close()
