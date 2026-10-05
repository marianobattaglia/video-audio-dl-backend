"""Entirely simulated HTTP messages; no network access or real session."""
import http.cookiejar
import io
import pathlib
import sys
import urllib.request
from email.message import Message

sys.path.insert(0, "/app")
sys.path.insert(0, "/opt/yt-dlp")
from private_cookie_policy import install_policy
install_policy()
import yt_dlp.cookies as cookies
from yt_dlp.networking._urllib import RedirectHandler

path = "/tmp/yt-dlp/policy-session.txt"
pathlib.Path(path).write_text("# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tDOMAIN\tsynthetic-domain\nwww.youtube.com\tFALSE\t/watch\tTRUE\t0\tHOST\tsynthetic-host\n.youtube.com\tTRUE\t/\tTRUE\t1\tEXPIRED\tsynthetic-expired\n")
jar = cookies.load_cookies(path, None, None)
assert "DOMAIN=" in jar.get_cookie_header("https://www.youtube.com/watch")
assert "HOST=" in jar.get_cookie_header("https://www.youtube.com/watch")
assert "HOST=" not in jar.get_cookie_header("https://www.youtube.com/other")
assert "HOST=" not in jar.get_cookie_header("https://m.youtube.com/watch")
assert "EXPIRED=" not in jar.get_cookie_header("https://www.youtube.com/watch")
for url in ["http://www.youtube.com/watch", "https://youtu.be/x", "https://youtube.com.evil.test/watch", "https://google.com/watch", "https://example.com/"]:
    assert not jar.get_cookie_header(url)

class Response:
    def __init__(self, cookie):
        self.headers = Message()
        self.headers.add_header("Set-Cookie", cookie)
    def info(self):
        return self.headers

for cookie in ["NEW=synthetic-new; Domain=.youtube.com; Path=/", "EVIL=synthetic-evil; Domain=.google.com; Path=/"]:
    jar.extract_cookies(Response(cookie), urllib.request.Request("https://www.youtube.com/watch"))
assert "NEW=" in jar.get_cookie_header("https://www.youtube.com/watch")
assert not jar.get_cookie_header("http://www.youtube.com/watch")
assert all(cookie.secure and cookie.name != "EVIL" for cookie in jar)
request = urllib.request.Request("https://www.youtube.com/watch", headers={"Cookie": "DOMAIN=synthetic-domain"})
redirect = RedirectHandler().redirect_request(request, io.BytesIO(), 302, "redirect", {}, "https://example.com/")
jar.add_cookie_header(redirect)
assert redirect.get_header("Cookie") is None
redirect = RedirectHandler().redirect_request(urllib.request.Request("https://youtu.be/x"), io.BytesIO(), 302, "redirect", {}, "https://www.youtube.com/watch")
jar.add_cookie_header(redirect)
assert "DOMAIN=" in redirect.get_header("Cookie")
jar.save()
assert pathlib.Path(path).stat().st_mode & 0o777 == 0o600
assert "\tTRUE\t" in pathlib.Path(path).read_text()
print("Cookie policy and actual yt-dlp merge/redirect integration passed")
