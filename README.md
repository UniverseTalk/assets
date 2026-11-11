# Universe Talk assets

The fixed images of the Universe Talk site. Every merge to `main` builds them and publishes them to `assets.universe.talk`.

## Add or replace an image

1. Put the file in `src-images/`. To replace an image, use the same file name as the old one (delete the old file if the new one has another ending, for example `card.svg` becomes `card.png`).
2. Open a pull request.

That is all. There is nothing else to edit.

- File types: PNG, JPG, WebP, or SVG. Use SVG for icons and line art only; export pictures as PNG or JPG.
- Size: export pictures as large as you have them, up to 1920 px wide. The smallest width accepted is 320 px (160 px for `card`).
- File name: letters, digits, `-` and `_`. The name without the ending is the name the site uses (`hero_bg.png` is `hero_bg`), so keep it when you replace an image.

The pull request shows a green check when the image is fine. A red cross means it is not: open the failed check and read the line that starts with `IMAGE PROBLEM`. It names the file and says what to change. The site shows a new or changed image after a developer updates uni-web (`pnpm assets:sync`).

## For developers

`npm ci`, then `npm test` and `npm run build` (output in `dist/`). Node 22 or later. The rules are in `scripts/pipeline.mjs`; the spec is UniverseTalk/ops#1, section A.3.

- **Paths.** `/<name>/<hash8>/<width>.<avif|webp>`; `hash8` is the first 8 hex characters of the SHA-256 of the source file. A vector SVG goes through SVGO to `/<name>/<hash8>.svg`. The bytes behind a URL must never change: after a change to quality or to the pipeline, check that this still holds.
- **Manifest.** `/manifest.json` is `{ "version": 1, "images": { "<name>": { "hash", "width", "height", "widths", "formats" } } }`. `width` and `height` are the size of the source in pixels. `formats` is `["avif", "webp"]`, or `["svg"]` with empty `widths`.
- **Widths.** Default 320, 480, 640, 960, 1280, 1920, cut off at the source width (the source width is then the top step). No output is wider than its source.
- **Quality.** AVIF 50, WebP 75 (`QUALITY` in `scripts/pipeline.mjs`).
- **Previous version.** The last committed version of each source that differs from the current one is built too, from git history, so the old URLs stay alive until that source changes again. The checkout needs full history (`fetch-depth: 0`).
- **`images.config.json`** (optional, per image name): `widths` replaces the default list; `allowSmallSource` accepts a source narrower than the smallest width.
- **SVG with a picture inside** (the Figma exports that are in `src-images/` today): the SVG is rendered, so its crop, round corners and opacity stay, at the real pixel size of the picture inside. This is why `mobile_hero_bg` is only 293 px wide and has `allowSmallSource`; remove that setting when real source art arrives.
