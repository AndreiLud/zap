# Media: the README GIFs

`record-gif.ts` records `project_docs/media/zap-pt.gif` and `project_docs/media/zap-en.gif` from the real site running on your machine. Each GIF shows a quick play match of 1 against 1 against the AI: a card is played, the person calls truco (or raises a truco the AI called), the AI answers by raising the bet (its call fills the table in letter tiles), the person accepts, the hand ends and its points land on the score. It ends on the data page's first figure, the learning cycle.

The match is real. The deal comes from the server's random seed and the AI decides on its own, so every run gives other cards. The script plays up to 4 hands in each of up to 3 matches and keeps the first hand that fits these rules:

* the AI answered the person's truco (a raise back is preferred, since it shows the call on screen; a plain accept or run is kept only when no hand gives a raise);
* the hand did not end the match;
* the GIF lasts from 8 to 12 seconds.

## Steps

Start the local site first (`docker compose up -d dev`). It runs wrangler dev with the Turnstile test keys, so the human check passes by itself.

1. Frames. Playwright takes a screenshot of a 1280 by 800 page (desktop layout, light theme) 10 times a second and saves each one with the time it was taken, in `.cache/media/<lang>/`.

   ```sh
   docker run --rm --network zap_default --user 1000:1000 -v $PWD:/app -w /app -e HOME=/app/.cache/home \
     mcr.microsoft.com/playwright:v1.65.1-noble node tools/media/record-gif.ts shoot --lang pt,en
   ```

   The browser reaches the site by the container's name, `http://zap-dev-1:8787`. The service name `dev` does not work in Chromium: `.dev` is on the browser's HSTS preload list, so it asks for `https://dev:8787`. Another address goes in `--base`.

2. GIF. ffmpeg turns the frame times into a steady 10 frames a second, scales the picture to 800 pixels wide, builds one palette for the whole clip and writes the GIF. The size and the length printed at the end are read back from the GIF file.

   ```sh
   docker run --rm --network none --user 1000:1000 -v $PWD:/app -w /app -e HOME=/app/.cache/home \
     --entrypoint node <image> tools/media/record-gif.ts encode --lang pt,en --facts <file>
   ```

   `<image>` is any image with ffmpeg 5 or newer and Node 22.18 or newer, for example `node:24-bookworm-slim` with Debian's `ffmpeg` package. The GIFs in `project_docs/media/` were encoded with ffmpeg 5.1.9 on Node 24.22.2. `--facts` is optional: it writes the bytes, seconds, frames, width and height of each GIF in the format that `tools/docs/facts-docs.ts` merges into `facts.json` under `docs`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--lang` | `pt,en` | Which GIFs. |
| `--base` | `http://zap-dev-1:8787` | The local site. Never a public one: the script plays real matches there. |
| `--viewport` | `1280x800` | The page size the frames are taken at. |
| `--fps` | `10` | Frames per second, when shooting and in the GIF. |
| `--width` | `800` | Width of the GIF in pixels. |
| `--colors` | `192` | Colors in the GIF's palette. |
| `--data-seconds` | `1` | Seconds of the data page at the end (more when the hand was short). |
| `--min-seconds`, `--max-seconds` | `8`, `12` | The length a GIF must have. |
| `--tries`, `--hands` | `3`, `4` | Matches to start, and hands to play in each. |
| `--max-bytes` | `3145728` | The largest GIF accepted (3 MB). |

`.cache/media/` holds the frames and the intermediate files; it is not committed.
