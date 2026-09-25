# Feishu / Lark Batch Export

> Feishu's built-in export handles one document at a time. This Chrome extension lets you check off a batch in the tree and get a single zip.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE) [![Chrome Web Store](https://img.shields.io/chrome-web-store/v/lomkhccnocgfifghblhfidifhnilcgdi)](https://chromewebstore.google.com/detail/lomkhccnocgfifghblhfidifhnilcgdi) [![365 Open Source Plan #032](https://img.shields.io/badge/365%20Open%20Source%20Plan-%23032-1f6feb)](https://github.com/rockbenben/365opensource)

[⬇ Install from the Chrome Web Store](https://chromewebstore.google.com/detail/lomkhccnocgfifghblhfidifhnilcgdi) · [简体中文](README.md)

<img src="assets/panel-en.png" width="380" align="right" alt="The panel: list a wiki, check documents, export">

Batch-exports from a **wiki**, **drive**, or a **URL list**, on both Feishu and Lark. Outputs Markdown / Word / PDF; multiple files are packed automatically with the folder structure preserved.

**Images are saved locally too.** In Feishu's exported Markdown, images are signed temporary URLs that expire in about 24 hours; without saving them, a backup is text-only within days.

Once installed, click the **Batch export** button in the bottom-right corner of any Feishu page and follow steps 1 → 2 → 3 in the panel.

<br clear="right">

## Install

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/lomkhccnocgfifghblhfidifhnilcgdi) and click **Add to Chrome**. **Reload any Feishu tab that was already open** — the extension is not injected into pages loaded before installation.

The UI follows your browser language (Chinese and English) and can be switched in the top-right of the panel.

The extension matches `*.feishu.cn` and `*.larksuite.com`, including region-prefixed subdomains such as `xxx.jp.larksuite.com`; both were tested and behave the same. Self-hosted domains (such as `*.larkoffice.com`) are untested. To add one, put an entry in both `matches` and `host_permissions` in `manifest.json` — no code change — and load it manually as described below.

### Manual install (developer mode)

For reading the code, changing the domains, or when the store is not an option. [Download the latest zip](https://github.com/rockbenben/feishu-lark-batch-export/releases/latest) and unzip it, or clone this repo. Then:

1. Open `chrome://extensions` and turn on **Developer mode** in the top right.
2. Click **Load unpacked** and pick the folder containing `manifest.json` (the unzipped folder, or `extension/` in the repo).
3. Open any Feishu page. A **Batch export** button appears in the bottom-right corner.

## Usage

The corner button is **draggable** and remembers its position. The toolbar icon also opens and closes the panel.

### 1. List the documents

Pick a source and click **List documents**. Opening the panel on a wiki document or folder page lists automatically, and the source follows the current page:

- **This wiki** — climbs from the current document to the space root and lists the whole tree. Needs a `/wiki/xxx` page.
- **This folder** — lists everything under the folder. Needs a `/drive/folder/xxx` page. **Use this for folders shared with you**: they are not under your own drive root, so **My drive** cannot see them.
- **My drive** — lists everything under your own drive root; works on any page. Pagination reads until the server returns the last page; a pagination error is reported outright rather than presenting a partial list as complete.
- **URL list (TXT)** — pick a `.txt` file with one link per line. Links must belong to the Feishu / Lark site currently open; wiki, new and legacy docs, sheets, bases, and file links are supported. Blank lines are ignored; duplicate links to the same document keep only the first, and query strings and fragments do not affect deduplication.

Notes on URL lists:

- Listing does not open each page. Plain documents are shown by ID first and get Feishu's real title after a successful export; wiki links need one API call each to convert the token, 0.4 s apart, so long lists take a while.
- Direct file links fetch the original filename first and fall back to the ID when it cannot be read.
- Links carry no modification time, so the **Recently edited** selector does not apply to TXT rows; check them manually.
- Entries that are missing, inaccessible, or malformed keep their link in the log and the rest continue; if every link fails, an explicit error is shown.

### 2. Check what to export

Checking a folder **checks everything under it**; **Alt-click** affects only that row. A dash in the box means the row itself is unchecked but something under it is checked — the dash itself never exports anything.

Types that cannot be exported (mindnotes) are disabled and cannot be checked.

**Recently edited** checks everything changed in the last 7 / 30 / 90 days, which suits incremental backups.

### 3. Pick a format and export

Multiple files are packed as `feishu-export-YYYY-MM-DD.zip`; a single file downloads directly, so Chrome never asks to allow multiple downloads. **Stop** mid-run aborts the active request; whatever finished is still packed.

Each download waits up to 120 seconds. Network errors and HTTP 408 / 429 / 5xx retry up to twice, one second apart (or per `Retry-After`, capped at 30 seconds); deterministic errors such as 401 / 403 / 404 are recorded as failures immediately. API calls wait up to 30 seconds each; export progress polling is not retried and has a 120-second overall deadline. A failure writes one log line with the source link.

The panel shows progress and a remaining-time estimate based on measured throughput. Hovering the log reveals a **Copy** button that stays visible whenever the log contains a failure, for reporting issues. **Start export** is pinned to the bottom of the panel; the middle section scrolls independently.

## Settings

Under **More settings**. The defaults aim to **mirror the wiki onto disk as faithfully as possible**.

| Setting | Default | Notes |
| --- | --- | --- |
| Save images too | **on** | Image links expire in about 24 hours; without this, images are gone within days |
| Keep folder structure | **on** | The hierarchy is real information in the wiki; flattening loses it and makes same-named docs in different folders collide into `(2)` |
| Save comments too | off | Most people only want the body; but discussion threads often hold conclusions the body lacks |
| Number filenames | off | Clean `Title.md` by default; turn on to preserve the wiki's ordering |
| Prefix parent folder | off | Redundant while folder structure is on; only needed for flat exports that need disambiguating |
| Add unique document ID to filename | **on** | Filenames look like `Title-doxcnAbC123.md` and match the image folder `assets/<id>/` directly |

Settings are remembered. Numbering restarts inside each folder when **Keep folder structure** is on; a flat export uses one global sequence.

**Saving images is independent of the format choice**: whenever a document's output is `.md`, its images are fetched into `assets/<doc id>/001.png` and the links rewritten to relative paths, so **Auto** gets images too. docx / pdf / xlsx already embed their images, so the switch has no effect on them. Image folders are keyed by document ID, not title or number: same-titled documents never share a folder, and re-exporting a document lands in the same folder. Each image times out after 15 seconds and retries up to twice, one second apart; on final failure one log line is written and the original link is kept.

## What it can export

| Type | Formats |
| --- | --- |
| Doc (new and legacy) | Markdown, Word, PDF |
| Sheet | xlsx |
| Base | xlsx |
| File attachment | downloaded as-is |
| **Mindnote** | **not supported**, see below |

If the chosen format is not available for a type (Markdown for a sheet, say), it falls back to that type's default format instead of failing.

### Why mindnotes are not supported

Feishu's page menu offers **Download as FreeMind (`.mm`)**, but **there is no server-side export endpoint** behind it. Measured evidence:

1. `/space/api/export/create/` recognises `type=mindnote` but rejects the extensions `mm` / `xmind` / `opml` / `txt` (1018, extension mismatch); any other type name returns 1004; standalone paths like `/space/api/mindnote/export/` are all 404.
2. Clicking **Download as → FreeMind** on the page fires only a permission check and telemetry — no export request at all.
3. Mindnote content arrives over the realtime collaboration WebSocket; there is no HTTP endpoint that returns it.

So the `.mm` file is serialised in the frontend from the in-memory document model, and there is no server-side capability for the extension to reuse. Supporting it would mean reimplementing Feishu's realtime protocol — a different project.

## Notes

- **Exports run serially, 1.5 s apart.** Export is a queued job on Feishu's side and concurrency invites rate limiting. Allow a few minutes for a few dozen documents. The interval is a conservative estimate — the real threshold was not measured — and is currently a code constant, not a setting.
- **Packing uses memory.** Everything is collected before zipping. Content is held as Blobs rather than in the JS heap, so batches of a few hundred MB are fine; there is no zip64, and exceeding ZIP32 limits (file count, size, offsets) reports an error instead of producing a corrupt archive. The zip uses STORE with no compression — docx / pdf / xlsx / png are already compressed.
- A failed document does not stop the queue; it gets one log line, and a **Retry N that failed** button appears afterwards.
- The extension only uses the session already in your browser to call Feishu's own web endpoints. **Nothing is uploaded and there is no server.** The background script only forwards toolbar clicks, reads locale files, and reads original filenames for direct file links. See [`PRIVACY.md`](PRIVACY.md).
- These are Feishu's internal endpoints, so a redesign can break them. Endpoint details and the measured type matrix are in [`docs/how-it-works.md`](docs/how-it-works.md) for comparison when fixing.

## Why an extension and not a userscript

Since Chrome 138, injecting user scripts needs the separate **userScripts** permission, which is off by default. With it off, Tampermonkey looks normal (script installed, matched, shown as running) but executes nothing and raises no error. An MV3 content script is core extension functionality and is unaffected.

## Development

```bash
node --test test.mjs
```

Tests evaluate `extension/content.js` source directly; there is no build step and no second copy of the logic to drift. They cover format mapping, URL-list parsing, export-result filename normalisation, filename sanitising and ID suffixes, log copying, image and download retries, collision handling, tree flattening, space-root discovery, the hand-written zip container, drive-node normalisation, and consistency of the two locale files (key sets, placeholder counts, every key referenced by code or manifest exists, no hardcoded Chinese in the UI, store fields within Chrome's length limits). The i18n tests were mutation-tested: a key was deleted and a placeholder dropped on purpose to confirm they go red.

```
extension/
├── manifest.json
├── content.js          # all the logic
├── background.js       # forwards toolbar clicks, reads locale files and attachment names
├── panel.css
├── _locales/{zh_CN,en}/messages.json
└── icons/icon-{16,32,48,128}.png
```

This folder is the release package: CI zips it as-is with nothing excluded. Design sources (icon, social card) live in `assets/`.

UI strings use Chrome's native `chrome.i18n`, so the extension name, description, and store listing are localised together. Adding a language is one more folder under `_locales/`; missing keys or mismatched placeholders fail the tests.

### Visual

The icon and social card are rendered from HTML sources; a design change means editing the source and re-running one command:

```bash
for n in 16 32 48 128; do
  node ~/.claude/skills/html-shot/render.mjs assets/icon.source.html \
    extension/icons/icon-$n.png --width $n --height $n --transparent
done
node ~/.claude/skills/html-shot/render.mjs assets/social-card.html assets/social-card.png --palette
```

| Aspect | Value |
| --- | --- |
| Palette | `#101C22` ink · `#1E3440` slate · `#E8A33D` amber · `#C97E1E` deep amber · `#F2EDE4` paper |
| Type | Noto Serif SC for display · Noto Sans SC for body · Sarasa Fixed SC (CJK monospace) for the tree |

The icon draws the panel itself: indented checkbox rows, parent outlined, children filled — "picking part of a tree". Amber is the single signal colour, used for the selected state and the 24-hour clock; Feishu's blue is deliberately absent. Monospace is used only where alignment matters (tree, filenames, numbers, log).

## About the 365 Open Source Plan

Project **#032** of the [365 Open Source Plan](https://github.com/rockbenben/365opensource) — one person + AI, 300+ open-source projects in a year.

[Submit your idea →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)
