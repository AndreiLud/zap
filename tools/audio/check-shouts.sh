#!/bin/sh
# Listening proxy for the shouts: decodes each web/src/sfx/<name>.opus back to WAV and prints a
# Markdown table with its size, duration, peak and RMS level. It also writes, under
# .cache/audio-check/, the decoded WAV files, the dry espeak-ng voice of each word, one
# spectrogram per word (dry and processed) to compare by eye, and all-shouts.wav: the nine shouts
# in the order of shouts.txt with half a second of silence between them, for one listening pass.
# Run: docker compose --profile audio run --rm -T audio sh tools/audio/check-shouts.sh
set -eu
cd "$(dirname "$0")/../.."
SFX=web/src/sfx
OUT=.cache/audio-check
mkdir -p "$OUT"
SOX="sox -D -R -V1"
echo "| Shout | Bytes | Duration (s) | Peak (dBFS) | RMS (dBFS) | Dry voice (s) |"
echo "| --- | ---: | ---: | ---: | ---: | ---: |"
grep -v '^#' tools/audio/shouts.txt | while IFS='|' read -r name text pitch speed; do
  [ -n "$name" ] || continue
  opusdec --quiet --rate 48000 "$SFX/$name.opus" "$OUT/$name.wav"
  espeak-ng -v pt-br+m3 -p "$pitch" -s "$speed" -a 190 -w "$OUT/$name-dry-raw.wav" "$text"
  $SOX "$OUT/$name-dry-raw.wav" -r 48000 -b 16 "$OUT/$name-dry.wav" silence 1 0.01 0.5% reverse silence 1 0.01 0.5% reverse
  rm -f "$OUT/$name-dry-raw.wav"
  bytes=$(wc -c < "$SFX/$name.opus" | tr -d ' ')
  stats=$($SOX "$OUT/$name.wav" -n stats 2>&1)
  dur=$(soxi -D "$OUT/$name.wav")
  dry=$(soxi -D "$OUT/$name-dry.wav")
  pk=$(printf '%s\n' "$stats" | awk '/^Pk lev dB/ { print $4 }')
  rms=$(printf '%s\n' "$stats" | awk '/^RMS lev dB/ { print $4 }')
  printf '| %s | %s | %.3f | %s | %s | %.3f |\n' "$name" "$bytes" "$dur" "$pk" "$rms" "$dry"
  $SOX "$OUT/$name-dry.wav" -n remix 1 rate 22050 spectrogram -x 600 -y 200 -z 80 -t "$name dry" -o "$OUT/$name-dry.png"
  $SOX "$OUT/$name.wav" -n remix 1 rate 22050 spectrogram -x 600 -y 200 -z 80 -t "$name processed" -o "$OUT/$name-processed.png"
done
$SOX -n -r 48000 -c 1 -b 16 "$OUT/gap.wav" trim 0 0.5
list=""
for name in $(grep -v '^#' tools/audio/shouts.txt | cut -d'|' -f1); do list="$list $OUT/$name.wav $OUT/gap.wav"; done
# shellcheck disable=SC2086
$SOX $list "$OUT/all-shouts.wav"
rm -f "$OUT/gap.wav"
