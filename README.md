# Meeting Caption Grabber

A minimal **Chrome extension (Manifest V3)** that captures **live captions** from
**Google Meet** and **Microsoft Teams (web)**, then **summarizes them via Groq's
free API** — downloading a Fireflies / Read.ai-style `<name>-summary.txt`. No
build step, no servers, no accounts beyond a free Groq key. Captions are
captured locally; only the cleaned transcript is sent to Groq for summarization.

---

## Features

- 🎙️ Captures live captions from **Google Meet** and **Teams web**.
- 🧠 Handles Meet/Teams' word-by-word in-place caption re-rendering — no
  duplicated lines.
- 🧹 Dedup + cleanup pass that merges consecutive lines from the same speaker.
- ✨ **Auto-summarizes on Stop** via Groq (`llama-3.3-70b-versatile`) — a
  structured plain-text `.txt` with overview, decisions, action items, next
  steps. You supply your own free Groq key.
- 🧱 **Map-reduce for long meetings** — chunks the transcript along speaker
  turns when the transcript exceeds Groq's per-minute rate limit budget.
- 💾 Optional: also save the raw `Speaker: text` `.txt` alongside the summary.
- 🔴 On-page recording badge with a live line counter.
- 🔐 Only **api.groq.com** is contacted for summarization — no analytics,
  no telemetry, no other endpoints. Your key lives only in `chrome.storage.local`.

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
3. **One-time:** open the extension popup, expand **⚙️ Settings**, paste a
   free Groq API key (get one at
   [console.groq.com/keys](https://console.groq.com/keys)). The key is stored
   in `chrome.storage.local` and is only sent to `api.groq.com`.
4. Type a **Transcript name** and click **Start**.
   - A 🔴 badge appears in the meeting page showing it's recording + a live count.
5. When done, click **Stop** — the extension sends the cleaned transcript to
   Groq and downloads `<name>-summary.txt`. If you checked **Also save raw
   transcript**, you'll also get `<name>.txt`. The mid-meeting **Download**
   button always gives you the raw `.txt` snapshot (no summarization).

The button states reflect reality: **Start** is disabled while recording,
**Stop/Download** are disabled while idle — even if you close and reopen the popup.

---

## Cloud summaries via Groq

Summaries are produced by Groq's hosted Llama 3.3 70B
(`llama-3.3-70b-versatile`) over their OpenAI-compatible chat-completions API.

### What you need

- A **free Groq API key** from
  [console.groq.com/keys](https://console.groq.com/keys). Free tier is generous
  (~30 req/min, ~30k tokens/min, daily caps that easily cover a few meetings
  per day).
- Modern Chrome (no on-device model required, no flag).

### What's sent and what stays local

| What | Where |
|------|-------|
| Live caption DOM scraping & dedup | Local (in the meeting tab) |
| Raw `Speaker: text` transcript | Local (only saved if "Also save raw" is on) |
| **Cleaned transcript** (`Speaker: text` lines) | Sent to `https://api.groq.com` for summarization |
| API key | Local, in `chrome.storage.local`. Sent on each request as a `Bearer` token. |

No analytics. No other network endpoints. The transcript is **not** retained
by Groq for training on their free tier — see Groq's privacy docs.

### What gets downloaded on Stop

| Toggle | Output |
|--------|--------|
| Default (off) | `<name>-summary.txt` only |
| **Also save raw transcript** (on) | `<name>-summary.txt` **and** `<name>.txt` |

### When summarization fails

The extension **always falls back to downloading the raw `<name>.txt`** so you
never lose your transcript. The popup status tells you why:

| Status | What to do |
|--------|------------|
| "No Groq API key — set one in Settings" | Paste your key into ⚙️ Settings. |
| "Invalid Groq API key" | Check for typos, regenerate at console.groq.com/keys. |
| "Groq rate limit hit — try again in a minute" | Wait ~60s and click Stop again. |
| "Couldn't reach Groq (network)" | Check your connection. |
| "Meeting too long…" | Use the raw `.txt` with a long-context model like Gemini. |

### Output format

Plain `.txt` (no markdown, no emoji, no tables) with these sections in order,
each on its own line in `UPPERCASE`:

```
OVERVIEW
PARTICIPANTS
KEY DISCUSSION POINTS
DECISIONS MADE
ACTION ITEMS
OPEN QUESTIONS / RISKS
NEXT STEPS
NOTABLE QUOTES (optional)
```

Bullets are `- ` prefixed. Action items follow `- Owner: Action (Due / Timeline)`.

If you'd rather have a richer markdown summary, the manual path still works
— pop the raw `.txt` and the prompt from [`SUMMARY_PROMPT.md`](SUMMARY_PROMPT.md)
into ChatGPT / Claude / Gemini.

### "Captions are OFF" message?
The extension detects when the caption container is missing and tells you to turn
on captions first, instead of failing silently. Turn on captions **before**
clicking Start.

---

## How it works

| File | Role |
|------|------|
| `manifest.json` | MV3 config. Permissions limited to `activeTab`, `scripting`, `storage`, host permissions for Meet/Teams, and `api.groq.com`. |
| `content.js` | Runs in the meeting page. Watches the caption DOM with a `MutationObserver`, finalizes lines, cleans up, calls the summarizer, and triggers the download. |
| `summarizer.js` | Groq client + summarization pipeline. Owns the prompts, token budgeting, and map-reduce. Calls Groq's OpenAI-compatible `/chat/completions` endpoint. |
| `popup.html` / `popup.js` | The toolbar UI (name field + Start/Stop/Download + raw-transcript toggle + API-key settings) that messages the content script. |

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
| `storage` | Remember the "Also save raw transcript" toggle and your Groq API key across popup opens. |
| `host_permissions` (meet.google.com, teams.microsoft.com, teams.live.com) | Read the caption DOM on supported meeting sites. |
| `host_permissions` (api.groq.com) | Send the cleaned transcript to Groq for summarization. |

The only network endpoint contacted is **`api.groq.com`** — and only when you
click Stop with an API key set. No analytics, no telemetry.

---

## Limitations

- The **Teams desktop app** can't be captured — use Teams in the browser.
- Capture depends on the meeting tab staying open while captions are visible.
- Caption accuracy is whatever Meet/Teams' speech-to-text produces.
- Teams selectors may need updating if Microsoft changes their DOM (see
  *Resilient selectors* above).
- Summaries require a free **Groq API key** — without one, you'll only get a
  raw `.txt`. The popup status will tell you.
- The Groq free tier has per-minute and per-day rate limits. If you stop two
  meetings back-to-back you may hit a 429; wait ~60s and click Stop again.
- For very long meetings (≫ 2 hours) you may exceed our map-reduce cap —
  the raw `.txt` + a paste into a larger cloud model (see
  [`SUMMARY_PROMPT.md`](SUMMARY_PROMPT.md)) is the right fallback.
