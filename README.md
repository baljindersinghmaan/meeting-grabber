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

## Install (load unpacked)

1. Download/clone this folder to your machine.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this project folder.
5. (Optional) Pin the extension via the puzzle-piece toolbar icon so the popup
   is one click away.

> After changing any file, click the **reload (↻)** icon on the extension card,
> then reload the meeting tab.

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
