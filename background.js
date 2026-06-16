/* Meet Caption Grabber — background service worker.
 *
 * Purpose: AUTO-DOWNLOAD ON TAB CLOSE.
 * When a meeting tab closes, its content script is destroyed and can no longer
 * trigger a download. So while recording, the content script periodically SYNCs
 * the latest transcript here; we stash it in chrome.storage.session keyed by
 * tab id. When chrome.tabs.onRemoved fires for that tab, we read the last
 * synced transcript and download it from here (outside the dying tab) via the
 * chrome.downloads API.
 *
 * storage.session is used (not local) so stashed transcripts are cleared when
 * the browser closes and never linger on disk.
 */

const key = (tabId) => `tab_${tabId}`;

// Content script -> background: keep the latest transcript per tab, or clear it.
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId || !msg) return;

  if (msg.type === 'SYNC') {
    chrome.storage.session.set({
      [key(tabId)]: {
        text: msg.text || '',
        name: msg.name || 'meet-transcript.txt',
        autoDownload: !!msg.autoDownload,
      },
    });
  } else if (msg.type === 'CLEAR') {
    // Sent on manual Stop (already downloaded) so we don't double-download on close.
    chrome.storage.session.remove(key(tabId));
  }
});

// Tab closed -> if we have a transcript and auto-download is on, download it.
chrome.tabs.onRemoved.addListener((tabId) => {
  const k = key(tabId);
  chrome.storage.session.get(k, (res) => {
    const entry = res[k];
    if (!entry) return;
    chrome.storage.session.remove(k);

    if (!entry.autoDownload) return;
    const text = (entry.text || '').trim();
    if (!text) return;

    // Build a data: URL — service workers can't use Blob URLs for downloads.
    const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    chrome.downloads.download({
      url,
      filename: entry.name || 'meet-transcript.txt',
      saveAs: false,
    });
  });
});
