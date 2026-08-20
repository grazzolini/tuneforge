# syntax=docker/dockerfile:1

FROM --platform=linux/amd64 ubuntu:24.04@sha256:1e0a86e57d247923571b75e0aaf48a1449cf8c543d51fb3e07a4a7d7bfa79316

ARG FFMPEG_VERSION=7:6.1.1-3ubuntu5
ARG FFMPEG_DEB_URL=https://archive.ubuntu.com/ubuntu/pool/universe/f/ffmpeg/ffmpeg_6.1.1-3ubuntu5_amd64.deb
ARG FFMPEG_DEB_SHA256=1a23baace5f2688a47e28119aedae6993cd638e6279a7227dfc52d9a337a1c17
ARG FFMPEG_SHA256=ed16af623947494a72e284b6eb8ff225f2da22b38b5d5069c2fd4b4ba3384e41
ARG FFPROBE_SHA256=272f6ebc634a63d9c8b4ca68e964119d980f25154e5aa2c35e5487da48e9a58f
ARG PLAYWRIGHT_VERSION=1.62.1
ARG PLAYWRIGHT_SYSTEM_PACKAGES="\
xvfb fonts-noto-color-emoji fonts-unifont libfontconfig1 libfreetype6 \
xfonts-cyrillic xfonts-scalable fonts-liberation fonts-ipafont-gothic \
fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf libasound2t64 \
libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 \
libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
libxkbcommon0 libxrandr2"

LABEL org.opencontainers.image.source="https://github.com/grazzolini/tuneforge" \
      org.opencontainers.image.description="Ubuntu CI dependencies for TuneForge" \
      org.opencontainers.image.licenses="LicenseRef-TuneForge-CI-Image"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      file \
      git \
      gzip \
      libasound2-dev \
      libayatana-appindicator3-dev \
      libclang-dev \
      libgtk-3-dev \
      librsvg2-dev \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libxdo-dev \
      openssh-client \
      pkg-config \
      tar \
      unzip \
      wget \
      xz-utils \
      zstd; \
    read -r -a playwright_system_packages <<< "${PLAYWRIGHT_SYSTEM_PACKAGES}"; \
    apt-get install -y --no-install-recommends "${playwright_system_packages[@]}"; \
    ffmpeg_deb="$(mktemp --suffix=.deb)"; \
    curl --proto '=https' --tlsv1.2 --fail --location --retry 5 \
      --output "${ffmpeg_deb}" "${FFMPEG_DEB_URL}"; \
    printf '%s  %s\n' "${FFMPEG_DEB_SHA256}" "${ffmpeg_deb}" | sha256sum -c -; \
    apt-get install -y --no-install-recommends "${ffmpeg_deb}"; \
    rm -f "${ffmpeg_deb}"; \
    test "$(dpkg-query -W -f='${Version}' ffmpeg)" = "${FFMPEG_VERSION}"; \
    printf '%s  %s\n' "${FFMPEG_SHA256}" /usr/bin/ffmpeg | sha256sum -c -; \
    printf '%s  %s\n' "${FFPROBE_SHA256}" /usr/bin/ffprobe | sha256sum -c -; \
    test -f /usr/share/doc/ffmpeg/copyright; \
    install -d /usr/share/tuneforge-ci; \
    printf '%s\n' \
      'ubuntu:24.04@sha256:1e0a86e57d247923571b75e0aaf48a1449cf8c543d51fb3e07a4a7d7bfa79316' \
      > /usr/share/tuneforge-ci/base-image.txt; \
    printf '%s\n' "${PLAYWRIGHT_VERSION}" \
      > /usr/share/tuneforge-ci/playwright-version.txt; \
    printf 'ffmpeg package: %s\nffmpeg package URL: %s\nffmpeg package SHA-256: %s\n' \
      "${FFMPEG_VERSION}" "${FFMPEG_DEB_URL}" "${FFMPEG_DEB_SHA256}" \
      > /usr/share/tuneforge-ci/ffmpeg-source.txt; \
    printf '%s  %s\n%s  %s\n' \
      "${FFMPEG_SHA256}" /usr/bin/ffmpeg \
      "${FFPROBE_SHA256}" /usr/bin/ffprobe \
      > /usr/share/tuneforge-ci/ffmpeg.sha256; \
    ffmpeg -version > /usr/share/tuneforge-ci/ffmpeg-version.txt; \
    ffmpeg -buildconf > /usr/share/tuneforge-ci/ffmpeg-buildconf.txt; \
    dpkg-query -W -f='${binary:Package}\t${Version}\n' | LC_ALL=C sort \
      > /usr/share/tuneforge-ci/packages.txt; \
    validation_dir="$(mktemp -d)"; \
    ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi \
      -i 'sine=frequency=440:sample_rate=48000:duration=1' \
      -c:a pcm_s16le "${validation_dir}/tone.wav"; \
    ffmpeg -nostdin -hide_banner -loglevel error -y -i "${validation_dir}/tone.wav" \
      -c:a flac "${validation_dir}/tone.flac"; \
    ffmpeg -nostdin -hide_banner -loglevel error -y -i "${validation_dir}/tone.wav" \
      -c:a libmp3lame -b:a 192k "${validation_dir}/tone.mp3"; \
    ffmpeg -nostdin -hide_banner -loglevel error -y -i "${validation_dir}/tone.wav" \
      -c:a aac -profile:a aac_low -b:a 192k "${validation_dir}/tone.m4a"; \
    test "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name \
      -of default=noprint_wrappers=1:nokey=1 "${validation_dir}/tone.wav")" = pcm_s16le; \
    test "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name \
      -of default=noprint_wrappers=1:nokey=1 "${validation_dir}/tone.flac")" = flac; \
    test "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name \
      -of default=noprint_wrappers=1:nokey=1 "${validation_dir}/tone.mp3")" = mp3; \
    test "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name \
      -of default=noprint_wrappers=1:nokey=1 "${validation_dir}/tone.m4a")" = aac; \
    test "$(ffprobe -v error -select_streams a:0 -show_entries stream=profile \
      -of default=noprint_wrappers=1:nokey=1 "${validation_dir}/tone.m4a")" = LC; \
    for artifact in tone.wav tone.flac tone.mp3 tone.m4a; do \
      printf '%s\t' "${artifact}"; \
      ffprobe -v error -select_streams a:0 \
        -show_entries format=format_name:stream=codec_name,profile,sample_rate,channels \
        -of json=compact=1 "${validation_dir}/${artifact}" | tr -d '\n'; \
      printf '\n'; \
    done > /usr/share/tuneforge-ci/codec-validation.jsonl; \
    rm -rf "${validation_dir}"; \
    cat /usr/share/tuneforge-ci/ffmpeg-source.txt; \
    cat /usr/share/tuneforge-ci/ffmpeg.sha256; \
    cat /usr/share/tuneforge-ci/codec-validation.jsonl; \
    rm -rf /var/lib/apt/lists/*

COPY README.md /usr/share/doc/tuneforge-ci/README.md
