"""Trusted ZIP_STORED worker. Only framed validated bytes enter stdin."""
import hashlib
import json
import os
import re
import struct
import sys
import zipfile

BLOCK = 65536


def exact(size):
    value = sys.stdin.buffer.read(size)
    if len(value) != size:
        raise ValueError("frame")
    return value


def copy_input(out, size):
    while size:
        chunk = exact(min(size, BLOCK))
        out.write(chunk)
        size -= len(chunk)


def safe_name(name):
    return (isinstance(name, str) and 0 < len(name.encode("utf-8")) <= 512
            and name not in (".", "..") and not re.search(r"[\x00-\x1f\x7f/\\:]", name))


def validate(filename, expected):
    with zipfile.ZipFile(filename) as archive:
        items = archive.infolist()
        if len(items) != len(expected) or len({i.filename for i in items}) != len(items):
            raise ValueError("members")
        for item, member in zip(items, expected):
            if (item.filename != member["name"] or item.file_size != member["size"]
                    or item.compress_type != zipfile.ZIP_STORED or item.flag_bits & 1
                    or item.is_dir() or not safe_name(item.filename)):
                raise ValueError("member")
            with archive.open(item) as source:
                head = source.read(12)
                if item.filename.endswith(".mp3"):
                    if not (head.startswith(b"ID3") or len(head) >= 2 and head[0] == 255 and head[1] & 224 == 224):
                        raise ValueError("media")
                elif item.filename.endswith(".mp4"):
                    if len(head) < 12 or head[4:8] != b"ftyp":
                        raise ValueError("media")
                elif item.filename != "resultado.txt":
                    raise ValueError("type")
                while source.read(BLOCK):
                    pass  # ZipExtFile verifies each CRC at EOF, with bounded reads.


def main():
    length = struct.unpack(">I", exact(4))[0]
    if length > 1024 * 1024:
        raise ValueError("header")
    header = json.loads(exact(length))
    target = sys.argv[1]  # fixed staging path supplied only by the trusted parent
    old_size = header["oldSize"]
    expected = header["members"]
    if old_size < 0 or not all(safe_name(m["name"]) and 0 <= m["size"] for m in expected):
        raise ValueError("input")
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as out:
        copy_input(out, old_size)
    if old_size:
        validate(target, header["previous"])
    with zipfile.ZipFile(target, "a" if old_size else "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        member = header.get("add")
        if member:
            with archive.open(member["name"], "w", force_zip64=True) as out:
                copy_input(out, member["size"])
        summary = header.get("summary")
        if summary is not None:
            archive.writestr("resultado.txt", summary.encode("utf-8"))
    if sys.stdin.buffer.read(1):
        raise ValueError("trailing")
    if os.stat(target).st_size > header["maxSize"]:
        raise ValueError("capacity")
    validate(target, expected)
    digest = hashlib.sha256()
    with open(target, "rb") as source:
        while chunk := source.read(BLOCK):
            digest.update(chunk)
    print(json.dumps({"size": os.stat(target).st_size, "sha256": digest.hexdigest()}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("E_ARCHIVE_WORKER", file=sys.stderr)
        sys.exit(1)
