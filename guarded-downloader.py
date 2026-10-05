"""Bridge yt-dlp's HTTP proxy transport to a private Unix socket.

The parent seccomp launcher blocks Internet sockets, including in children.
This adapter only supplies the internal proxy connection. TLS is still checked
by yt-dlp against the original server name, with no TLS interception.
"""

import errno
import importlib.util
import os
import socket
import ssl  # Load SSLSocket against the real socket class before adapting it.
import sys

sys.path.insert(0, "/opt/yt-dlp")

if sys.argv[1:] == ["--version"]:
    from yt_dlp.version import __version__
    import yt_dlp_ejs
    from yt_dlp.extractor.youtube.jsc._builtin import vendor
    from yt_dlp_ejs.yt import solver
    if yt_dlp_ejs.version != vendor.VERSION or not solver.core() or not solver.lib():
        sys.exit("Compatible local yt-dlp-ejs solver assets are required")
    print(__version__)
    sys.exit(0)

socket_path = os.environ.pop("APP_EGRESS_SOCKET", "")
proxy_token = os.environ.pop("APP_EGRESS_TOKEN", "")
if not socket_path or not proxy_token:
    sys.exit("Internal download proxy configuration is required")

original_socket = socket.socket


class ProxySocket(original_socket):
    def __init__(self, family=socket.AF_INET, type=socket.SOCK_STREAM, proto=0, fileno=None):
        self.proxy_transport = family in (socket.AF_INET, socket.AF_INET6) and fileno is None
        if self.proxy_transport:
            if type & 0xF != socket.SOCK_STREAM:
                raise PermissionError(errno.EPERM, "Only the internal HTTP proxy transport is available")
            family, proto = socket.AF_UNIX, 0
        super().__init__(family, type, proto, fileno=fileno)

    def connect(self, address):
        if self.proxy_transport:
            if not isinstance(address, tuple) or address[:2] != ("127.0.0.1", 1):
                raise PermissionError(errno.EPERM, "Direct download connections are blocked")
            address = socket_path
        return super().connect(address)

    def connect_ex(self, address):
        try:
            self.connect(address)
            return 0
        except OSError as error:
            return error.errno

    def setsockopt(self, level, option, value, *args):
        if self.proxy_transport and level == socket.IPPROTO_TCP:
            return None
        return super().setsockopt(level, option, value, *args)


def proxy_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    # This synthetic endpoint is never a TCP listener or an actual DNS lookup.
    if host != "127.0.0.1" or int(port) != 1:
        raise PermissionError(errno.EPERM, "Downloader DNS must pass through the internal proxy")
    return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", 1))]


socket.socket = ProxySocket
socket.getaddrinfo = proxy_getaddrinfo
proxy_url = f"http://download:{proxy_token}@127.0.0.1:1"
for key in tuple(os.environ):
    if key.lower() in ("http_proxy", "https_proxy", "all_proxy", "no_proxy"):
        del os.environ[key]
os.environ["no_proxy"] = ""

from yt_dlp import main

if "--cookies" in sys.argv[1:]:
    # Python -I excludes /app from module lookup. Load this trusted file by
    # its fixed path, without adding the working directory to sys.path.
    policy_spec = importlib.util.spec_from_file_location("private_cookie_policy", "/app/private_cookie_policy.py")
    policy_module = importlib.util.module_from_spec(policy_spec)
    policy_spec.loader.exec_module(policy_module)
    policy_module.install_policy()

main([
    "--ignore-config", "--no-plugin-dirs", "--no-js-runtimes", "--no-remote-components",
    # Reset defaults, then permit only bundled Node. Its child inherits seccomp.
    "--js-runtimes", "node:/usr/local/bin/node",
    "--proxy", proxy_url, "--downloader", "native", *sys.argv[1:]
])
