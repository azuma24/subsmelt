# ---- Build Stage ----
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
# ci, not install: the lockfile is authoritative for a reproducible image.
# --legacy-peer-deps: i18next@26 declares typescript as an OPTIONAL peer at
# "^5 || ^6" while this repo is on typescript@7, which the image's npm 10
# rejects outright. The peer is types-only and the lockfile resolves cleanly.
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build

# ---- ffmpeg Stage ----
# Built from source with only what yt-dlp needs to merge, remux, extract audio
# and convert captions: 7 MB for ffmpeg and ffprobe together, against 390 MB
# for Debian's package. No MP3 (YouTube never serves it; it would always mean
# re-encoding through LAME).
FROM node:22-slim AS ffmpeg
ARG FFMPEG_VERSION=7.1.2
ARG FFMPEG_SHA256=089bc60fb59d6aecc5d994ff530fd0dcb3ee39aa55867849a2bbc4e555f9c304
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential nasm curl ca-certificates xz-utils \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSL -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
  && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
  && tar -xJf ffmpeg.tar.xz --strip-components=1 \
  && rm ffmpeg.tar.xz
RUN ./configure --prefix=/opt/ff --disable-everything --disable-autodetect --disable-doc --disable-debug \
      --enable-small --disable-ffplay --enable-ffmpeg --enable-ffprobe \
      --enable-protocol=file,pipe \
      --enable-demuxer=mov,matroska,ogg,webvtt,srt,ass,aac,mp3,ffmetadata,concat \
      --enable-muxer=mp4,ipod,mov,matroska,webm,ogg,opus,srt,webvtt,ass,adts,ffmetadata,null \
      --enable-decoder=aac,opus,vorbis,mp3,webvtt,subrip,srt,ass,mov_text \
      --enable-encoder=aac,srt,subrip,webvtt,ass,mov_text \
      --enable-parsers --enable-bsfs \
      --enable-filter=aresample,aformat,anull,null,atrim,copy \
  && make -j"$(nproc)" \
  && make install

# ---- yt-dlp Stage ----
# The official standalone build, pinned and checksummed per architecture. It
# bundles Python and the yt-dlp-ejs scripts; the image's Node runs them
# (--js-runtimes node), so no extra runtime is downloaded.
FROM node:22-slim AS ytdlp
ARG TARGETARCH
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256_AMD64=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
ARG YTDLP_SHA256_ARM64=b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "${TARGETARCH}" in \
    amd64) asset=yt-dlp_linux; sum="${YTDLP_SHA256_AMD64}" ;; \
    arm64) asset=yt-dlp_linux_aarch64; sum="${YTDLP_SHA256_ARM64}" ;; \
    *) echo "yt-dlp: no standalone build for ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}"; \
  echo "${sum}  /yt-dlp" | sha256sum -c -; \
  chmod 755 /yt-dlp; \
  curl -fsSL -o /yt-dlp-LICENSE "https://raw.githubusercontent.com/yt-dlp/yt-dlp/${YTDLP_VERSION}/LICENSE"

# ---- Production Stage ----
FROM node:22-slim
WORKDIR /app

# Install tzdata for timezone support
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

# Copy node_modules from builder (includes compiled better-sqlite3 native addon)
# then prune dev dependencies without recompiling anything.
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev --legacy-peer-deps

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts

# YouTube runtime. SubSmelt runs yt-dlp as a separate program (never linked),
# and prefers a newer copy under ${DATA_DIR}/bin when "Update yt-dlp" made one.
COPY --from=ffmpeg /opt/ff/bin/ffmpeg /opt/ff/bin/ffprobe /usr/local/bin/
COPY --from=ytdlp /yt-dlp /usr/local/bin/yt-dlp
COPY --from=ytdlp /yt-dlp-LICENSE /usr/share/licenses/yt-dlp/LICENSE

# Create directories
RUN mkdir -p /app/data /app/config

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV CONFIG_DIR=/app/config
ENV MEDIA_DIR=/media
ENV TZ=UTC

EXPOSE 3000

CMD ["node", "dist/server/index.js"]
