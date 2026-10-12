"""Trusted synthetic extractor, real pinned CLI, seccomp and guarded launcher."""
import runpy
import sys
sys.path.insert(0, "/opt/yt-dlp")
from yt_dlp import YoutubeDL
from yt_dlp.extractor.common import InfoExtractor

class FixtureIE(InfoExtractor):
    _VALID_URL = r"https://www\.youtube\.com/playlist\?list=PLcontrolled"

    def _real_extract(self, url):
        specification = sys.argv[sys.argv.index("--playlist-items") + 1]
        end = int(specification.split(":")[1])
        def entries():
            for i in range(123):
                if i >= end:
                    raise AssertionError("Preview traversed beyond requested page")
                yield {"_type": "url", "url": f"https://www.youtube.com/watch?v=pl{i:09d}",
                       "ie_key": "Youtube", "id": f"pl{i:09d}", "title": f"Fixture {i}"}
        return self.playlist_result(entries(), "PLcontrolled", "Controlled fixture")

YoutubeDL.add_default_info_extractors = lambda self: self.add_info_extractor(FixtureIE())
sys.argv[0] = "/app/guarded-downloader.py"
runpy.run_path("/app/guarded-downloader.py", run_name="__main__")
