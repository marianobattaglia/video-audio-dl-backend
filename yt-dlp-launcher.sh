#!/bin/sh
set -eu
exec /usr/bin/python3 -I -B /app/guarded-downloader.py "$@"
