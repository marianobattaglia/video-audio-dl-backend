"""Real ZIP worker framing and seccomp; only generated in-memory fixture bytes."""
import json
import os
import runpy
import socket
import struct
import subprocess
import tempfile
import zipfile

for family in (socket.AF_INET, socket.AF_INET6):
    try:
        socket.socket(family, socket.SOCK_STREAM)
        raise AssertionError("network socket allowed")
    except PermissionError:
        pass

helper = runpy.run_path("/app/archive-worker.py", run_name="fixture")
for name in ("../secret.mp3", "dir/song.mp3", "dir\\song.mp3", "C:secret.mp3", "\x00.mp3", ""):
    assert not helper["safe_name"](name)
media = b"ID3" + bytes(1024)
member = {"name": "0001 - Canción.mp3", "size": len(media)}
with tempfile.TemporaryDirectory(prefix="archive-fixture-") as directory:
    def worker(name, header, data):
        encoded = json.dumps(header).encode()
        return subprocess.run(["/usr/bin/python3", "-I", "-B", "/app/archive-worker.py", os.path.join(directory, name)],
                              input=struct.pack(">I", len(encoded)) + encoded + data, capture_output=True, timeout=10)
    header = {"oldSize": 0, "previous": [], "members": [member], "add": member, "maxSize": 8192}
    result = worker("first.zip", header, media)
    assert result.returncode == 0, result.stderr
    with zipfile.ZipFile(os.path.join(directory, "first.zip")) as archive:
        assert archive.read(member["name"]) == media
        assert archive.testzip() is None
        assert archive.infolist()[0].compress_type == zipfile.ZIP_STORED
    bad = {**header, "members": [{"name": "../../private.mp3", "size": len(media)}], "add": {"name": "../../private.mp3", "size": len(media)}}
    result = worker("bad.zip", bad, media)
    assert result.returncode == 1 and result.stderr.strip() == b"E_ARCHIVE_WORKER"
    result = worker("truncated.zip", header, media[:10])
    assert result.returncode == 1 and b"secret" not in result.stderr
    result = worker("invalid.zip", header, bytes(len(media)))
    assert result.returncode == 1
    result = worker("small.zip", {**header, "maxSize": 10}, media)
    assert result.returncode == 1
print(json.dumps({"status": "pass", "scope": "real ZIP_STORED worker, bounded framing, media signatures, names and inherited seccomp; synthetic bytes only"}))
