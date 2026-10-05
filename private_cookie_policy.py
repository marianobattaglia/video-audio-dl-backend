"""YouTube-only, HTTPS-only cookies, including cookies received on redirects."""
import http.cookiejar
import os
import re
import urllib.parse

MAX_BYTES = 64 * 1024


def youtube_domain(domain):
    return bool(re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*youtube\.com", domain.removeprefix(".").lower()))


def safe_cookie(cookie):
    return (youtube_domain(cookie.domain) and cookie.path.startswith("/")
            and not re.search(r"[\x00-\x20\x7f]", cookie.path)
            and bool(re.fullmatch(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+", cookie.name or ""))
            and not re.search(r"[^\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]", cookie.value or ""))


class YouTubePolicy(http.cookiejar.DefaultCookiePolicy):
    def __init__(self):
        super().__init__(strict_ns_domain=self.DomainStrictNonDomain)

    def matches(self, cookie, request):
        url = urllib.parse.urlsplit(request.get_full_url())
        host = (url.hostname or "").lower()
        domain = cookie.domain.lstrip(".").lower()
        return (url.scheme == "https" and not host.startswith(".") and youtube_domain(host) and safe_cookie(cookie)
                and (host == domain or cookie.domain_specified and host.endswith("." + domain)))

    def set_ok(self, cookie, request):
        cookie.secure = True
        return self.matches(cookie, request) and super().set_ok(cookie, request)

    def return_ok(self, cookie, request):
        return cookie.secure and self.matches(cookie, request) and super().return_ok(cookie, request)


def install_policy():
    import yt_dlp.cookies as cookies
    original = cookies.YoutubeDLCookieJar

    class PrivateCookieJar(original):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.set_policy(YouTubePolicy())

        def set_cookie(self, cookie, *args, **kwargs):
            if not safe_cookie(cookie):
                return
            cookie.secure = True
            # Bound remote additions, as well as the original 64 KiB source.
            used = sum(len(c.name or "") + len(c.value or "") + len(c.domain) + len(c.path) + 80 for c in self)
            if used + len(cookie.name) + len(cookie.value or "") + len(cookie.domain) + len(cookie.path) + 80 > MAX_BYTES:
                return
            super().set_cookie(cookie, *args, **kwargs)

        def save(self, filename=None, ignore_discard=True, ignore_expires=True):
            if filename is not None and filename != self.filename:
                raise ValueError("E_COOKIE_SAVE")
            rows = ["# Netscape HTTP Cookie File\n"]
            for cookie in self:
                if not safe_cookie(cookie):
                    continue
                domain = ("." if cookie.domain_specified else "") + cookie.domain.lstrip(".")
                rows.append("\t".join((domain, "TRUE" if cookie.domain_specified else "FALSE", cookie.path,
                                       "TRUE", str(cookie.expires or 0), cookie.name, cookie.value or "")) + "\n")
            body = "".join(rows).encode("utf-8")
            if len(body) > MAX_BYTES:
                raise ValueError("E_COOKIE_SAVE")
            descriptor = os.open(self.filename, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW)
            with os.fdopen(descriptor, "wb") as target:
                os.fchmod(target.fileno(), 0o600)
                target.write(body)

    cookies.YoutubeDLCookieJar = PrivateCookieJar
