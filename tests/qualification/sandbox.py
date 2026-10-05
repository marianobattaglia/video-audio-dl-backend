import errno
import os
import socket
import subprocess
import sys

for family, kind in [(socket.AF_INET, socket.SOCK_STREAM), (socket.AF_INET6, socket.SOCK_STREAM), (socket.AF_INET, socket.SOCK_DGRAM), (socket.AF_INET6, socket.SOCK_DGRAM), (socket.AF_NETLINK, socket.SOCK_RAW)]:
    try:
        socket.socket(family, kind)
    except OSError as error:
        assert error.errno == errno.EPERM, error
    else:
        raise AssertionError("Internet/alternative socket was allowed")
left, right = socket.socketpair(socket.AF_UNIX)
left.close()
right.close()
child = subprocess.run([sys.executable, "-c", "import socket,errno\ntry: socket.socket(socket.AF_INET,socket.SOCK_STREAM)\nexcept OSError as e: assert e.errno==errno.EPERM\nelse: raise AssertionError('child escaped')"], capture_output=True)
assert child.returncode == 0, child.stderr
status = open("/proc/self/status").read()
assert "NoNewPrivs:\t1" in status and "Seccomp:\t2" in status
print("IPv4 IPv6 TCP UDP NETLINK denied; Unix allowed; child inherits seccomp")
