FROM node:22-bookworm-slim AS sandbox-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*
COPY download-sandbox.c /src/download-sandbox.c
RUN gcc -std=c11 -O2 -Wall -Wextra -Werror /src/download-sandbox.c -o /download-sandbox

FROM node:22-bookworm-slim

# Official nightly; versions and hashes are updated together, never at runtime.
ARG YTDLP_VERSION=2026.9.27.232945.dev0
ARG YTDLP_WHEEL_URL=https://files.pythonhosted.org/packages/7d/87/c452ea389cd5b513e27d7d7f0d7038ff6be5d9ba48dd4417199283437270/yt_dlp-2026.9.27.232945.dev0-py3-none-any.whl
ARG YTDLP_SHA256=7dc975d3957bd6b38d56011cd2af112950fe9ac44638c75c9fa8695180a865e6
ARG YTDLP_EJS_VERSION=0.8.0
ARG YTDLP_EJS_WHEEL_URL=https://files.pythonhosted.org/packages/e3/bd/520769863744b669440a924271a6159ddd82ad5ae26b4ac4d4b69e9f8d44/yt_dlp_ejs-0.8.0-py3-none-any.whl
ARG YTDLP_EJS_SHA256=79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4
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
    && curl --fail --location --silent --show-error "$YTDLP_EJS_WHEEL_URL" --output /tmp/yt-dlp-ejs.whl \
    && echo "${YTDLP_EJS_SHA256}  /tmp/yt-dlp-ejs.whl" | sha256sum --check --status \
    && python3 -m zipfile -e /tmp/yt-dlp-ejs.whl /opt/yt-dlp \
    && python3 -c "import sys; sys.path.insert(0, '/opt/yt-dlp'); from importlib.metadata import version; assert version('yt-dlp') == '${YTDLP_VERSION}'; import yt_dlp_ejs; from yt_dlp.extractor.youtube.jsc._builtin import vendor; assert yt_dlp_ejs.version == '${YTDLP_EJS_VERSION}' == vendor.VERSION; from yt_dlp_ejs.yt import solver; assert solver.core() and solver.lib(); from Cryptodome.Cipher import AES" \
    && rm /tmp/yt-dlp.whl /tmp/yt-dlp-ejs.whl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node package.json server.js network-policy.js egress-proxy.js guarded-downloader.py private-session.js media-output.js private_cookie_policy.py ./
COPY --from=sandbox-build /download-sandbox /usr/local/bin/download-sandbox
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint
COPY yt-dlp-launcher.sh /usr/local/bin/yt-dlp
RUN chmod 0755 /usr/local/bin/docker-entrypoint /usr/local/bin/yt-dlp /usr/local/bin/download-sandbox \
    && python3 -c "import ast; ast.parse(open('/app/guarded-downloader.py').read()); ast.parse(open('/app/private_cookie_policy.py').read())" \
    && mkdir -p /tmp/downloads /tmp/yt-dlp \
    && chown node:node /tmp/downloads /tmp/yt-dlp

ENV TMPDIR=/tmp/yt-dlp \
    PYTHONDONTWRITEBYTECODE=1
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(d=>{if(d.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint"]
CMD ["node", "server.js"]
