#!/usr/bin/env bash
# Render a Playwright screencast webm into a shareable mp4 (default) or gif.
# usage: render.sh INPUT.webm [-o OUTPUT] [--gif] [--speed FACTOR] [--fps N]
# On success the last stdout line is the absolute path of the rendered file;
# diagnostics go to stderr. Exits 0 on success, 1 on ffmpeg failure, 2 on usage.

set -u

usage() {
  echo "usage: render.sh INPUT.webm [-o OUTPUT] [--gif] [--speed FACTOR] [--fps N]" >&2
  exit 2
}

INPUT="" OUTPUT="" GIF=0 SPEED="" FPS=12
while [ $# -gt 0 ]; do
  case "$1" in
    -o)
      OUTPUT="${2:-}"
      [ -n "$OUTPUT" ] || usage
      shift 2
      ;;
    --gif)
      GIF=1
      shift
      ;;
    --speed)
      SPEED="${2:-}"
      [ -n "$SPEED" ] || usage
      shift 2
      ;;
    --fps)
      FPS="${2:-}"
      [ -n "$FPS" ] || usage
      shift 2
      ;;
    -*) usage ;;
    *)
      [ -z "$INPUT" ] || usage
      INPUT="$1"
      shift
      ;;
  esac
done

[ -n "$INPUT" ] || usage
[ -f "$INPUT" ] || {
  echo "input not found: $INPUT" >&2
  exit 2
}

SETPTS=""
[ -n "$SPEED" ] && SETPTS="setpts=PTS/${SPEED},"

if [ "$GIF" -eq 1 ]; then
  OUT="${OUTPUT:-${INPUT%.webm}.gif}"
  # Two-pass palette in one invocation keeps colors crisp at gif's 256-color cap.
  ffmpeg -y -loglevel error -i "$INPUT" \
    -filter_complex "${SETPTS}fps=${FPS},scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
    "$OUT" || exit 1
else
  OUT="${OUTPUT:-${INPUT%.webm}.mp4}"
  # The scale guard rounds to even dimensions — yuv420p rejects odd sizes.
  ffmpeg -y -loglevel error -i "$INPUT" \
    -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p \
    -vf "${SETPTS}scale=trunc(iw/2)*2:trunc(ih/2)*2" \
    -movflags +faststart \
    "$OUT" || exit 1
fi

realpath "$OUT"
