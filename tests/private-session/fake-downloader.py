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
if os.environ.get("APP_MEDIA_MODE") == "playlist_preview":
    playlist = urllib.parse.parse_qs(url.query).get("list", [""])[0]
    if playlist == "PLslow":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        while True:
            time.sleep(.1)
    if playlist == "PLoversize":
        print("x" * (300 * 1024), flush=True)
    elif playlist == "PLbadjson":
        print("not-json", flush=True)
    else:
        total = 123 if playlist == "PLpages" else 51 if playlist == "PLlarge" else 0 if playlist == "PLempty" else 7
        span = args[args.index("--playlist-items") + 1]
        first, last = map(int, span.split(":"))
        indices = range(first - 1, min(last, total))
        entries = [{"id": f"pl{i:09d}", "title": f"Canción de prueba {i + 1}", "duration": 3,
                    "url": "http://127.0.0.1/never", "http_headers": {"Cookie": value}, "thumbnail": "https://untrusted.invalid/image"} for i in indices]
        if first == 1 and entries and playlist in ("PLmixed", "PLlarge"):
            entries[1]["id"] = entries[0]["id"]
            entries[2] = {"title": "[Private video]", "http_headers": {"Cookie": value}}
            entries[3]["title"] = "<img src=x onerror=alert(1)>"
            entries[3].pop("duration")
        if playlist == "PLpartial":
            entries[1]["id"] = "fail0000000"
        if playlist == "PLbots":
            entries[1]["id"] = "bots0000000"
        if playlist == "PLactive":
            entries[1]["id"] = "slow0000000"
        print(json.dumps({"_type": "playlist", "title": "Lista de prueba · música", "entries": entries,
                          "playlist_count": 80 if playlist == "PLlarge" else None if playlist == "PLpages" else total, "http_headers": {"Cookie": value}, "filepath": cookie_file}), flush=True)
    sys.exit(0)
if mode == "slow0000000":
    mode = "slow"
if mode in ("fail0000000", "bots0000000"):
    print("ERROR: Video unavailable" if mode == "fail0000000" else "ERROR: Sign in to confirm you're not a bot", file=sys.stderr, flush=True)
    sys.exit(1)
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
if mode == "readable-title":
    print("APP_TITLE:" + json.dumps("Canción / de prueba: ¿Qué tal?"), flush=True)
if mode.startswith("pl"):
    print("APP_TITLE:" + json.dumps("Canción de prueba " + str(int(mode[2:]) + 1)), flush=True)
print("APP_OUTPUT:" + str(output), flush=True)
