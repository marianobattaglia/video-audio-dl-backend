"""No Internet or cookies: exercise the actual pinned extraction policy."""
import importlib.util
import sys
sys.path.insert(0, "/opt/yt-dlp")
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError
spec = importlib.util.spec_from_file_location("single_media_policy", "/app/single_media_policy.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
policy.install_policy("single")
class Deferred:
    def __iter__(self):
        raise AssertionError("Entries must not be traversed")
with YoutubeDL({"quiet": True}) as ydl:
    for kind in ("playlist", "multi_video"):
        try:
            ydl.process_ie_result({"_type": kind, "entries": Deferred()})
            raise AssertionError("A multi-media result was accepted")
        except DownloadError as error:
            assert "E_SINGLE_MEDIA_ONLY" in str(error)
print("Single-media policy rejects eager and deferred multi-media results")
