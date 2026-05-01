#!/bin/sh
set -eu

for candidate in \
  /usr/bin/ffprobe \
  /usr/lib/extensions/codecs-extra/bin/ffprobe \
  /usr/lib/extensions/ffmpeg-full/bin/ffprobe \
  /app/lib/ffmpeg/bin/ffprobe
do
  if [ -x "$candidate" ] && [ "$candidate" != "$0" ]; then
    exec "$candidate" "$@"
  fi
done

cat >&2 <<'EOF'
Tuneforge Flatpak could not find ffprobe inside the runtime sandbox.
This build intentionally does not bundle FFmpeg; install/use a Flatpak runtime that provides ffprobe.
EOF
exit 127
