# Shouts

The nine truco shouts of the table (TRUCO!, SEIS!, OITO!, NOVE!, DEZ!, DOZE!, DESCE!, CORRO!, ZAP!) are a synthetic voice made once from text, with effects that make it sound like a machine. The output is committed in `web/src/sfx/`; nothing here runs at build time or in the browser. The shouts stay in Portuguese in both languages, because they are truco words. Captions and announcements are translated.

## Files

* `shouts.txt`: one line per shout, `name|text|pitch|speed` (espeak-ng pitch from 0 to 99, speed in words per minute).
* `make-shouts.sh`: makes the nine files and `SHA256SUMS`, and writes `packages.txt`.
* `check-shouts.sh`: a listening aid. It decodes each file back to WAV and prints size, duration, peak and RMS level. It also writes, under `.cache/audio-check/`, the dry voice of each word, a spectrogram of each word (dry and processed) and `all-shouts.wav` with the nine shouts in a row.
* `SHA256SUMS`: the SHA-256 of each `.opus` file, checked by `web/test/sfx.test.ts`.
* `packages.txt`: the Debian package versions in the image and the Portuguese voices espeak-ng offers.

## How to run

The tools live in a local image (`docker/audio/Dockerfile`): espeak-ng, SoX and opus-tools from Debian bookworm on the same Node base image as the dev site. Building it is the only step that needs the network.

```sh
docker compose --profile audio build audio
docker compose --profile audio run --rm -T audio
docker compose --profile audio run --rm -T audio sh tools/audio/check-shouts.sh
```

The second command runs with no network (`network_mode: none`), one core and 512 MB. It takes under a second.

To change a word, edit only its pitch or speed in `shouts.txt`, run again, listen, and commit the new `.opus` files with `SHA256SUMS`. The test fails if a file changes without its sum.

## The chain

For each line of `shouts.txt`:

1. espeak-ng speaks the text with the Brazilian Portuguese voice and the `m3` variant (`-v pt-br+m3`, amplitude 190).
2. SoX trims the silence at both ends (22,050 Hz, mono, 16 bit).
3. Ring modulation: the voice is multiplied by a 42 Hz sine of the same length, then mixed 30% dry and 70% modulated, so the words stay clear.
4. Bit reduction: written as 8 bit at 11,025 Hz without dither.
5. Pitch down 300 cents and a short metallic echo (delays of 7, 13 and 19 ms), then normalized to 1 dB below full scale.
6. Fades of 4 ms in and 40 ms out.
7. opusenc at 32 kbit/s, variable bitrate, complexity 10, 20 ms frames.

The same image gives the same bytes: SoX runs with `-D` (no dither) and `-R` (repeatable), and opusenc gets a fixed stream serial (`--serial 1`). Running the script twice on 2026-11-22 gave identical `SHA256SUMS`.

Every opusenc flag above works with opus-tools 0.2, and the voice name `pt-br` is the one `espeak-ng --voices=pt` prints, so nothing had to be dropped.

## Measured output (2026-11-22)

Sizes of the committed files and levels of each file decoded back to 48 kHz by `check-shouts.sh`:

| Shout | Bytes | Duration (s) | Peak (dBFS) | RMS (dBFS) |
| --- | ---: | ---: | ---: | ---: |
| truco | 2,838 | 0.430 | -1.03 | -18.15 |
| seis | 2,829 | 0.418 | -0.00 | -17.86 |
| oito | 2,373 | 0.351 | -1.32 | -16.27 |
| nove | 2,536 | 0.362 | -0.52 | -17.76 |
| dez | 2,411 | 0.320 | -0.90 | -18.93 |
| doze | 2,439 | 0.327 | -0.72 | -17.95 |
| desce | 2,223 | 0.294 | -0.52 | -19.06 |
| corro | 2,770 | 0.404 | -1.10 | -18.76 |
| zap | 2,407 | 0.346 | -0.87 | -17.25 |

Total: 22,826 bytes for the nine files. The words are short (from 0.29 to 0.43 s), so each file is from 2.2 to 2.8 KB, below the first estimate of about 5 KB. The test allows at most 8,192 bytes per file and 65,536 for all nine.

The bit reduction removes everything above about 4.6 kHz after the pitch shift. On the spectrograms of truco, seis, desce and zap, the vowels and the bursts of k, p and d keep their shape; the s of "seis" and "desce" moves into a narrow band from 3.5 to 4.6 kHz. Listen to `all-shouts.wav` before changing anything.

## Image and licenses

Packages in the image (`packages.txt`): espeak-ng, espeak-ng-data and libespeak-ng1 1.51+dfsg-10+deb12u2; sox and libsox3 14.4.2+git20190427-3.5; opus-tools 0.2-1+b1; libopus0 1.3.1-3. The image is 383 MB, of which about 54 MB are these packages over the Node base.

* espeak-ng: GPL 3.0 or later. The license covers the program and its voice data, not the speech it produces, so the shouts are not under the GPL.
* SoX: GPL 2.0 or later, or LGPL 2.1 or later, as Debian's copyright file lists for its main sources.
* opus-tools: BSD 2-Clause, with a few source files under BSD 3-Clause, LGPL 2.0 or later, and GPL 2.0 for `opusinfo`, which is not used.
* libopus: BSD 3-Clause, with many source files under BSD 2-Clause.

None of these tools ships with the site. The nine shouts are content of this project and take the license of its other content, like the card art.
