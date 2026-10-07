# Contributing

Thanks for helping make Lector better.

## Setup

```bash
bun install
bun run build        # then load dist/ via chrome://extensions → Load unpacked
bun run typecheck
bun test
```

## Ground rules

- **Privacy is the product.** No analytics, no remote calls other than the Hugging Face model download, no broad host permissions. Anything that widens permissions needs a strong reason in the PR description.
- **No account, no server, zero setup** for the user.
- Keep the offscreen document's entry file tiny: it must register its message listener before any heavy import (see `src/offscreen/engine.ts`).
- Highlight offsets always refer to the *original* paragraph text. Speech cleanup (`src/shared/speech.ts`) happens per segment after chunking. Don't change that order.
- Pure logic goes in `src/shared/` with a test next to it.

## Before opening a PR

1. `bun run typecheck && bun test && bun run build` all pass.
2. If you touched playback, extraction or messaging, run `scripts/e2e.mjs` (header explains setup) or describe how you tested by hand.
3. Note what you could not verify. We would rather know.

## Releasing

1. Bump `version` in `static/manifest.json` (and `package.json`).
2. `bun run package` builds `release/lector-<version>.zip` (git-ignored).
3. Tag and publish a GitHub release with the zip attached twice: as `lector-<version>.zip` and as `lector.zip` (the README's download link points at `releases/latest/download/lector.zip`).
   ```bash
   V=0.3.0; cp release/lector-$V.zip release/lector.zip
   git tag v$V && git push origin v$V
   gh release create v$V release/lector-$V.zip release/lector.zip --title "Lector $V" --notes-file <notes>
   ```
4. Upload the same zip in the Chrome Web Store dashboard. Listing copy, permission justifications and images live in `docs/store/`.

## Reporting bugs

Please include the page URL (or a minimal HTML example), your Chrome version, whether you are on WebGPU or CPU (Settings in the popup shows this), and any errors from `chrome://extensions` → Lector → *service worker* / *offscreen.html* consoles.

## Architecture

[CLAUDE.md](CLAUDE.md) documents the architecture and the reasoning behind decisions. It is written for AI-assisted development but is the best human reference too.
