#!/usr/bin/env python3
"""Immutable image entrypoint. The host sends a snapshot before final admission."""
import hashlib
import io
import json
import os
from pathlib import PurePosixPath
import sys
import tarfile

MAX_ARCHIVE = 40 * 1024 * 1024


def receive_line(limit):
    value = sys.stdin.buffer.readline(limit + 1)
    if len(value) > limit or not value.endswith(b"\n"):
        raise ValueError("invalid protocol line")
    return value[:-1]


def extract_snapshot(archive, root):
    seen = set()
    total = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        for member in tar:
            path = PurePosixPath(member.name)
            if (not member.isfile() or member.name.startswith("/") or
                    "\\" in member.name or "\x00" in member.name or
                    any(part in ("", ".", "..") for part in member.name.split("/")) or
                    member.name in seen or member.size > 2_000_000 or member.mode & ~0o777):
                raise ValueError("unsafe snapshot entry")
            seen.add(member.name)
            total += member.size
            if len(seen) > 4096 or total > 32 * 1024 * 1024:
                raise ValueError("snapshot limit")
            target = os.path.join(root, *path.parts)
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            # Fresh private tmpfs, no symlinks or reusable state from prior workers.
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, member.mode & 0o777)
            with os.fdopen(fd, "wb") as output:
                source = tar.extractfile(member)
                if source is None:
                    raise ValueError("snapshot content missing")
                output.write(source.read())
            os.chmod(target, member.mode & 0o777)


def main():
    header = json.loads(receive_line(65536))
    size = header["size"]
    if not isinstance(size, int) or size < 1024 or size > MAX_ARCHIVE:
        raise ValueError("archive size")
    archive = sys.stdin.buffer.read(size)
    if len(archive) != size or hashlib.sha256(archive).hexdigest() != header["hash"]:
        raise ValueError("archive integrity")
    extract_snapshot(archive, "/workspace")
    cwd = header["cwd"]
    if not isinstance(cwd, str) or cwd.startswith("/") or any(p in ("", ".", "..") for p in cwd.split("/")) or "\\" in cwd:
        raise ValueError("working directory")
    os.chdir(os.path.join("/workspace", cwd))
    executable = header["executable"]
    if not isinstance(executable, str) or not executable.startswith("/"):
        raise ValueError("executable")
    print("HARNESS_READY " + header["nonce"], flush=True)
    if receive_line(128).decode("ascii") != "ADMIT " + header["nonce"]:
        raise ValueError("final admission required")
    environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "TMPDIR": "/tmp", "LANG": "C.UTF-8"}
    environment.update(header["env"])
    os.execve(executable, [executable, *header["args"]], environment)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Worker protocol rejected: " + str(error), file=sys.stderr)
        sys.exit(125)
