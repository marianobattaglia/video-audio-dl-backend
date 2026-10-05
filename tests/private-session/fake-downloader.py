#!/usr/bin/python3
"""Adversarial fixture. Runs under the real inherited seccomp launcher."""
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import time
import urllib.parse

if sys.argv[1:] == ["--version"]:
    print("synthetic-downloader-fixture")
    sys.exit(0)

args = sys.argv[1:]
url = urllib.parse.urlsplit(args[-1])
mode = urllib.parse.parse_qs(url.query).get("v", ["complete"])[0]
cookie_file = args[args.index("--cookies") + 1] if "--cookies" in args else None
value = pathlib.Path(cookie_file).read_text().splitlines()[-1].split("\t")[-1] if cookie_file else "no-session"
audit = pathlib.Path(os.environ["TMPDIR"]) / "fixture-audit.json"
audit.write_text(json.dumps({"pid": os.getpid(), "args": args, "cookieFile": cookie_file, "hasCredentialEnv": "ACCESS_CREDENTIAL" in os.environ, "hasSourceEnv": "YOUTUBE_COOKIES_FILE" in os.environ}))
print("ERROR: fixture diagnostic " + value, file=sys.stderr, flush=True)
print("fixture output " + value, flush=True)

if mode in ("slow", "timeout", "child"):
    print("DL_PROGRESS:25:20", flush=True)
    if mode == "child" and cookie_file:
        code = "import os,signal,time,pathlib;signal.signal(signal.SIGTERM,signal.SIG_IGN);p=pathlib.Path(" + repr(cookie_file) + ");\nwhile True:\n p.write_text('synthetic-recreated-copy');time.sleep(.1)"
        subprocess.Popen(["/usr/bin/python3", "-c", code])
    if mode != "slow":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True:
        time.sleep(.1)
if mode == "failure":
    sys.exit(1)
if mode == "outside":
    print("APP_OUTPUT:" + (cookie_file or "/fixtures/youtube-cookies.txt"), flush=True)
    sys.exit(0)
template = args[args.index("-o") + 1]
audio = "--audio-format" in args
output = pathlib.Path(template.replace("%(ext)s", "mp3" if audio else "mp4"))
if mode == "symlink":
    output.symlink_to("/fixtures/youtube-cookies.txt")
elif mode == "hardlink":
    os.link(cookie_file, output)
elif mode == "jar-growth":
    pathlib.Path(cookie_file).write_bytes(bytes(4 * 1024 * 1024))
    while True:
        time.sleep(.1)
elif mode == "oversize":
    output.write_bytes(b"\0\0\0\x18ftypmp42" + bytes(2 * 1024 * 1024))
    while True:
        time.sleep(.1)
elif mode == "title":
    output = output.with_name(value + output.suffix)
    shutil.copyfile("/tmp/yt-dlp/qualification-media.mp4", output)
elif audio:
    subprocess.run(["/usr/bin/ffmpeg", "-v", "error", "-i", "/tmp/yt-dlp/qualification-media.mp4", "-y", str(output)], check=True)
else:
    shutil.copyfile("/tmp/yt-dlp/qualification-media.mp4", output)
print("APP_OUTPUT:" + str(output), flush=True)
