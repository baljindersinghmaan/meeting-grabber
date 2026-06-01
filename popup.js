/* Meet Caption Grabber — popup controller.
 * Talks to content.js in the active Meet tab via chrome.tabs.sendMessage.
 * If the content script isn't there yet (e.g. tab opened before the extension
 * was installed), we inject it on demand with chrome.scripting and retry. */

const els = {
  name: document.getElementById('name'),
  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  download: document.getElementById('download'),
  status: document.getElementById('status'),
};

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

// Send a message; if no receiver, inject content.js once and retry.
async function send(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
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
    const res = await send(tab.id, { type: 'STOP', name: els.name.value });
    if (res && res.ok) {
      reflect(false);
      setStatus(`Stopped. Downloaded ${res.lines} line(s) of transcript.`, 'ok');
    } else {
      setStatus('Stop failed — was capture started?', 'warn');
    }
  })
);

els.download.addEventListener('click', () =>
  withTab(async (tab) => {
    const res = await send(tab.id, { type: 'DOWNLOAD', name: els.name.value });
    if (res && res.ok) {
      setStatus(`Downloaded ${res.lines} line(s) of transcript.`, 'ok');
    } else {
      setStatus('Nothing to download yet.', 'warn');
    }
  })
);

// On open, reflect current capture status so the buttons match reality even
// after the popup was closed and reopened mid-recording.
reflect(false);                          // safe default until we hear back
withTab(async (tab) => {
  const res = await send(tab.id, { type: 'STATUS' });
  if (!res || !res.ok) return;
  reflect(!!res.running);
  if (res.running) {
    setStatus(`Recording… ${res.lines} line(s) captured so far.`, 'ok');
  } else if (!res.hasCaptions) {
    setStatus('Captions appear to be OFF. Turn on captions (CC), then Start.', 'warn');
  } else {
    setStatus('Ready. Click Start to capture captions.');
  }
});
