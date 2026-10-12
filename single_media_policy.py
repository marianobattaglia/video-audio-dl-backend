"""Reject multi-media extraction before yt-dlp traverses or writes entries."""

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError


def install_policy(mode="single"):
    if mode not in ("single", "playlist_preview"):
        raise RuntimeError("E_MEDIA_MODE")
    original = YoutubeDL.process_ie_result

    def process(self, result, download=True, extra_info=None):
        if mode == "single" and isinstance(result, dict) and result.get("_type") in ("playlist", "multi_video"):
            raise DownloadError("E_SINGLE_MEDIA_ONLY: Usá la selección de lista para preparar varios archivos.")
        return original(self, result, download=download, extra_info=extra_info)

    YoutubeDL.process_ie_result = process
