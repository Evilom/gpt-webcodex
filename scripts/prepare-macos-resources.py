"""Stage pinned Apple Silicon runtimes; never read desktop settings or secrets."""

from __future__ import annotations

import hashlib
import json
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STAGE = ROOT / "resources" / "mac-arm64"


def download(url: str, target: Path, *, expected: str = "", checksum_url: str = "") -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "web-mcp-assistant-macos-build"})
    with urllib.request.urlopen(request, timeout=120) as source, target.open("wb") as output:
        shutil.copyfileobj(source, output)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if checksum_url:
        with urllib.request.urlopen(checksum_url, timeout=60) as response:
            expected = response.read().decode().split()[0]
    if expected and digest != expected.lower():
        raise RuntimeError(f"Checksum mismatch: {target.name}")
    return digest


def main() -> None:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("Mac resources must be prepared on an Apple Silicon Mac.")
    STAGE.mkdir(parents=True, exist_ok=True)
    tools = STAGE / "tools"
    tools.mkdir(exist_ok=True)
    records = []
    with tempfile.TemporaryDirectory(prefix="web-mcp-macos-") as temporary:
        cache = Path(temporary)
        python_name = "cpython-3.12.10+20250409-aarch64-apple-darwin-install_only.tar.gz"
        python_url = f"https://github.com/astral-sh/python-build-standalone/releases/download/20250409/{python_name}"
        archive = cache / python_name
        digest = download(python_url, archive, checksum_url=python_url + ".sha256")
        with tarfile.open(archive) as bundle:
            bundle.extractall(cache / "python", filter="data")
        target = STAGE / "native-python"
        target.mkdir(exist_ok=True)
        shutil.copytree(cache / "python" / "python", target, dirs_exist_ok=True, symlinks=True)
        records.append({"name": "Python", "version": "3.12.10", "url": python_url, "sha256": digest})

        tunnel_url = "https://github.com/openai/tunnel-client/releases/download/v0.0.10/tunnel-client-v0.0.10-darwin-arm64.zip"
        archive = cache / "tunnel.zip"
        digest = download(tunnel_url, archive, expected="288accc7fd20cfee1d495adb933773af9e19ebc0cdef3173f7fb544afa5065b2")
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(cache / "tunnel")
        tunnel = next((cache / "tunnel").rglob("tunnel-client"))
        shutil.copy2(tunnel, tools / "tunnel-client")
        licenses = tools / "licenses"
        licenses.mkdir(exist_ok=True)
        download("https://raw.githubusercontent.com/openai/tunnel-client/v0.0.10/LICENSE", licenses / "tunnel-client-LICENSE")
        records.append({"name": "Tunnel", "version": "0.0.10", "url": tunnel_url, "sha256": digest})

        for name, version, url in [
            ("rg", "14.1.1", "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-apple-darwin.tar.gz"),
            ("fd", "10.2.0", "https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-aarch64-apple-darwin.tar.gz"),
        ]:
            archive = cache / f"{name}.tar.gz"
            digest = download(url, archive, checksum_url=url + ".sha256" if name == "rg" else "")
            with tarfile.open(archive) as bundle:
                bundle.extractall(cache / name, filter="data")
            shutil.copy2(next((cache / name).rglob(name)), tools / name)
            for source in (cache / name).rglob("*"):
                if source.is_file() and source.name.upper().startswith(("LICENSE", "COPYING", "UNLICENSE", "NOTICE")):
                    shutil.copy2(source, licenses / f"{name}-{source.name}")
            records.append({"name": name, "version": version, "url": url, "sha256": digest})
        for executable in [target / "bin" / "python3", *[tools / name for name in ("tunnel-client", "rg", "fd")]]:
            executable.chmod(0o755)
            description = subprocess.check_output(["/usr/bin/file", "-b", str(executable.resolve())], text=True)
            if "arm64" not in description:
                raise RuntimeError(f"Incorrect architecture: {executable}: {description}")
            subprocess.run([str(executable), "--version"], check=True)
    (STAGE / "runtime-manifest.json").write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
    print("Apple Silicon runtime resources ready.")


if __name__ == "__main__":
    main()
