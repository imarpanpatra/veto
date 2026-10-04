import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isUp, MODEL } from './ollama.js';
import { judge, holdFor } from './judge.js';
import { demoJudge } from './demo.js';
import * as store from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4777;
const DEMO = process.env.VETO_DEMO === '1';

const app = express();
app.use(express.json({ limit: '256kb' }));

/* Who is allowed to talk to the daemon.
 *
 * This started as `Access-Control-Allow-Origin: *`, which was a hole straight
 * through the only promise this project makes. Binding to loopback stops the
 * internet reaching in, but it does NOT stop a page you are visiting: any site
 * open in your browser could have fetched /api/events and read excerpts of the
 * drafts you decided not to send.
 *
 * So page origins are refused outright. The extension reaches the daemon from
 * its service worker (origin chrome-extension://...), never from the content
 * script, precisely so that this line can be drawn.
 */
const isExtension = (o) => /^(chrome|moz)-extension:\/\//.test(o);

// The dashboard's own origin, derived from the request rather than hardcoded:
// locally that is http://127.0.0.1:4777, but the hosted demo is served from
// its platform hostname and must still be able to POST to itself.
const isSelf = (req, o) => {
  const host = req.get('host');
  return !!host && (o === `http://${host}` || o === `https://${host}`);
};

app.use((req, res, next) => {
  const origin = req.get('origin');

  // No Origin header: same-origin GET from the dashboard, or a local script.
  if (!origin) return next();

  if (isExtension(origin) || isSelf(req, origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'content-type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  }

  // A web page is asking. It has no business here.
  return res.status(403).json({ error: 'The Veto answers its own extension and dashboard only.' });
});

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

app.get('/api/health', wrap(async (_req, res) => {
  res.json({ ok: true, demo: DEMO, model: MODEL, ollama: await isUp() });
}));

app.get('/api/rules', wrap(async (_req, res) => res.json(await store.getRules())));

app.post('/api/rules', wrap(async (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'rule text required' });
  res.json(await store.addRule(text, req.body?.kind || 'message'));
}));

app.delete('/api/rules/:id', wrap(async (req, res) =>
  res.json({ removed: await store.removeRule(req.params.id) })));

/* Verdict cache.
 *
 * Local inference on a laptop CPU takes ~20s. That cannot sit in front of the
 * Enter key. But nobody types a message they will regret in under a second --
 * so the Veto judges WHILE they type, and by the time their finger reaches
 * Enter the answer is already here. Slow local inference did not limit the
 * design; it picked a better interaction than the obvious one.
 */
const cache = new Map();
const CACHE_MAX = 200;
const keyOf = (draft, kind, rulesVersion) =>
  `${rulesVersion}:${kind}:${String(draft).trim().toLowerCase().replace(/\s+/g, ' ')}`;

const rulesVersionOf = (rules) => rules.map((r) => r.id + (r.history?.overridden || 0)).join(',');

function cachePut(k, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}

app.post('/api/judge', wrap(async (req, res) => {
  const draft = req.body?.draft ?? '';
  // precompute = they are still typing. Judge and cache, but record nothing:
  // a draft they never sent is not a stop, and must not pollute the history.
  const precompute = !!req.body?.precompute;

  if (!String(draft).trim()) return res.json({ verdict: 'PASS', rule_id: null });
  const rules = await store.getRules();
  const context = { localTime: new Date().toLocaleTimeString(), ...(req.body?.context || {}) };
  const kind = context.kind || 'message';
  const applicable = rules.filter((r) => !r.kind || r.kind === kind);
  if (!applicable.length) return res.json({ verdict: 'PASS', rule_id: null, reason: 'no rules' });

  const k = keyOf(draft, kind, rulesVersionOf(applicable));
  let v = cache.get(k);
  const cached = !!v;

  if (!v) {
    v = DEMO
      ? { ...demoJudge({ draft, rules: applicable }), hold_seconds: holdFor(applicable[0]) }
      : await judge({ draft, context, rules: applicable });
    cachePut(k, v);
  }

  if (precompute) return res.json({ verdict: v.verdict, precomputed: true, cached });
  if (v.verdict === 'PASS') return res.json({ ...v, cached });

  const ev = await store.recordStop({ ...v, draft, context });
  res.json({ ...v, cached, event_id: ev.id });
}));

app.post('/api/events/:id/outcome', wrap(async (req, res) => {
  const ev = await store.recordOutcome(req.params.id, req.body?.outcome);
  ev ? res.json(ev) : res.status(404).json({ error: 'no such event' });
}));

app.post('/api/events/:id/regret', wrap(async (req, res) => {
  const ev = await store.recordRegret(req.params.id, !!req.body?.regret);
  ev ? res.json(ev) : res.status(404).json({ error: 'no such event' });
}));

app.get('/api/events', wrap(async (_req, res) => res.json(await store.recent())));
app.get('/api/pending-regret', wrap(async (_req, res) => res.json(await store.pendingRegret())));
app.get('/api/stats', wrap(async (_req, res) => res.json(await store.stats())));

app.use(express.static(join(__dirname, '..', 'public')));

// Loopback only when it is the real thing: the whole privacy claim rests on
// drafts never reaching a network interface. The hosted demo holds no real
// data and must bind publicly for the platform to route to it.
const HOST = DEMO ? '0.0.0.0' : '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`The Veto is listening on http://${HOST}:${PORT}`);
  console.log(`model: ${MODEL}${DEMO ? '  (demo mode)' : ''}`);
});
