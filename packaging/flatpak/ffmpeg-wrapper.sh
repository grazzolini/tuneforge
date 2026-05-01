#!/bin/sh
set -eu

for candidate in \
  /usr/bin/ffmpeg \
  /usr/lib/extensions/codecs-extra/bin/ffmpeg \
  /usr/lib/extensions/ffmpeg-full/bin/ffmpeg \
  /app/lib/ffmpeg/bin/ffmpeg
do
  if [ -x "$candidate" ] && [ "$candidate" != "$0" ]; then
    exec "$candidate" "$@"
  fi
done

cat >&2 <<'EOF'
Tuneforge Flatpak could not find ffmpeg inside the runtime sandbox.
This build intentionally does not bundle FFmpeg; install/use a Flatpak runtime that provides ffmpeg.
EOF
exit 127
