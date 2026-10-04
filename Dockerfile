FROM node:22-bookworm-slim AS sandbox-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*
COPY download-sandbox.c /src/download-sandbox.c
RUN gcc -std=c11 -O2 -Wall -Wextra -Werror /src/download-sandbox.c -o /download-sandbox

FROM node:22-bookworm-slim

ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_WHEEL_URL=https://files.pythonhosted.org/packages/69/b2/8cd1613f56eed7ceb64fbd4df3f1c01246bfb098e6f398228bafda22b80b/yt_dlp-2026.8.19-py3-none-any.whl
ARG YTDLP_SHA256=1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf
ARG FFMPEG_PACKAGE_VERSION=7:5.1.9-0+deb12u1

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    AUTH_REQUIRED=false \
    DOWNLOAD_TMP_DIR=/tmp/downloads \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    DOWNLOAD_SANDBOX_PATH=/usr/local/bin/download-sandbox \
    MAX_CONCURRENT_DOWNLOADS=1 \
    MAX_DOWNLOAD_SECONDS=600 \
    JOB_TTL_SECONDS=300 \
    MAX_OUTPUT_MB=64 \
    MAX_TEMP_MB=192

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-pycryptodome ffmpeg="${FFMPEG_PACKAGE_VERSION}" \
    && curl --fail --location --silent --show-error "$YTDLP_WHEEL_URL" --output /tmp/yt-dlp.whl \
    && echo "${YTDLP_SHA256}  /tmp/yt-dlp.whl" | sha256sum --check --status \
    && python3 -m zipfile -e /tmp/yt-dlp.whl /opt/yt-dlp \
    && python3 -c "import sys; sys.path.insert(0, '/opt/yt-dlp'); from yt_dlp.version import __version__; assert __version__ == '${YTDLP_VERSION}'; from Cryptodome.Cipher import AES" \
    && rm /tmp/yt-dlp.whl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node package.json server.js network-policy.js egress-proxy.js guarded-downloader.py ./
COPY --from=sandbox-build /download-sandbox /usr/local/bin/download-sandbox
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint
COPY yt-dlp-launcher.sh /usr/local/bin/yt-dlp
RUN chmod 0755 /usr/local/bin/docker-entrypoint /usr/local/bin/yt-dlp /usr/local/bin/download-sandbox \
    && python3 -c "import ast; ast.parse(open('/app/guarded-downloader.py').read())" \
    && mkdir -p /tmp/downloads /tmp/yt-dlp \
    && chown node:node /tmp/downloads /tmp/yt-dlp

ENV TMPDIR=/tmp/yt-dlp \
    PYTHONDONTWRITEBYTECODE=1
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(d=>{if(d.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint"]
CMD ["node", "server.js"]
