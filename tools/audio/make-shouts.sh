#!/bin/sh
# Makes the nine shouts once. Each line of shouts.txt: name|text|pitch|speed.
# espeak-ng (Brazilian Portuguese) -> trim silence -> ring modulation at 42 Hz, 70% wet
# -> bit reduction to 8 bits at 11,025 Hz -> pitch down 300 cents -> short metallic echo
# -> normalize -> fades -> Opus at 32 kbit/s. Output: web/src/sfx/<name>.opus and SHA256SUMS.
set -eu
cd "$(dirname "$0")/../.."
OUT=web/src/sfx
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
SOX="sox -D -R -V1"
grep -v '^#' tools/audio/shouts.txt | while IFS='|' read -r name text pitch speed; do
  [ -n "$name" ] || continue
  espeak-ng -v pt-br+m3 -p "$pitch" -s "$speed" -a 190 -w "$TMP/a.wav" "$text"
  $SOX "$TMP/a.wav" -r 22050 -c 1 -b 16 "$TMP/b.wav" silence 1 0.01 0.5% reverse silence 1 0.01 0.5% reverse
  dur=$(soxi -D "$TMP/b.wav")
  $SOX -n -r 22050 -c 1 -b 16 "$TMP/carrier.wav" synth "$dur" sine 42
  $SOX -T "$TMP/b.wav" "$TMP/carrier.wav" "$TMP/ring.wav"
  $SOX -m -v 0.3 "$TMP/b.wav" -v 0.7 "$TMP/ring.wav" "$TMP/c.wav" gain -n -1
  $SOX "$TMP/c.wav" -r 11025 -b 8 "$TMP/d.wav"
  $SOX "$TMP/d.wav" -r 48000 -b 16 "$TMP/e.wav" pitch -300 echo 0.8 0.85 7 0.45 13 0.3 19 0.2 gain -n -1
  $SOX "$TMP/e.wav" "$TMP/f.wav" fade t 0.004 0 0.04
  opusenc --quiet --bitrate 32 --vbr --comp 10 --framesize 20 --serial 1 --discard-comments "$TMP/f.wav" "$OUT/$name.opus"
done
( cd "$OUT" && sha256sum ./*.opus ) > tools/audio/SHA256SUMS
cp /opt/audio-packages.txt tools/audio/packages.txt
espeak-ng --voices=pt >> tools/audio/packages.txt
ls -l "$OUT"
