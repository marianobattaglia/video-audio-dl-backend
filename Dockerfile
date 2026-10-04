FROM node:22-bookworm-slim

ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
ARG FFMPEG_PACKAGE_VERSION=7:5.1.9-0+deb12u1

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DOWNLOAD_TMP_DIR=/tmp/downloads \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    MAX_CONCURRENT_DOWNLOADS=1 \
    MAX_DOWNLOAD_SECONDS=600 \
    JOB_TTL_SECONDS=300 \
    MAX_OUTPUT_MB=64 \
    MAX_TEMP_MB=192

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg="${FFMPEG_PACKAGE_VERSION}" gosu iptables \
    && curl --fail --location --silent --show-error "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" --output /usr/local/bin/yt-dlp \
    && echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum --check --status \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN chmod 0755 /usr/local/bin/docker-entrypoint \
    && mkdir -p /tmp/downloads /tmp/yt-dlp \
    && chown node:node /tmp/downloads /tmp/yt-dlp

# Package installation must use the existing /tmp before this directory exists.
ENV TMPDIR=/tmp/yt-dlp \
    AUTH_REQUIRED=false

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(d=>{if(d.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint"]
CMD ["node", "server.js"]
