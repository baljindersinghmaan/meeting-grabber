/* Meet Caption Grabber — popup controller.
 * Talks to content.js in the active Meet/Teams tab via chrome.tabs.sendMessage.
 * If the content script isn't there yet (e.g. tab opened before the extension
 * was installed), we inject it on demand with chrome.scripting and retry.
 *
 * After Stop, content.js calls summarizer.js, which calls Groq's API with
 * the user's free key and downloads "<name>-summary.txt" (plain text). If
 * "Also save raw" is checked, we also write "<name>.txt". If summarization
 * fails for any reason, we fall back to a raw .txt download with a specific
 * status message.
 */

const els = {
  name: document.getElementById('name'),
  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  download: document.getElementById('download'),
  saveRaw: document.getElementById('saveRaw'),
  apiKey: document.getElementById('apiKey'),
  settings: document.getElementById('settings'),
  status: document.getElementById('status'),
};

const STORE_SAVE_RAW = 'saveRaw';
const STORE_API_KEY  = 'groqApiKey';

function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = cls || '';
}

// Reflect capture state in the buttons: Start disabled while recording,
// Stop/Download disabled while idle.
function reflect(running) {
  els.start.disabled = running;
  els.stop.disabled = !running;
  els.download.disabled = !running;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Supported meeting sites (must match manifest content_scripts matches).
function isSupported(tab) {
  return tab && tab.url &&
    /^https:\/\/(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com)\//.test(tab.url);
}

// Send a message; if no receiver, inject content scripts once and retry.
async function send(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    try {
      // Order matters: summarizer.js exposes its global before content.js needs it.
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['summarizer.js', 'content.js'],
      });
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      return { ok: false, error: 'no-content-script' };
    }
  }
}

async function withTab(action) {
  const tab = await getActiveTab();
  if (!isSupported(tab)) {
    setStatus('Open a Google Meet or Teams (web) call tab first.', 'warn');
    return null;
  }
  return action(tab);
}

/* --- settings persistence ---------------------------------------------- */
async function loadSettings() {
  try {
    const v = await chrome.storage.local.get([STORE_SAVE_RAW, STORE_API_KEY]);
    els.saveRaw.checked = !!v[STORE_SAVE_RAW];
    els.apiKey.value = v[STORE_API_KEY] || '';
    // Auto-open the settings panel if no API key is set yet.
    if (!els.apiKey.value) els.settings.open = true;
  } catch (_) {
    els.saveRaw.checked = false;
    els.apiKey.value = '';
  }
}

els.saveRaw.addEventListener('change', async () => {
  try { await chrome.storage.local.set({ [STORE_SAVE_RAW]: !!els.saveRaw.checked }); }
  catch (_) { /* ignore */ }
});

// Save API key on input change. Trim aggressively (people paste keys with
// trailing whitespace from copy/paste).
let apiKeySaveTimer = null;
els.apiKey.addEventListener('input', () => {
  clearTimeout(apiKeySaveTimer);
  apiKeySaveTimer = setTimeout(async () => {
    try {
      await chrome.storage.local.set({
        [STORE_API_KEY]: els.apiKey.value.trim(),
      });
    } catch (_) { /* ignore */ }
  }, 200);
});

/* --- live summary progress from content.js ----------------------------- */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'SUMMARY_PROGRESS') return;
  setStatus(renderProgress(msg), 'ok');
});

function renderProgress(p) {
  if (p.stage === 'starting')   return 'Calling Groq…';
  if (p.stage === 'summarize')  return 'Summarizing transcript…';
  if (p.stage === 'map')        return `Summarizing… ${p.done}/${p.total} chunks`;
  if (p.stage === 'reduce')     return 'Finalizing summary…';
  return 'Summarizing…';
}

/* --- buttons ----------------------------------------------------------- */

els.start.addEventListener('click', () =>
  withTab(async (tab) => {
    const res = await send(tab.id, { type: 'START' });
    if (res && res.ok) {
      reflect(true);
      setStatus('Recording captions… Keep this Meet tab open.', 'ok');
    } else if (res && res.error === 'no-captions') {
      setStatus('Captions are OFF. Turn on captions (CC) in Meet, then click Start.', 'warn');
    } else {
      setStatus('Could not start. Reload the Meet tab and try again.', 'warn');
    }
  })
);

els.stop.addEventListener('click', () =>
  withTab(async (tab) => {
    const apiKey = els.apiKey.value.trim();
    if (!apiKey) {
      setStatus('Set your Groq API key in ⚙️ Settings to enable summaries. Stopping anyway…', 'warn');
    } else {
      setStatus('Stopping…', 'ok');
    }
    const res = await send(tab.id, {
      type: 'STOP',
      name: els.name.value,
      saveRaw: !!els.saveRaw.checked,
      apiKey,
    });
    if (res && res.ok) {
      reflect(false);
      const isOldContentScript = res.lines > 0
        && res.summary === undefined
        && res.raw === undefined
        && res.reason === undefined;

      if (res.lines === 0) {
        setStatus('Stopped. No captions captured.', 'warn');
      } else if (isOldContentScript) {
        setStatus(
          'Saved raw .txt. The meeting tab is running an OLD content script — ' +
          'reload the meeting tab to enable AI summaries. ' +
          `(${res.lines} line(s).)`,
          'warn'
        );
      } else if (res.summary) {
        const extra = res.raw ? ' + raw .txt' : '';
        setStatus(`Saved summary.txt${extra}. (${res.lines} line(s) captured.)`, 'ok');
      } else {
        const why =
          res.reason === 'no-api-key'    ? 'No Groq API key — set one in ⚙️ Settings' :
          res.reason === 'unauthorized'  ? 'Invalid Groq API key — check ⚙️ Settings' :
          res.reason === 'rate-limit'    ? 'Groq rate limit hit — try again in a minute' :
          res.reason === 'server-error'  ? 'Groq API returned an error' :
          res.reason === 'network'       ? 'Couldn’t reach Groq (network)' :
          res.reason === 'too-long'      ? 'Meeting too long to summarize in one batch' :
          res.reason === 'no-summarizer' ? 'Summarizer not loaded — reload the meeting tab' :
          /* error / unknown */            'Couldn’t summarize';
        const detail = res.error ? ` (${res.error.slice(0, 120)})` : '';
        setStatus(`${why}${detail} — saved raw .txt. (${res.lines} line(s).)`, 'warn');
      }
    } else {
      setStatus('Stop failed — was capture started?', 'warn');
    }
  })
);

els.download.addEventListener('click', () =>
  withTab(async (tab) => {
    const res = await send(tab.id, { type: 'DOWNLOAD', name: els.name.value });
    if (res && res.ok) {
      setStatus(`Downloaded ${res.lines} line(s) of raw transcript.`, 'ok');
    } else {
      setStatus('Nothing to download yet.', 'warn');
    }
  })
);

/* --- initial reflect/status -------------------------------------------- */

reflect(false);
loadSettings();
withTab(async (tab) => {
  const res = await send(tab.id, { type: 'STATUS' });
  if (!res || !res.ok) return;
  reflect(!!res.running);

  const hint = els.apiKey.value.trim()
    ? ''
    : ' Set your Groq API key in ⚙️ Settings to enable summaries.';

  if (res.running) {
    setStatus(`Recording… ${res.lines} line(s) captured so far.`, 'ok');
  } else if (!res.hasCaptions) {
    setStatus('Captions appear to be OFF. Turn on captions (CC), then Start.' + hint, 'warn');
  } else {
    setStatus('Ready. Click Start to capture captions.' + hint);
  }
});
