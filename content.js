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

  const LOG = '[Meet Caption Grabber]';

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
   * Returns { text, isContinuation }. When isContinuation is false the caller
   * should COMMIT the previous line and start a fresh buffer with `next`.
   * ------------------------------------------------------------------------ */
  function mergeGrowingText(prev, next) {
    if (!prev) return { text: next, isContinuation: true };
    if (next === prev) return { text: prev, isContinuation: true };
    if (next.startsWith(prev)) return { text: next, isContinuation: true };   // grew
    if (prev.startsWith(next)) return { text: prev, isContinuation: true };   // caret blip; keep longer
    // Sliding window: largest k where prev's suffix == next's prefix.
    const maxK = Math.min(prev.length, next.length);
    for (let k = maxK; k >= MIN_OVERLAP; k--) {
      if (prev.slice(prev.length - k) === next.slice(0, k)) {
        return { text: prev + next.slice(k), isContinuation: true };
      }
    }
    return { text: next, isContinuation: false };                             // new utterance
  }

  function commit(state) {
    const text = state.text.replace(/\s+/g, ' ').trim();
    if (text) committed.push({ speaker: state.speaker, text });
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
        commit(state);
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
        commit(prev);
        live.set(block, { speaker, text });
        continue;
      }
      const merged = mergeGrowingText(prev.text, text);
      if (merged.isContinuation) {
        prev.text = merged.text;            // keep growing the single buffer
      } else {
        commit(prev);                       // unrelated text reused this row
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

  function safeName(name) {
    const base = (name || '').trim() || 'meet-transcript';
    return base.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_') + '.txt';
  }

  function buildTranscript() {
    return serialize(cleanupLines(committed));
  }

  // Trigger a .txt download from the page context (no "downloads" permission).
  function downloadTranscript(name) {
    const content = buildTranscript();
    const blob = new Blob([content || '(no captions captured)'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName(name);
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
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
    return { ok: true };
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    running = false;
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

  /* --- popup <-> content messaging ---------------------------------------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'START':
        sendResponse(start());
        break;
      case 'STOP': {
        const res = stop();
        // Per spec: Stop flushes and triggers the download.
        downloadTranscript(msg.name);
        sendResponse(res);
        break;
      }
      case 'DOWNLOAD':
        flushLive();            // include anything still live, but keep capturing
        downloadTranscript(msg.name);
        sendResponse({ ok: true, lines: cleanupLines(committed).length });
        break;
      case 'STATUS':
        sendResponse(status());
        break;
      default:
        sendResponse({ ok: false, error: 'unknown-message' });
    }
    return true;              // keep the message channel open for the async response
  });

  console.log(LOG, 'content script loaded on', location.href);
})();
