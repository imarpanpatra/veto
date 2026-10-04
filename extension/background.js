/* Service worker.
 *
 * Every call to the daemon goes through here, and that is the whole point.
 * A fetch made from a content script carries the PAGE's origin, which would
 * force the daemon to accept requests from whatever site you happen to be on.
 * A fetch made here carries chrome-extension://<id>, so the daemon can refuse
 * page origins outright and your rulebook stays unreadable by the web.
 */
const DAEMON = 'http://127.0.0.1:4777';

async function call(path, body) {
  const r = await fetch(DAEMON + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`daemon ${r.status}`);
  return r.json();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'judge') {
    call('/api/judge', msg.payload)
      .then((v) => sendResponse({ ok: true, v }))
      // The gate fails open. If the daemon is unreachable the content script
      // must let the message through, so an error is a result, not a throw.
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // keep the channel open for the async reply
  }

  if (msg?.type === 'outcome') {
    call(`/api/events/${encodeURIComponent(msg.eventId)}/outcome`, { outcome: msg.outcome })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});
