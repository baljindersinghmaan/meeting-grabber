# Meeting Caption Grabber

A minimal **Chrome extension (Manifest V3)** that captures **live captions** from
**Google Meet** and **Microsoft Teams (web)** and exports them as a named
`.txt` transcript. No build step, no servers, no accounts — plain JavaScript you
load unpacked. Everything runs locally in your browser; captions never leave your
machine.

---

## Features

- 🎙️ Captures live captions from **Google Meet** and **Teams web**.
- 🧠 Handles Meet/Teams' word-by-word in-place caption re-rendering — no
  duplicated lines.
- 🧹 Dedup + cleanup pass that merges consecutive lines from the same speaker.
- 💾 One-click download as `Speaker: text` plain text.
- 🔴 On-page recording badge with a live line counter.
- 🛡️ 100% local — no network calls, no analytics, no remote code.

---

## Install (load unpacked in Chrome)

Chrome doesn't list this extension in the Web Store — you load it directly from
this folder using **Developer mode**. It's a one-time setup, takes ~30 seconds.

1. **Get the code on your machine.** Either:
   - Click **Code → Download ZIP** on the repo page and unzip it, **or**
   - Clone it: `git clone <repo-url>`

   Note the folder location (e.g. `C:\R And Projects\meeting-grabber`). The
   folder must contain `manifest.json` directly inside it.

2. **Open the extensions page.** In Chrome, paste this into the address bar and
   press Enter:
   ```
   chrome://extensions
   ```

3. **Enable Developer mode.** Flip the **Developer mode** toggle in the
   **top-right corner** of the page to **ON**. Three new buttons appear on the
   top-left: **Load unpacked**, **Pack extension**, **Update**.

4. **Load the extension.** Click **Load unpacked**. In the folder picker,
   navigate to the project folder from step 1 (the one containing
   `manifest.json`) and click **Select Folder**.
   > Pick the folder *itself* — do **not** open it and select files inside.

5. **Verify it loaded.** A card titled **Meeting Caption Grabber** should
   appear in the list with no red error banner. If you see an error, see
   [Troubleshooting install](#troubleshooting-install) below.

6. **Pin it to the toolbar (recommended).** Click the **🧩 puzzle-piece** icon
   in the Chrome toolbar, find **Meeting Caption Grabber**, and click the
   **📌 pin** icon next to it. The extension icon now sits in your toolbar for
   one-click access.

### Troubleshooting install

- **"Manifest file is missing or unreadable"** — You selected the wrong folder.
  Pick the folder that has `manifest.json` directly inside it (not a parent
  folder, not a subfolder).
- **Nothing happens when I click the icon on a meeting page** — Reload the
  meeting tab once after installing. Chrome only injects the content script
  into tabs opened *after* the extension was loaded.
- **I changed code, nothing updated** — On `chrome://extensions`, click the
  **↻ reload** icon on the extension's card, then reload the meeting tab.

---

## How to use

1. Join a meeting in **Chrome**:
   - Google Meet: `https://meet.google.com/...`
   - Microsoft Teams: `https://teams.microsoft.com` (use *"Continue in this
     browser"* — the Teams **desktop app cannot be captured** by a browser
     extension).
2. **Turn on captions** in the meeting:
   - Meet: press `c` or **More options (⋮) → Turn on captions**.
   - Teams: **More (…) → Language and speech → Turn on live captions**.
3. Click the extension icon, type a **Transcript name**, and click **Start**.
   - A 🔴 badge appears in the meeting page showing it's recording + a live count.
4. When done, click **Stop** — the transcript downloads automatically as
   `<name>.txt`. You can also click **Download** any time mid-meeting for a snapshot.

The button states reflect reality: **Start** is disabled while recording,
**Stop/Download** are disabled while idle — even if you close and reopen the popup.

---

## Get a summary (Fireflies / Read.ai style)

The transcript is plain text, so any AI can summarize it:

1. Download your transcript `.txt` (Stop or Download).
2. Open [`SUMMARY_PROMPT.md`](SUMMARY_PROMPT.md) and copy the prompt block.
3. Paste it into ChatGPT, Claude, Gemini, or any AI chat.
4. Paste (or attach) your `.txt` right after the prompt and send.

You'll get a structured summary — overview, participants, key discussion points,
decisions, action items (with owners), open questions, and next steps. See
[`SUMMARY_PROMPT.md`](SUMMARY_PROMPT.md) for tips on long meetings and tone tweaks.

### "Captions are OFF" message?
The extension detects when the caption container is missing and tells you to turn
on captions first, instead of failing silently. Turn on captions **before**
clicking Start.

---

## How it works

| File | Role |
|------|------|
| `manifest.json` | MV3 config. Permissions limited to `activeTab`, `scripting`, and host permissions for Meet/Teams. |
| `content.js` | Runs in the meeting page. Watches the caption DOM with a `MutationObserver`, finalizes lines, cleans up, and triggers the download. |
| `popup.html` / `popup.js` | The toolbar UI (name field + Start/Stop/Download) that messages the content script. |

### In-place caption handling (the core trick)
Meet and Teams **re-render the same caption row in place** as a person keeps
talking — the row grows word-by-word and slides (old words drop off the top).
That fires a flood of mutation events for what is really **one** line.

Instead of appending on every mutation, `content.js` keeps **one in-progress
buffer per caption row element** and only **commits** a finalized line when:

- the row leaves the DOM (utterance ended / scrolled away), or
- the speaker on that row changes, or
- the text jumps to something unrelated (a new utterance reused the row), or
- you click **Stop** (all in-progress buffers are flushed).

A `mergeGrowingText()` helper detects pure growth and sliding-window overlap so
the full utterance is reconstructed without duplication. A final cleanup pass
removes repeats/fragments and merges consecutive same-speaker lines.

### Resilient selectors
Meet/Teams class names are obfuscated build hashes that change often. All
selectors live in a **single per-site config object at the top of `content.js`**
(`SITE_SELECTORS`), using durable **ARIA** / **`data-tid`** attributes as primary
selectors and class names only as fallbacks.

**If capture breaks after a vendor update:** open a call with captions on,
right-click a caption → **Inspect**, find the container / speaker / text nodes,
and update that site's block in `SITE_SELECTORS`. Keep durable selectors first.

---

## Permissions

| Permission | Why |
|------------|-----|
| `activeTab` + `scripting` | Inject the content script into the active meeting tab if it isn't already running. |
| `host_permissions` (meet.google.com, teams.microsoft.com, teams.live.com) | Read the caption DOM on supported meeting sites. |

No data is sent anywhere — the transcript is built and downloaded entirely in
the browser.

---

## Limitations

- The **Teams desktop app** can't be captured — use Teams in the browser.
- Capture depends on the meeting tab staying open while captions are visible.
- Caption accuracy is whatever Meet/Teams' speech-to-text produces.
- Teams selectors may need updating if Microsoft changes their DOM (see
  *Resilient selectors* above).
