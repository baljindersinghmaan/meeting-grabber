/* =============================================================================
 * Meet Caption Grabber — content script
 * Runs on https://meet.google.com/* and captures live captions.
 *
 * HOW MEET RENDERS CAPTIONS (and why this code is shaped the way it is):
 *   Meet shows a small scrolling "Captions" region. While a person is talking,
 *   Meet RE-RENDERS THE SAME caption row in place, growing it word-by-word.
 *   That fires a flood of MutationObserver events for what is really ONE line.
 *   It also slides a window (old words fall off the top as new ones arrive).
 *
 *   So we must NOT append text on every mutation. Instead we keep ONE
 *   "in-progress" buffer per live caption row (keyed by the row's DOM element)
 *   and only COMMIT a finalized line when:
 *     - the row leaves the DOM (utterance ended / scrolled away), OR
 *     - the speaker for that row changes, OR
 *     - the text jumps to something unrelated (a new utterance reused the row), OR
 *     - the user clicks Stop (we flush every remaining in-progress buffer).
 *   See processCaptions() and mergeGrowingText() for the in-place handling.
 * ========================================================================== */

(() => {
  // Guard against double-injection (manifest auto-inject + scripting fallback).
  if (window.__meetCaptionGrabberLoaded) return;
  window.__meetCaptionGrabberLoaded = true;

  /* ===========================================================================
   * SELECTORS — THE ONE PLACE TO UPDATE WHEN GOOGLE / MICROSOFT BREAK THINGS.
   *
   * Both Meet and Teams use obfuscated build-hash class names that change
   * often. Each entry below is a PRIORITY LIST tried in order: durable
   * ARIA / data-tid / semantic selectors first, brittle class hashes last.
   *
   * Config is PER-SITE, picked by hostname (see pickSelectors()). To fix a
   * broken site after a vendor update:
   *   1. Open a call there, turn on captions (CC / live captions).
   *   2. Right-click a caption -> Inspect.
   *   3. Find the container, the per-speaker row, the name node, the text node.
   *   4. Add/replace selectors in that site's block below. Keep durable ones FIRST.
   *
   * NOTE on Teams: `data-tid="..."` attributes are Microsoft's semantic test
   * hooks and are far more stable than class hashes — prefer them.
   * ======================================================================== */
  const SITE_SELECTORS = {
    // ---- Google Meet (meet.google.com) -----------------------------------
    meet: {
      captionsContainer: [
        'div[aria-label="Captions"]',     // PRIMARY — durable ARIA label
        'div[aria-label="Live captions"]',
        'div[role="region"][aria-label*="aption" i]',
        '.a4cQT',                          // class-hash fallback — UPDATE HERE
      ],
      captionBlock: [
        '[data-message-text]',
        '.nMcdL',                          // class-hash fallback — UPDATE HERE
        '.TBMuR',                          // class-hash fallback — UPDATE HERE
      ],
      speakerName: [
        '.NWpY1d',                         // class-hash fallback — UPDATE HERE
        '.zs7s8d',                         // class-hash fallback — UPDATE HERE
        '.KcIKye',                         // class-hash fallback — UPDATE HERE
      ],
      captionText: [
        '.bh44bd',                         // class-hash fallback — UPDATE HERE
        '.VbkSUe',                         // class-hash fallback — UPDATE HERE
        '.iTTPOb',                         // class-hash fallback — UPDATE HERE
      ],
    },

    // ---- Microsoft Teams web (teams.microsoft.com / teams.live.com) ------
    // data-tid hooks are primary; class names are fallbacks. Teams shows a
    // sliding window of the last few caption rows, one row per speaker turn.
    teams: {
      captionsContainer: [
        '[data-tid="closed-caption-v2-window-wrapper"]',  // PRIMARY — data-tid
        '[data-tid="closed-captions-renderer"]',
        '[aria-label*="aptions" i]',
        '.ui-chat',                        // class fallback — UPDATE HERE
      ],
      captionBlock: [
        '[data-tid="closed-caption-message-content-root"]',
        '.ui-chat__item',                  // class fallback — UPDATE HERE
        '.fui-ChatMessageCompact',         // class fallback — UPDATE HERE
      ],
      speakerName: [
        '[data-tid="author"]',             // PRIMARY — data-tid
        '.ui-chat__message__author',       // class fallback — UPDATE HERE
        '.fui-ChatMessageCompact__author', // class fallback — UPDATE HERE
      ],
      captionText: [
        '[data-tid="closed-caption-text"]',// PRIMARY — data-tid
        '.ui-chat__message__content',      // class fallback — UPDATE HERE
        '.fui-ChatMessageCompact__body',   // class fallback — UPDATE HERE
      ],
    },
  };

  // Choose the selector set for whatever site we're running on.
  function pickSelectors() {
    const h = location.hostname;
    if (h.includes('teams.microsoft.com') || h.includes('teams.live.com')) return SITE_SELECTORS.teams;
    return SITE_SELECTORS.meet;          // default: Google Meet
  }
  const SELECTORS = pickSelectors();

  // Minimum overlap (chars) before we treat two snapshots as the same growing
  // utterance vs. a brand-new one. Tune if you see merges/splits go wrong.
  const MIN_OVERLAP = 5;

  /* --- runtime state ------------------------------------------------------ */
  let observer = null;
  let running = false;
  let committed = [];                    // finalized lines: {speaker, text}
  // live in-progress buffers, keyed by the row's DOM element so re-renders of
  // the SAME element update one buffer instead of creating duplicates.
  let live = new Map();                  // Map<Element, {speaker, text}>
  let sessionName = '';                  // filename base chosen when capture starts
  let syncTimer = null;                  // pushes transcript to background for auto-download
  let autoStartTimer = null;             // waits for captions to appear (auto-start)
  let autoStartDone = false;             // only auto-start once per page load

  const LOG = '[Meet Caption Grabber]';

  /* --- settings (persisted in storage.local, shared with the popup) -------- *
   * autoStart: begin capturing automatically once captions appear.
   * autoDownloadOnClose: save the RAW transcript if the meeting tab is closed
   *   without clicking Stop (summarizing needs the live tab, so close = raw).
   * transcriptName: preferred filename base (optional).
   * ------------------------------------------------------------------------ */
  let settings = { autoStart: false, autoDownloadOnClose: false, transcriptName: '' };
  function loadSettings(cb) {
    chrome.storage.local.get(
      ['autoStart', 'autoDownloadOnClose', 'transcriptName'],
      (s) => { settings = Object.assign(settings, s); if (cb) cb(); }
    );
  }
  // Stay in sync if the user flips a toggle in the popup while a call is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const k in changes) if (k in settings) settings[k] = changes[k].newValue;
  });

  /* --- on-page indicator -------------------------------------------------- *
   * A floating badge so you can SEE that capture is live without opening the
   * popup (the popup closes as soon as you click back into Meet). Shows the
   * running state and a live count of captured lines, or an error.
   * ------------------------------------------------------------------------ */
  let indicatorEl = null;
  function ensureIndicator() {
    if (indicatorEl && document.body.contains(indicatorEl)) return indicatorEl;
    indicatorEl = document.createElement('div');
    indicatorEl.id = 'mcg-indicator';
    Object.assign(indicatorEl.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '2147483647',          // above Meet's UI
      padding: '8px 12px',
      borderRadius: '8px',
      font: '13px system-ui, sans-serif',
      color: '#fff',
      background: 'rgba(20,20,20,0.92)',
      boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
      pointerEvents: 'none',          // never blocks clicks on Meet
      transition: 'opacity 0.3s',
    });
    document.body.appendChild(indicatorEl);
    return indicatorEl;
  }
  function setIndicator(kind, text) {
    const el = ensureIndicator();
    const dot = kind === 'recording' ? '🔴' : kind === 'error' ? '⚠️' : '⚪';
    el.textContent = `${dot} ${text}`;
    el.style.opacity = '1';
  }
  function hideIndicatorLater() {
    if (indicatorEl) setTimeout(() => { if (indicatorEl) indicatorEl.style.opacity = '0'; }, 4000);
  }

  /* --- DOM helpers (selector-list aware) ---------------------------------- */
  function queryFirst(root, selectorList) {
    for (const sel of selectorList) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) { /* invalid selector after an update — skip */ }
    }
    return null;
  }

  function getContainer() {
    return queryFirst(document, SELECTORS.captionsContainer);
  }

  function getBlocks(container) {
    for (const sel of SELECTORS.captionBlock) {
      try {
        const els = container.querySelectorAll(sel);
        if (els.length) return Array.from(els);
      } catch (_) { /* skip bad selector */ }
    }
    // Structural fallback: each non-empty direct child row.
    return Array.from(container.children).filter((c) => c.textContent.trim());
  }

  function getSpeaker(block) {
    const el = queryFirst(block, SELECTORS.speakerName);
    if (el && el.textContent.trim()) return el.textContent.trim();
    return 'Unknown';
  }

  function getText(block) {
    const el = queryFirst(block, SELECTORS.captionText);
    if (el) return el.textContent.replace(/\s+/g, ' ').trim();
    // Fallback: whole-block text minus the speaker name prefix.
    const speaker = getSpeaker(block);
    let t = block.textContent.replace(/\s+/g, ' ').trim();
    if (speaker !== 'Unknown' && t.startsWith(speaker)) t = t.slice(speaker.length).trim();
    return t;
  }

  /* --- in-place-update core ----------------------------------------------- *
   * Merge a previous snapshot of a row with the latest snapshot.
   * Handles three cases Meet produces:
   *   - pure growth:      "hi there"  ->  "hi there friend"
   *   - sliding window:   "hi there friend"  ->  "there friend how"  (overlap)
   *   - new utterance:    unrelated text reused the same row element
   *
   * IMPORTANT: comparisons use NORMALIZED text (lowercase, no punctuation)
   * because Meet rewrites "Want." -> "want for" -> "Want for that." between
   * snapshots — exact-string matching would treat each tick as a new utterance
   * and we'd end up with hundreds of growing duplicates in the transcript.
   * Output text always keeps the latest casing/punctuation.
   *
   * Returns { text, isContinuation }. When isContinuation is false the caller
   * should COMMIT the previous line and start a fresh buffer with `next`.
   * ------------------------------------------------------------------------ */
  function normText(s) {
    return String(s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  function mergeGrowingText(prev, next) {
    if (!prev) return { text: next, isContinuation: true };
    if (next === prev) return { text: prev, isContinuation: true };

    const np = normText(prev);
    const nn = normText(next);

    // Same normalized text (only case/punct changed) -> keep the longer/newer.
    if (np === nn) {
      return { text: next.length >= prev.length ? next : prev, isContinuation: true };
    }
    if (nn.startsWith(np)) return { text: next, isContinuation: true };   // grew
    if (np.startsWith(nn)) return { text: prev, isContinuation: true };   // caret blip; keep longer

    // Sliding window: largest k where normalized prev's suffix == next's prefix.
    // When found, prefer `next` as the merged text (most-recent state). We
    // don't try to splice the original (non-normalized) strings — offsets
    // wouldn't line up after punctuation differences, and `next` already
    // contains the latest growth.
    const maxK = Math.min(np.length, nn.length);
    for (let k = maxK; k >= MIN_OVERLAP; k--) {
      if (np.slice(np.length - k) === nn.slice(0, k)) {
        return { text: next, isContinuation: true };
      }
    }
    return { text: next, isContinuation: false };                          // new utterance
  }

  function commit(state, source) {
    const text = state.text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const tag = source ? `[${source}]` : '';
    console.log(LOG, `commit${tag}: ${state.speaker} | ${text.length > 100 ? text.slice(0, 100) + '…' : text}`);
    committed.push({ speaker: state.speaker, text });
  }

  // The MutationObserver callback. Reconciles the live Map against the DOM.
  function processCaptions() {
    const container = getContainer();
    if (!container) return;

    const blocks = getBlocks(container);
    const present = new Set(blocks);

    // 1) Rows that vanished since last tick are finished -> commit + drop.
    for (const [el, state] of live) {
      if (!present.has(el)) {
        commit(state, 'row-gone');
        live.delete(el);
      }
    }

    // 2) Walk current rows; update buffers in place (no per-mutation append).
    for (const block of blocks) {
      const speaker = getSpeaker(block);
      const text = getText(block);
      if (!text) continue;

      const prev = live.get(block);
      if (!prev) {
        live.set(block, { speaker, text });
        continue;
      }
      if (speaker !== prev.speaker) {
        // Same element now shows a different speaker -> previous line is done.
        commit(prev, 'speaker-change');
        live.set(block, { speaker, text });
        continue;
      }
      const merged = mergeGrowingText(prev.text, text);
      if (merged.isContinuation) {
        prev.text = merged.text;            // keep growing the single buffer
      } else {
        commit(prev, 'new-utterance');      // unrelated text reused this row
        live.set(block, { speaker, text });
      }
    }

    if (running) setIndicator('recording', `Recording captions — ${committed.length + live.size} line(s)`);
  }

  /* --- finalize / cleanup / serialize / download -------------------------- */

  // Flush every still-live buffer (called on Stop).
  function flushLive() {
    for (const [, state] of live) commit(state);
    live.clear();
  }

  // Dedup/cleanup pass before download:
  //   - normalize whitespace, drop empties
  //   - merge consecutive lines from the same speaker (incl. sliding-window overlap)
  //   - drop exact repeats and fragments already contained in the previous line
  function cleanupLines(lines) {
    const out = [];
    for (const ln of lines) {
      const speaker = (ln.speaker || 'Unknown').trim();
      const text = (ln.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;

      const last = out[out.length - 1];
      if (last && last.speaker === speaker) {
        if (last.text === text) continue;              // exact repeat
        if (last.text.includes(text)) continue;        // fragment already captured
        if (text.includes(last.text)) { last.text = text; continue; } // superset
        const m = mergeGrowingText(last.text, text);
        if (m.isContinuation) { last.text = m.text; continue; }
        // genuinely new sentence from same speaker -> append under same speaker
        last.text = (last.text + ' ' + text).replace(/\s+/g, ' ').trim();
        continue;
      }
      out.push({ speaker, text });
    }
    return out;
  }

  function serialize(lines) {
    return lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
  }

  // Build a safe filename. `suffix` includes the extension (e.g. ".txt",
  // "-summary.txt") so callers can produce sibling files with one helper.
  function safeName(name, suffix) {
    const base = (name || '').trim() || 'meet-transcript';
    return base.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_') + (suffix || '.txt');
  }

  function buildTranscript() {
    return serialize(cleanupLines(committed));
  }

  // Like buildTranscript() but ALSO includes still-in-progress live buffers,
  // without mutating state. Used by the auto-download-on-close sync so an
  // abrupt tab close still saves the last few spoken lines.
  function buildTranscriptIncludingLive() {
    const liveLines = Array.from(live.values()).map((s) => ({ speaker: s.speaker, text: s.text }));
    return serialize(cleanupLines(committed.concat(liveLines)));
  }

  // Default filename base when the user hasn't typed one (site + date/time).
  function defaultName() {
    const site = location.hostname.includes('teams') ? 'teams' : 'meet';
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${site}-transcript-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  /* --- background sync (powers auto-download on tab close) ----------------- *
   * While recording, push the latest RAW transcript to the background worker
   * every few seconds so it can save it if the tab is closed. See background.js.
   * ------------------------------------------------------------------------ */
  function syncToBackground() {
    try {
      chrome.runtime.sendMessage({
        type: 'SYNC',
        text: buildTranscriptIncludingLive(),
        name: safeName(sessionName || settings.transcriptName, '.txt'),
        autoDownload: !!settings.autoDownloadOnClose,
      }).catch(() => {});
    } catch (_) { /* background asleep; next tick retries */ }
  }
  function startSyncLoop() {
    stopSyncLoop();
    syncToBackground();
    syncTimer = setInterval(syncToBackground, 2500);
  }
  function stopSyncLoop() {
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  }
  function clearBackground() {
    try { chrome.runtime.sendMessage({ type: 'CLEAR' }).catch(() => {}); } catch (_) {}
  }

  // Trigger a download from the page context (no "downloads" permission).
  function downloadFile(content, name, suffix, mime) {
    const blob = new Blob([content || ''], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName(name, suffix);
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // Mid-meeting raw .txt snapshot (Download button). Never summarizes — that's
  // a Stop-only action so we don't burn the model on partial transcripts.
  function downloadTranscriptSnapshot(name) {
    const content = buildTranscript();
    downloadFile(content || '(no captions captured)', name, '.txt', 'text/plain');
    return content;
  }

  /* --- start / stop ------------------------------------------------------- */
  function start() {
    const container = getContainer();
    if (!container) {
      // Captions aren't on (no container). Tell the user clearly — don't fail silently.
      console.warn(LOG, 'Start failed: captions container not found. Turn on captions (CC).');
      setIndicator('error', 'Captions are OFF — turn on CC, then Start');
      return { ok: false, error: 'no-captions' };
    }
    console.log(LOG, 'Start: captions container found, observing.', container);
    committed = [];
    live = new Map();
    // Lock in a filename for this session (user-typed name, else date-stamped).
    sessionName = (settings.transcriptName || '').trim() || defaultName();
    if (observer) observer.disconnect();
    observer = new MutationObserver(processCaptions);
    // Watch the whole container subtree: characterData catches word-by-word edits.
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    running = true;
    setIndicator('recording', 'Recording captions — 0 line(s)');
    processCaptions();          // capture whatever is already on screen
    startSyncLoop();            // keep background updated for auto-download-on-close
    return { ok: true };
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    running = false;
    stopSyncLoop();
    flushLive();                // commit any in-progress lines
    const lines = cleanupLines(committed).length;
    console.log(LOG, `Stopped. ${lines} line(s) captured.`);
    setIndicator('idle', `Stopped — ${lines} line(s) captured`);
    hideIndicatorLater();
    return { ok: true, lines };
  }

  function status() {
    return {
      ok: true,
      running,
      hasCaptions: !!getContainer(),
      lines: cleanupLines(committed).length,
    };
  }

  // Best-effort progress broadcast to the popup. If the popup is closed the
  // send rejects — we swallow it; the popup polls STATUS when it reopens.
  function emitProgress(payload) {
    try {
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch (_) { /* no receivers; ignore */ }
  }

  // Stop + summarize + download pipeline. Returns the payload the popup expects.
  async function stopAndDeliver(name, saveRaw, apiKey) {
    stop();                                       // commits in-progress buffers
    const lines = cleanupLines(committed);
    console.log(LOG, `stopAndDeliver: ${lines.length} clean line(s), saveRaw=${!!saveRaw}, hasKey=${!!apiKey}`);

    if (lines.length === 0) {
      console.log(LOG, 'no lines captured — nothing to download');
      setIndicator('idle', 'Stopped — no captions captured');
      hideIndicatorLater();
      return { ok: true, lines: 0, summary: false, raw: false, reason: 'empty' };
    }

    const transcript = serialize(lines);

    // No summarizer module loaded → raw .txt fallback. Usually means the tab
    // has an OLD content script (extension was reloaded but the tab wasn't).
    if (!window.__meetCaptionSummarizer) {
      console.warn(LOG, 'summarizer module missing on window — falling back to raw .txt. (Reload the meeting tab if you just updated the extension.)');
      downloadFile(transcript, name, '.txt', 'text/plain');
      setIndicator('idle', `Stopped — saved raw transcript (${lines.length} line(s))`);
      hideIndicatorLater();
      return { ok: true, lines: lines.length, summary: false, raw: true, reason: 'no-summarizer' };
    }

    console.log(LOG, 'summarizer module present — invoking Groq');
    setIndicator('recording', 'Stopped — summarizing…');
    emitProgress({ type: 'SUMMARY_PROGRESS', stage: 'starting', done: 0, total: 1 });

    let result;
    try {
      result = await window.__meetCaptionSummarizer.summarize(lines, {
        apiKey,
        onProgress: (p) => emitProgress({ type: 'SUMMARY_PROGRESS', ...p }),
      });
    } catch (e) {
      console.warn(LOG, 'Summarizer threw (unexpected — summarize() should not throw):', e);
      result = { ok: false, reason: 'error', error: String(e && e.message || e) };
    }
    console.log(LOG, 'summarizer result:', result && { ok: result.ok, reason: result.reason, summaryLen: result.summary && result.summary.length });

    if (result && result.ok) {
      downloadFile(result.summary, name, '-summary.txt', 'text/plain');
      if (saveRaw) downloadFile(transcript, name, '.txt', 'text/plain');
      setIndicator('idle', `Stopped — summary saved (${lines.length} line(s))`);
      hideIndicatorLater();
      return {
        ok: true, lines: lines.length,
        summary: true, raw: !!saveRaw, reason: 'ok',
      };
    }

    // Summarization failed — fall back to raw .txt regardless of the toggle.
    downloadFile(transcript, name, '.txt', 'text/plain');
    setIndicator('idle', `Stopped — saved raw transcript (${lines.length} line(s))`);
    hideIndicatorLater();
    return {
      ok: true, lines: lines.length,
      summary: false, raw: true,
      reason: (result && result.reason) || 'error',
      error: result && result.error,
    };
  }

  /* --- popup <-> content messaging ---------------------------------------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'START':
        sendResponse(start());
        return false;                            // sync response
      case 'STOP':
        stopAndDeliver(msg.name || sessionName, !!msg.saveRaw, msg.apiKey || '')
          .then((res) => { clearBackground(); sendResponse(res); }); // delivered -> no close re-download
        return true;                             // async response
      case 'DOWNLOAD':
        flushLive();                             // include anything still live, but keep capturing
        downloadTranscriptSnapshot(msg.name || sessionName);
        sendResponse({ ok: true, lines: cleanupLines(committed).length });
        return false;
      case 'STATUS':
        sendResponse(status());
        return false;                            // sync now (no availability lookup)
      default:
        sendResponse({ ok: false, error: 'unknown-message' });
        return false;
    }
  });

  /* --- auto-start --------------------------------------------------------- *
   * When enabled, wait for the captions container to appear (i.e. the user
   * turned on CC) and start capturing automatically — once per page load.
   * ------------------------------------------------------------------------ */
  function maybeAutoStart() {
    if (autoStartDone || running || !settings.autoStart) return;
    if (getContainer()) {
      autoStartDone = true;
      console.log(LOG, 'Auto-start: captions detected, starting capture.');
      start();
    }
  }

  /* --- final sync on tab close/navigation --------------------------------- *
   * pagehide is the last reliable hook before teardown. Push the latest
   * transcript so the background worker has it when chrome.tabs.onRemoved fires.
   * ------------------------------------------------------------------------ */
  window.addEventListener('pagehide', () => {
    if (running) syncToBackground();
  });

  /* --- init --------------------------------------------------------------- */
  loadSettings(() => {
    // Poll for captions so auto-start works even if CC is turned on later.
    autoStartTimer = setInterval(maybeAutoStart, 2000);
    maybeAutoStart();
  });

  console.log(LOG, 'content script loaded on', location.href);
})();
