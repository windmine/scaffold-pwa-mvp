"""Validate workflow syntax with a checksum-pinned upstream actionlint release."""

import hashlib
from io import BytesIO
import os
from pathlib import Path
import platform
import subprocess
import tarfile
from tempfile import TemporaryDirectory
from urllib.request import Request, urlopen
import zipfile


ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.7.12"
# Verified against the release asset digests from rhysd/actionlint on 2026-10-12.
ASSETS = {
    "Linux": ("linux_amd64.tar.gz", "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"),
    "Windows": ("windows_amd64.zip", "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9"),
}


def main():
    system = platform.system()
    if system not in ASSETS or platform.machine().lower() not in {"amd64", "x86_64"}:
        raise RuntimeError("This validator supports the CI Linux x64 runner and local Windows x64")
    suffix, expected = ASSETS[system]
    url = f"https://github.com/rhysd/actionlint/releases/download/v{VERSION}/actionlint_{VERSION}_{suffix}"
    with urlopen(Request(url, headers={"User-Agent": "reportflow-ci-validator"}), timeout=30) as response:
        archive = response.read(16 * 1024 * 1024 + 1)
    if len(archive) > 16 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != expected:
        raise RuntimeError("Downloaded actionlint archive does not match the pinned release digest")
    binary_name = "actionlint.exe" if system == "Windows" else "actionlint"
    if system == "Windows":
        with zipfile.ZipFile(BytesIO(archive)) as package:
            binary = package.read(binary_name)
    else:
        with tarfile.open(fileobj=BytesIO(archive), mode="r:gz") as package:
            binary = package.extractfile(binary_name).read()
    with TemporaryDirectory(prefix="reportflow-actionlint-") as temporary:
        executable = Path(temporary) / binary_name
        executable.write_bytes(binary)
        executable.chmod(0o755)
        workflows = sorted((ROOT / ".github/workflows").glob("*.yml"))
        if not workflows:
            raise RuntimeError("No workflows found")
        # ShellCheck is available on CI; Windows still validates the workflow DSL.
        command = [str(executable), "-color", "-pyflakes="]
        if os.name == "nt":
            command.append("-shellcheck=")
        subprocess.run([*command, *map(str, workflows)], cwd=ROOT, check=True)
    print(f"actionlint {VERSION} passed for {len(workflows)} workflow(s)")


if __name__ == "__main__":
    main()
