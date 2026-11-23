# Credits

What Zap is made of besides its own code, and under which license each part comes. The project's code and model weights are under the MIT License ([`LICENSE`](LICENSE)); its card art, texts, data page, shouts and open data are under CC BY 4.0 ([`LICENSE-CONTENT`](LICENSE-CONTENT)). Versions and licenses below were read from the files in this repository and in the project's Docker images on 2026-11-23.

## Fonts

Both fonts are self-hosted: the browser never fetches anything from a font service. The files come from the Fontsource packages on the npm registry, which repackage the Google Fonts builds; only the two font files and their license texts were copied, and the packages are not dependencies of the project. Details and SHA-256 values: [`web/src/fonts/SOURCE.md`](web/src/fonts/SOURCE.md).

| Font | Author | Package | File | License |
| --- | --- | --- | --- | --- |
| Bricolage Grotesque | Mathieu Triay; Copyright 2022 The Bricolage Grotesque Project Authors ([github.com/ateliertriay/bricolage](https://github.com/ateliertriay/bricolage)) | `@fontsource-variable/bricolage-grotesque` 5.3.0 | `web/src/fonts/bricolage-grotesque-latin-full.woff2` | SIL Open Font License 1.1, served as [`web/public/fonts/OFL-bricolage-grotesque.txt`](web/public/fonts/OFL-bricolage-grotesque.txt) |
| Figtree | Erik Kennedy; Copyright 2022 The Figtree Project Authors ([github.com/erikdkennedy/figtree](https://github.com/erikdkennedy/figtree)) | `@fontsource-variable/figtree` 5.3.0 | `web/src/fonts/figtree-latin-wght.woff2` | SIL Open Font License 1.1, served as [`web/public/fonts/OFL-figtree.txt`](web/public/fonts/OFL-figtree.txt) |

## Sounds and voice shouts

No sound in Zap was recorded, and none comes from a sound library.

* **Card and table sounds** (dealing, playing a card, gathering a trick, shuffling, scoring, the turn cue and the tiles) are synthesized in the browser at play time by [`web/src/sound/synth.ts`](web/src/sound/synth.ts), from one shared noise buffer and sine oscillators of the Web Audio API. There are no audio files for them.
* **The nine shouts** (TRUCO!, SEIS!, OITO!, NOVE!, DEZ!, DOZE!, DESCE!, CORRO!, ZAP!) in [`web/src/sfx/`](web/src/sfx/) are a synthetic voice made once from text by [`tools/audio/make-shouts.sh`](tools/audio/make-shouts.sh), in the `audio` Compose service (Debian bookworm packages, run with no network). espeak-ng speaks each word with its Brazilian Portuguese voice (`pt-br`, variant `m3`); SoX adds ring modulation, bit reduction, a lower pitch and a short metallic echo; opusenc writes the Opus files. The chain and its measurements are in [`tools/audio/README.md`](tools/audio/README.md).

The tools that made the shouts, with the licenses of their Debian packages (`/usr/share/doc/<package>/copyright` in the `zap-audio` image):

| Tool | Debian package and version | License |
| --- | --- | --- |
| espeak-ng, with its voice data | `espeak-ng`, `espeak-ng-data`, `libespeak-ng1` 1.51+dfsg-10+deb12u2 | GPL 3.0 or later |
| SoX | `sox`, `libsox3` 14.4.2+git20190427-3.5 | GPL 2.0 or later, or LGPL 2.1 or later |
| opusenc and opusdec | `opus-tools` 0.2-1+b1 | BSD 2-Clause (a few source files BSD 3-Clause, LGPL 2.0 or later, and GPL 2.0 for `opusinfo`, which is not used) |
| Opus codec | `libopus0` 1.3.1-3 | BSD 3-Clause (many source files BSD 2-Clause) |

These licenses cover the programs and the voice data, not the sound they produce, and none of the tools ships with the site. The nine shout files are content of this project and carry its content license, CC BY 4.0, like the card art.

## Card art, avatars and images

* **The deck** is drawn by code as SVG in [`web/src/deck/`](web/src/deck/) (`Card.tsx`, `geometry.ts`, `tiles.tsx`): faces, suits, courts and backs built from shapes in the style of glazed tiles, made for this project. No card image comes from elsewhere.
* **The characters' avatars** ([`web/src/deck/avatars.tsx`](web/src/deck/avatars.tsx)) are small tile compositions, never faces, drawn the same way.
* **The social images** in [`web/public/og/`](web/public/og/) are screenshots of the project's own components, taken by [`tools/og/shoot.mjs`](tools/og/shoot.mjs) in the Playwright image.
* **The icon** [`web/public/favicon.svg`](web/public/favicon.svg), a white Z on a blue tile, is drawn for this project.

The drawings are under CC BY 4.0; the source files that draw them are code and are also available under the MIT License.

## Libraries in the site

Read from `node_modules/<package>/package.json`.

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| `preact` | 11.2.0 | MIT | the client's components and hooks |
| `d3-array` | 3.2.4 | ISC | chart ticks on the data page |
| `internmap` | 2.0.3 | ISC | a dependency of `d3-array` |
| `d3-shape` | 3.2.0 | ISC | chart lines and areas on the data page |
| `d3-path` | 3.1.1 | ISC | a dependency of `d3-shape` |
| `d3-scale` | 4.0.2 | ISC | listed in `package.json`; the site writes its own linear scale and does not import it |

The Worker and the rooms use no npm library at run time: they run the project's own engine and AI code on Cloudflare's runtime.

## Libraries of the training server

Read from the package metadata in the `zap-cycle` image (Python 3.12), which installs them offline from wheels checked against the SHA-256 values in [`training/requirements.lock`](training/requirements.lock) and [`training/cycle/requirements.lock`](training/cycle/requirements.lock).

| Package | Version | License |
| --- | --- | --- |
| PyTorch (`torch`, CPU build) | 2.15.0+cpu | as its wheel states: Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND ISC AND MIT AND Zlib |
| NumPy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| boto3, botocore | 1.44.9 | Apache-2.0 |
| s3transfer | 0.19.3 | Apache-2.0 |
| jmespath | 1.1.0 | MIT |
| python-dateutil | 2.9.0.post0 | Apache-2.0 or BSD-3-Clause |
| six | 1.17.0 | MIT |
| urllib3 | 2.8.0 | MIT |
| filelock | 4.2.12 | MIT |
| fsspec | 2026.9.0 | BSD-3-Clause |
| Jinja2 | 3.1.6 | BSD-3-Clause |
| MarkupSafe | 3.0.4 | BSD-3-Clause |
| mpmath | 1.3.0 | BSD |
| networkx | 3.7 | BSD-3-Clause |
| setuptools | 84.2.1 | MIT |
| sympy | 1.14.0 | BSD |
| typing_extensions | 4.16.0 | PSF-2.0 |

The self-play workers, the gate and the benches run in Node with the project's own code.

## Development tools

| Tool | Version | License |
| --- | --- | --- |
| TypeScript | 7.0.2 | Apache-2.0 |
| Vite | 8.3.6 | MIT |
| Vitest | 5.1.0 | MIT |
| Wrangler | 4.158.0 | MIT OR Apache-2.0 |
| workerd (the local Workers runtime, through Wrangler) | 1.20261104.1 | Apache-2.0 |
| Miniflare (through Wrangler) | 5.20261104.0-beta | MIT |
| `@cloudflare/workers-types` | 5.20261106.1 | MIT OR Apache-2.0 |
| Playwright (`@playwright/test` and the image `mcr.microsoft.com/playwright:v1.65.1-noble`) | 1.65.1 | Apache-2.0 |
| fast-check (property tests) | 4.10.2 | MIT |
| openskill (the oracle of the rating test) | 5.0.1 | MIT |
| `@types/node`, `@types/d3-array`, `@types/d3-scale`, `@types/d3-shape` | 24.19.2, 3.2.2, 4.0.9, 3.2.0 | MIT |
| Node.js (image `node:24-bookworm-slim`) | 24.22.2 | MIT |
| Python (image `python:3.12-slim`) | 3.12 | PSF-2.0 |
| Docker and Docker Compose | the host's | Apache-2.0 |

## Rules of truco

The defaults and room options were chosen from these sources ([`project_docs/rules.md`](project_docs/rules.md) says which rule comes from which):

* Regulamento de truco paulista, Universidade Federal da Fronteira Sul, 2024: [site-antigo-2025.uffs.edu.br](https://site-antigo-2025.uffs.edu.br/pastas-ocultas/bd/pro-reitoria-de-assuntos-estudantis/arquivos/regulamento-truco-paulista/@@download/file)
* Regulamento do torneio de truco, Sindicato dos Bancários de São Paulo, 2017: [spbancarios.com.br](https://spbancarios.com.br/sites/default/files/anexos/regulamento2017_1.pdf)
* Regulamento de truco, ASFO, Unesp ICT, 2019: [ict.unesp.br](https://www.ict.unesp.br/Home/sobreoict/fundacoeseassociacoes/asfo/regulamento-de-truco-2019.pdf)
* MegaJogos, truco paulista rules: [megajogos.com.br/truco-online/regras](https://www.megajogos.com.br/truco-online/regras)
* MegaJogos, truco mineiro rules: [megajogos.com.br/truco-mineiro-online/regras](https://www.megajogos.com.br/truco-mineiro-online/regras)
* Wikipédia (pt), Truco: [pt.wikipedia.org/wiki/Truco](https://pt.wikipedia.org/wiki/Truco)
* Pagat, Truco (Brazil): [pagat.com/put/truco_br.html](https://pagat.com/put/truco_br.html)

## Methods

The training method follows published work, cited in [`project_docs/ai.md`](project_docs/ai.md): PPO with a regularization towards a slowly moving anchor (magnetic mirror descent), which matched or beat other methods in recent work on imperfect-information games (Rudolph et al., ICLR 2026), and a critic that sees every card during training, as in PerfectDou. The closest earlier truco AI found was a Deep CFR bot for Argentine truco, 1 against 1 ([tomzvilla/truco-cfr](https://github.com/tomzvilla/truco-cfr)). No code from these works is in this repository.
