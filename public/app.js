const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const api = async (m, p, b) => {
  const r = await fetch('/api' + p, {
    method: m,
    headers: { 'content-type': 'application/json' },
    body: b && JSON.stringify(b),
  });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};

async function refresh() {
  let h, s, rules, events, pending;
  try {
    [h, s, rules, events, pending] = await Promise.all([
      api('GET', '/health'), api('GET', '/stats'), api('GET', '/rules'),
      api('GET', '/events'), api('GET', '/pending-regret'),
    ]);
  } catch (e) {
    // Without this the page just sits there blank and you cannot tell whether
    // the Veto is thinking, broken, or not running at all.
    $('#status').innerHTML =
      '<span style="color:var(--red)">Daemon unreachable: ' + esc(e.message) + '</span>';
    return;
  }

  const live = h.demo ? 'demo mode' : h.ollama?.up ? esc(h.model) + ' ready' : 'model offline';
  $('#status').innerHTML =
    '<span>Engine <b>' + live + '</b></span>' +
    '<span>Rules <b>' + s.rules + '</b></span>' +
    '<span>Stopped <b>' + s.stops + '</b></span>' +
    '<span>Overridden <b>' + s.overrides + '</b></span>' +
    '<span>Of those, regretted <b>' + (s.regretRate === null ? 'n/a' : Math.round(s.regretRate * 100) + '%') + '</b></span>';

  $('#rules').innerHTML = rules.length
    ? rules.map((r) => {
        const x = r.history || {};
        return '<li><div><div>' + esc(r.text) + '</div><div class="meta">tripped ' + (x.tripped || 0) +
          ' &middot; overridden ' + (x.overridden || 0) + ' &middot; regretted ' + (x.regretted || 0) +
          '</div></div><button class="ghost" data-del="' + esc(r.id) + '">Remove</button></li>';
      }).join('')
    : '<li class="hint" style="border:0;padding-top:4px">No rules yet. The Veto cannot stop anything until you tell it what you regret.</li>';

  $('#pendingWrap').hidden = !pending.length;
  $('#pending').innerHTML = pending.map((e) =>
    '<li><div class="ex">"' + esc(e.excerpt) + '"</div><div class="why">' + esc(e.because) + '</div>' +
    '<div class="act"><button class="ghost" data-regret="' + esc(e.id) + '" data-v="1">I regret it</button>' +
    '<button class="ghost" data-regret="' + esc(e.id) + '" data-v="0">No, it was fine</button></div></li>').join('');

  $('#events').innerHTML = events.length
    ? events.map((e) =>
        '<li><span class="v ' + esc(e.verdict) + '">' + esc(e.verdict) + '</span>' +
        '<span class="ex">"' + esc(e.excerpt) + '"</span><div class="why">' + esc(e.because) + '</div>' +
        '<div class="meta" style="color:#5a6270;font-size:12px;margin-top:4px">' +
        new Date(e.at).toLocaleString() + ' &middot; ' + esc(e.site || 'local') + ' &middot; ' +
        (e.outcome ? esc(e.outcome) : 'no outcome') +
        (e.regret === true ? ' &middot; regretted' : e.regret === false ? ' &middot; no regret' : '') +
        '</div></li>').join('')
    : '<li class="hint" style="border:0;padding-top:4px">Nothing stopped yet.</li>';
}

$('#addRule').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = $('#ruleText').value.trim();
  if (!t) return;
  await api('POST', '/rules', { text: t });
  $('#ruleText').value = '';
  refresh();
});

document.addEventListener('click', async (e) => {
  const del = e.target.dataset?.del;
  const reg = e.target.dataset?.regret;
  if (del) { await api('DELETE', '/rules/' + del); refresh(); }
  if (reg) { await api('POST', '/events/' + reg + '/regret', { regret: e.target.dataset.v === '1' }); refresh(); }
});

$('#judge').addEventListener('click', async () => {
  const draft = $('#draft').value;
  if (!draft.trim()) return;
  // On CPU this is ~20s the first time a draft is seen. Say so, or it reads
  // as a hang.
  $('#verdict').innerHTML =
    '<div class="card">Thinking&hellip; <span style="color:var(--dim);font-size:13px">' +
    '(up to ~25s on CPU for a draft it has not seen)</span></div>';
  let v;
  try {
    v = await api('POST', '/judge', { draft, context: { site: 'the rulebook', kind: 'message' } });
  } catch (e) {
    $('#verdict').innerHTML = '<div class="card">Could not reach the model: ' + esc(e.message) + '</div>';
    return;
  }
  $('#verdict').innerHTML = '<div class="card"><span class="v ' + esc(v.verdict) + '">' + esc(v.verdict) + '</span>' +
    (v.verdict === 'PASS'
      ? '<p class="because">Trips none of your rules.</p>'
      : '<p class="because">' + esc(v.because) + '</p>' +
        (v.rule_text ? '<p class="rule">Your rule: ' + esc(v.rule_text) + '</p>' : '') +
        (v.question ? '<p class="rule" style="color:var(--amber)">' + esc(v.question) + '</p>' : '') +
        '<p class="rule">Held for ' + v.hold_seconds + 's' + (v.ms ? ' &middot; judged in ' + v.ms + 'ms' : '') + '</p>') +
    '</div>';
  refresh();
});

refresh();
