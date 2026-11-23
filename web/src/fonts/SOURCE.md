# Fonts

Two variable fonts, self-hosted (nothing is fetched from a third party at runtime). Both come from
the Fontsource packages on the npm registry, which repackage the Google Fonts builds under the SIL
Open Font License 1.1. The license texts are served next to the site:
`web/public/fonts/OFL-bricolage-grotesque.txt` and `web/public/fonts/OFL-figtree.txt` (the
`LICENSE` file of each package, unchanged).

| Package | Version | Tarball size (bytes) | Tarball integrity |
| --- | --- | --- | --- |
| `@fontsource-variable/bricolage-grotesque` | 5.3.0 | 528590 | `sha512-TLi9Q4hJjS2UvoTMRSS2nHu6c4R56lAw60NR9QYtVRCHn0XtsFpiEhNffZ8Glsoxu6wEEwLKBP8lb94J52PNBA==` |
| `@fontsource-variable/figtree` | 5.3.0 | 68892 | `sha512-VRVodD7OiG7apQwE8/2fMjaqpY/a0qRJqL5HtYj8CKIVps+9amaFcdfKmDIf7iqYQx6iPLlArVXAfKeIZmVcNQ==` |

| File in this folder | Copied from (inside the package) | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `bricolage-grotesque-latin-full.woff2` | `files/bricolage-grotesque-latin-standard-normal.woff2` | 131548 | `a756882d8a7802ebd4663b4544a62ebedafc7227c1c159ab95eea61393af3f8e` |
| `figtree-latin-wght.woff2` | `files/figtree-latin-wght-normal.woff2` | 20156 | `4ba7d3d096695818fe0686be4f1e82c6b05134e18a22260336130335027462dd` |

* Bricolage Grotesque (Mathieu Triay), latin subset with every axis: opsz from 12 to 96, wght from
  200 to 800, wdth from 75 to 100. Fontsource 5.3.0 names the file with all axes
  `latin-standard-normal`; it is byte for byte the file the approved prototype used
  (`_local/prototipos/azulejo-v2/fonts/bricolage-grotesque-latin.woff2`, same SHA-256). The
  project keeps the name `latin-full` from the specification.
* Figtree (Erik Kennedy), latin subset, wght from 300 to 900. No italic is used. Also identical to
  the prototype file.
* Neither font has U+2713 (check mark), so check marks are drawn as SVG.

`web/test/fonts.test.ts` reads both files (WOFF2 table directory, `fvar`, `cmap`) and checks the
axes, the Portuguese letters and the SHA-256 values above.

How they were fetched (2026-11-22, inside the project):

```sh
docker compose run --rm -T node npm view @fontsource-variable/bricolage-grotesque version   # 5.3.0
docker compose run --rm -T node npm view @fontsource-variable/figtree version               # 5.3.0
mkdir -p .cache/fonts
docker compose run --rm -T node npm pack @fontsource-variable/bricolage-grotesque@5.3.0 @fontsource-variable/figtree@5.3.0 --pack-destination .cache/fonts --json > .cache/fonts/pack.json
```

The packages are not dependencies of the project; only these two files and the two license texts
were copied.
