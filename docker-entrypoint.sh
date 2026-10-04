#!/bin/sh
set -eu

# The unprivileged API owns the checked proxy. The downloader and its children
# receive a separate seccomp restriction, without NET_ADMIN or root.
exec "$@"
