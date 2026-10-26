#!/bin/sh
# One command from source to film. Set MF to the motion-film skill folder (where scripts/ lives).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
MF=${MF:-"$HERE/../.."}
S="$MF/scripts"
[ -f "$S/render.mjs" ] || { echo "set MF to the motion-film skill folder"; exit 1; }
[ -d "$HERE/node_modules/puppeteer-core" ] || (cd "$HERE" && npm i --silent puppeteer-core)
NAME=${NAME:-starter}
node "$S/render.mjs" "$HERE" --readcheck
node "$S/render.mjs" "$HERE" --events out/events.json
node "$S/render.mjs" "$HERE" --out out/video.mp4 --workers 3 --mb 2
python3 "$S/sfx.py" "$HERE/out/events.json" "$HERE/out/mix.wav"     # add: --music bgm.wav --music-gain 0.34
sh "$S/master.sh" "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/$NAME.mp4" --grain 3
cp "$HERE/out/events.srt" "$HERE/$NAME.srt" 2>/dev/null || true
ffmpeg -v error -y -ss 7.6 -i "$HERE/$NAME.mp4" -frames:v 1 "$HERE/poster.jpg"
echo "✓ $NAME.mp4  $NAME.srt  poster.jpg"
