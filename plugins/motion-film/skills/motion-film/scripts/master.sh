#!/bin/sh
# master.sh — mux picture + mix, two-pass loudnorm to −14 LUFS / −1 dBTP, optional film grain, then a spec report.
#   sh master.sh <video.mp4> <mix.wav|none> <out.mp4> [--grain 6] [--lufs -14] [--tp -1] [--crf 18]
# Exits non-zero if a step fails. Prints: duration, size, fps, loudness, true peak, black frames.
set -e
[ $# -ge 3 ] || { echo "usage: sh master.sh video.mp4 mix.wav|none out.mp4 [--grain N] [--lufs -14] [--tp -1] [--crf 18]"; exit 2; }
V=$1; A=$2; O=$3; shift 3
GRAIN=0; LUFS=-14; TP=-1; CRF=18
while [ $# -gt 0 ]; do case "$1" in
  --grain) GRAIN=$2; shift 2;; --lufs) LUFS=$2; shift 2;; --tp) TP=$2; shift 2;; --crf) CRF=$2; shift 2;;
  *) echo "unknown option $1"; exit 2;; esac; done
command -v ffmpeg >/dev/null || { echo "✗ ffmpeg not found"; exit 1; }

VF=""
[ "$GRAIN" != "0" ] && VF="-vf noise=alls=${GRAIN}:allf=t -tune grain"

if [ "$A" = "none" ]; then
  # shellcheck disable=SC2086
  ffmpeg -v error -y -i "$V" -c:v libx264 -preset veryfast -crf "$CRF" -pix_fmt yuv420p $VF -an -movflags +faststart "$O"
else
  measure() {  # $1 = filter chain before loudnorm (or "anull")
    J=$(ffmpeg -hide_banner -nostats -i "$A" -af "$1,loudnorm=I=${LUFS}:TP=${TP}:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
    get() { echo "$J" | grep "\"$1\"" | sed 's/.*: *"\{0,1\}\([^",]*\)"\{0,1\},\{0,1\}/\1/'; }
    MI=$(get input_i); MTP=$(get input_tp); MLRA=$(get input_lra); MT=$(get input_thresh); OFF=$(get target_offset)
    [ -n "$MI" ] || { echo "✗ loudness measurement failed"; exit 1; }
  }
  # pass 1: measure. Peaky foley often can't reach the target under the true-peak ceiling (peak-to-loudness > 13 dB):
  # then pre-gain and limit first, and measure the limited chain again.
  PRE=anull; measure "$PRE"
  NEED=$(awk -v t="$LUFS" -v i="$MI" -v p="$MTP" -v c="$TP" 'BEGIN{g=t-i; over=(p+g)-(c-0.3); if (over>0.2) printf "%.2f", g; else print ""}')
  if [ -n "$NEED" ]; then
    LIM=$(awk -v c="$TP" 'BEGIN{printf "%.4f", 10^((c-0.5)/20)}')
    PRE="volume=${NEED}dB,alimiter=limit=${LIM}:attack=2:release=60:level=disabled"
    echo "  peak-limited mix: +${NEED} dB into a limiter at $(awk -v c="$TP" 'BEGIN{print c-0.5}') dBFS before loudnorm"
    measure "$PRE"
  fi
  AF="${PRE},loudnorm=I=${LUFS}:TP=${TP}:LRA=11:measured_I=${MI}:measured_TP=${MTP}:measured_LRA=${MLRA}:measured_thresh=${MT}:offset=${OFF}:linear=true,aresample=48000"
  if [ "$GRAIN" = "0" ]; then VCODEC="-c:v copy"; else VCODEC="-c:v libx264 -preset veryfast -crf $CRF -pix_fmt yuv420p $VF"; fi
  # pass 2: apply; -shortest keeps picture length authoritative
  # shellcheck disable=SC2086
  ffmpeg -v error -y -i "$V" -i "$A" -map 0:v:0 -map 1:a:0 $VCODEC -af "$AF" -c:a aac -b:a 256k -ar 48000 -ac 2 -shortest -movflags +faststart "$O"
fi

echo "── report: $O"
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,nb_frames -show_entries format=duration -of default=nw=1 "$O" | tr '\n' ' '; echo
if ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$O" | grep -q .; then
  ffmpeg -hide_banner -nostats -i "$O" -map 0:a -af ebur128=peak=true -f null - 2>&1 | grep -E '^\s+(I:|Peak:|LRA:)' | sed 's/^ */  /'
else echo "  (no audio track)"; fi
BL=$(ffmpeg -hide_banner -nostats -i "$O" -vf "blackdetect=d=0.1:pix_th=0.06" -an -f null - 2>&1 | grep -o 'black_start:[0-9.]* black_end:[0-9.]*' || true)
if [ -n "$BL" ]; then echo "  black spans (check they are intended):"; echo "$BL" | sed 's/^/    /'; else echo "  no black spans ≥ 0.1 s"; fi
