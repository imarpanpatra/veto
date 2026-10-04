/* The Veto - generic send interceptor.
 *
 * Deliberately NOT built on per-site selectors. WhatsApp, X and Gmail rename
 * their DOM constantly; a gate that breaks silently is worse than no gate.
 * Instead we intercept the two universal gestures -- Enter in a composer, and
 * a click on something that looks like a commit button -- and let the model
 * decide. One code path, every site.
 */
const BYPASS = Symbol('veto-allowed');

let armed = true;
let busy = false;

const SEND_HINTS = /\b(send|post|reply|tweet|publish|submit|comment)\b/i;
const BUY_HINTS = /\b(buy now|place order|place your order|pay now|proceed to pay|complete purchase|checkout|confirm order)\b/i;

// Only real composers. A single-line <input> is a search box far more often
// than it is a message, and a Veto that interrupts every Google search is one
// you switch off within an hour.
function editableText(el) {
  if (!el) return null;
  if (el.tagName === 'TEXTAREA') return el.value;
  if (el.isContentEditable) return el.innerText;
  return null;
}

// Below this, there is nothing to regret. "ok", "yes", "on my way" should
// never cost a model round-trip or a moment of the person's attention.
const MIN_DRAFT = 15;

function composerFor(el) {
  let n = el;
  for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
    const t = editableText(n);
    if (t != null) return { node: n, text: t };
  }
  return null;
}

// Find the text a commit button is about to commit.
function draftNear(btn) {
  const scope = btn.closest('form, [role="dialog"], [data-testid], section, div');
  if (!scope) return '';
  const fields = scope.querySelectorAll('textarea, [contenteditable="true"]');
  for (const f of fields) {
    const t = editableText(f);
    if (t && t.trim()) return t;
  }
  return '';
}

function labelOf(el) {
  return [
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('data-testid'),
    el.getAttribute?.('title'),
    el.textContent?.slice(0, 80),
  ].filter(Boolean).join(' ');
}

/* All daemon traffic goes through the service worker.
 *
 * Not for tidiness: a fetch from here would carry this page's origin, which
 * would mean the daemon had to accept requests from any site you visit. Going
 * through the worker lets the daemon refuse page origins entirely.
 */
// 60s is deliberately SHORTER than the daemon's 90s model timeout. If a cold
// judgement really does take that long, giving up and letting the action
// through beats freezing the person's checkout button for a minute and a half.
// The daemon finishes anyway and caches the verdict, so the next attempt is
// instant rather than lost. Hover-precompute means this path is rarely cold.
function send(msg, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };

    // A promise that never settles leaves `busy` stuck true, and from then on
    // every keystroke is swallowed by a gate that will never open: the exact
    // jammed-shut failure this project is built to avoid. MV3 can tear down the
    // service worker mid-request, so settling has to be guaranteed here rather
    // than assumed.
    const timer = setTimeout(() => finish(reject, new Error('daemon timeout')), timeoutMs);

    try {
      chrome.runtime.sendMessage(msg, (reply) => {
        if (chrome.runtime.lastError) return finish(reject, new Error(chrome.runtime.lastError.message));
        if (!reply?.ok) return finish(reject, new Error(reply?.error || 'no reply'));
        finish(resolve, reply);
      });
    } catch (e) {
      // Throws synchronously if the extension context was invalidated by a reload.
      finish(reject, e);
    }
  });
}

async function ask(draft, kind, precompute = false) {
  const { v } = await send({
    type: 'judge',
    payload: {
      draft,
      precompute,
      context: { site: location.hostname, kind, localTime: new Date().toLocaleTimeString() },
    },
  });
  return v;
}

/* Judge while they type.
 *
 * A 4B model on a laptop CPU needs ~20 seconds. Waiting until Enter means a
 * 20-second freeze on the one gesture that must feel instant. But a message
 * worth regretting takes longer than that to write, so the Veto starts
 * thinking the moment they pause, and the verdict is cached and waiting by
 * the time they commit.
 */
let typingTimer = null;
let lastPrecomputed = '';

document.addEventListener('input', (ev) => {
  const c = composerFor(ev.target);
  if (!c || c.text.trim().length < MIN_DRAFT) return;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    const text = c.text;
    if (text === lastPrecomputed) return;
    lastPrecomputed = text;
    ask(text, 'message', true).catch(() => {});
  }, 900);
}, true);

/* A Buy button has no typing phase.
 *
 * Messages get judged while they are written, so Enter resolves instantly. A
 * checkout button does not: the first the Veto hears of it is the click, and
 * then the person stares at nothing for twenty seconds. Since the whole point
 * of this build is Akshay's 2am purchases, that is the path that most needed
 * fixing.
 *
 * So the hover is the typing. When the pointer lands on something shaped like
 * a commit button, the verdict is computed and cached before the click lands.
 */
let hoverTimer = null;
let lastHovered = '';

document.addEventListener('pointerover', (ev) => {
  const btn = ev.target.closest?.('button, [role="button"], input[type="submit"], a[href]');
  if (!btn) return;
  const label = labelOf(btn);
  // Message composers are already covered by the typing path above.
  if (!BUY_HINTS.test(label)) return;
  const draft = `[purchase] ${label.trim()}`;
  if (draft === lastHovered) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    lastHovered = draft;
    ask(draft, 'purchase', true).catch(() => {});
  }, 250);
}, true);

async function intercept(ev, draft, kind, replay) {
  if (!armed || ev[BYPASS] || !draft) return;
  // Purchases are judged on the button label, which is always short.
  if (kind !== 'purchase' && draft.trim().length < MIN_DRAFT) return;

  // A judgement is already in flight. Returning here would let this keystroke
  // through unjudged -- a hole in the gate at the exact moment it is working.
  // Swallow it instead; the verdict for the one already running is seconds away.
  if (busy) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    return;
  }

  // Stop first, ask second. The alternative is a race the person always wins.
  ev.preventDefault();
  ev.stopImmediatePropagation();
  busy = true;
  let verdict;
  try {
    verdict = await ask(draft, kind);
  } catch {
    busy = false;
    return replay(); // daemon down -> fail open, never trap the user
  }
  busy = false;
  if (verdict.verdict === 'PASS') return replay();
  showOverlay(verdict, replay);
}

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
  const c = composerFor(ev.target);
  if (!c) return;
  intercept(ev, c.text, 'message', () => {
    const e2 = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    e2[BYPASS] = true;
    c.node.dispatchEvent(e2);
  });
}, true);

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest?.('button, [role="button"], input[type="submit"], a[href]');
  if (!btn) return;
  const label = labelOf(btn);
  const kind = BUY_HINTS.test(label) ? 'purchase' : SEND_HINTS.test(label) ? 'message' : null;
  if (!kind) return;
  const draft = kind === 'purchase' ? `[purchase] ${label.trim()}` : draftNear(btn);
  intercept(ev, draft, kind, () => {
    btn[BYPASS] = true;
    const e2 = new MouseEvent('click', { bubbles: true, cancelable: true });
    e2[BYPASS] = true;
    btn.dispatchEvent(e2);
  });
}, true);

/* ---------------- overlay ---------------- */

function showOverlay(v, replay) {
  document.querySelector('.veto-root')?.remove();
  const root = document.createElement('div');
  root.className = 'veto-root';
  const isAsk = v.verdict === 'ASK';
  root.innerHTML = `
    <div class="veto-card" role="alertdialog" aria-live="assertive">
      <div class="veto-tag">${isAsk ? 'The Veto has a question' : 'The Veto is holding this'}</div>
      <p class="veto-because">${esc(v.because || '')}</p>
      ${v.rule_text ? `<p class="veto-rule">Your rule: <em>${esc(v.rule_text)}</em></p>` : ''}
      ${isAsk ? `<p class="veto-q">${esc(v.question || '')}</p><input class="veto-answer" placeholder="Answer it honestly" />` : ''}
      <div class="veto-actions">
        <button class="veto-wait">Don't send</button>
        <button class="veto-override" disabled>Override <span class="veto-count"></span></button>
      </div>
      <p class="veto-foot">Judged on your laptop by an open-weight model. Nothing left this machine.</p>
    </div>`;
  document.documentElement.appendChild(root);

  const overrideBtn = root.querySelector('.veto-override');
  const count = root.querySelector('.veto-count');
  const answer = root.querySelector('.veto-answer');
  let left = isAsk ? 0 : Math.max(5, v.hold_seconds || 30);

  // Declared before the countdown that reads it: without this the timer chain
  // outlives the DOM it was updating and every stop leaks one.
  let alive = true;

  const outcome = (o) =>
    v.event_id ? send({ type: 'outcome', eventId: v.event_id, outcome: o }).catch(() => {}) : null;

  const close = () => {
    alive = false;
    document.removeEventListener('keydown', onKey, true);
    root.remove();
  };

  const tick = () => {
    if (!alive) return;
    if (left <= 0) {
      overrideBtn.disabled = isAsk ? !answer?.value.trim() : false;
      count.textContent = '';
      return;
    }
    count.textContent = `(${left}s)`;
    left -= 1;
    setTimeout(tick, 1000);
  };

  // Typing the answer only unlocks override once the wait is also over.
  answer?.addEventListener('input', (e) => {
    overrideBtn.disabled = left > 0 || !e.target.value.trim();
  });

  // Escape means they decided not to send. It must never act as an override.
  function onKey(e) {
    if (!alive || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    outcome('obeyed');
    close();
  }
  document.addEventListener('keydown', onKey, true);

  root.querySelector('.veto-wait').addEventListener('click', () => { outcome('obeyed'); close(); });
  overrideBtn.addEventListener('click', () => { outcome('overridden'); close(); replay(); });

  tick();
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
