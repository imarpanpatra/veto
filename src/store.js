import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA = process.env.VETO_DATA || join(process.cwd(), 'data', 'veto.json');

const MAX_EVENTS = 500;
const EMPTY = { rules: [], events: [], created: null };

let cache = null;

export async function load() {
  if (cache) return cache;
  if (!existsSync(DATA)) {
    cache = { ...EMPTY, created: new Date().toISOString() };
    await save();
    return cache;
  }
  try {
    cache = JSON.parse(await readFile(DATA, 'utf8'));
  } catch {
    cache = { ...EMPTY, created: new Date().toISOString() };
  }
  cache.rules ||= [];
  cache.events ||= [];
  return cache;
}

export async function save() {
  await mkdir(dirname(DATA), { recursive: true });
  const tmp = `${DATA}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2));
  await rename(tmp, DATA); // never leave a half-written rulebook on disk
}

export async function getRules() {
  return (await load()).rules;
}

// Rule ids are read by the model, not just by code, and that turned out to
// matter more than expected: with an opaque id like `r_61d61d78` gemma3:4b
// started stopping ordinary messages, while the same rule text under `r_past`
// passed them. An id carrying no meaning gives a small model nothing to anchor
// to, so it reaches for a match. These ids are built from the rule's own
// distinctive words, which costs nothing and measurably improves judgement.
const STOP = new Set(('i me my myself we our ours you your yours he him his she her it its they them their ' +
  'a an the and or but if then than that this these those of in on at to from for with without about ' +
  'is are was were be been being do does did doing have has had having will would shall should can could ' +
  'anything something when where what who how why not no nor so too very just regret regrets regretted ' +
  'message messages send sending sent thing things').split(' '));

function slugFor(text, taken) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  const keep = words.filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 2);
  let base = `r_${keep.join('_') || 'rule'}`.slice(0, 24);
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  return id;
}

export async function addRule(text, kind = 'message') {
  const db = await load();
  const rule = {
    id: slugFor(text, new Set(db.rules.map((r) => r.id))),
    text: String(text).trim().slice(0, 300),
    kind,
    created: new Date().toISOString(),
    history: { tripped: 0, overridden: 0, regretted: 0, obeyed: 0 },
  };
  db.rules.push(rule);
  await save();
  return rule;
}

export async function removeRule(id) {
  const db = await load();
  const before = db.rules.length;
  db.rules = db.rules.filter((r) => r.id !== id);
  await save();
  return before !== db.rules.length;
}

function bump(rule, field) {
  rule.history ||= { tripped: 0, overridden: 0, regretted: 0, obeyed: 0 };
  rule.history[field] = (rule.history[field] || 0) + 1;
}

// Every stop is recorded BEFORE the person decides, so the record cannot be
// rewritten by whatever they choose next.
export async function recordStop({ verdict, rule_id, draft, because, context, hold_seconds }) {
  const db = await load();
  const excerpt = String(draft).slice(0, 140);

  // Pressing Enter again on a draft that was already held must not log a second
  // stop. The verdict is cached, so the second press costs nothing and would
  // otherwise inflate `tripped` -- and `tripped` feeds the escalation maths.
  // An existing stop for the same rule and text that has not been resolved yet
  // IS this stop; hand it back rather than making a new one.
  const open = db.events.find(
    (e) => e.outcome === null && e.rule_id === rule_id && e.excerpt === excerpt
  );
  if (open) return open;

  const ev = {
    id: `e_${randomUUID().slice(0, 8)}`,
    at: new Date().toISOString(),
    verdict,
    rule_id,
    because,
    hold_seconds,
    site: context?.site || null,
    kind: context?.kind || 'message',
    // The draft is the most private thing here. Keep a short excerpt so the
    // person can recognise it later, never the whole thing.
    excerpt,
    outcome: null,      // 'obeyed' | 'overridden'
    regret: null,       // true | false, answered later
  };
  const rule = db.rules.find((r) => r.id === rule_id);
  if (rule) bump(rule, 'tripped');
  db.events.unshift(ev);

  // The whole file is rewritten on every stop, so the log cannot grow without
  // limit. The counters that drive escalation live on the rules, not here, so
  // trimming old events loses history on screen but never changes behaviour.
  // Anything still awaiting an answer is kept regardless of age.
  if (db.events.length > MAX_EVENTS) {
    const unresolved = db.events.filter((e) => e.outcome === null || e.regret === null);
    const keep = new Set(db.events.slice(0, MAX_EVENTS).map((e) => e.id));
    db.events = db.events.filter((e) => keep.has(e.id) || unresolved.includes(e));
  }

  await save();
  return ev;
}

export async function recordOutcome(eventId, outcome) {
  const db = await load();
  const ev = db.events.find((e) => e.id === eventId);
  if (!ev) return null;

  // Only the first answer counts. A double-clicked button, a retry after a
  // flaky reply, or the overlay closing twice must not each bump the rule's
  // history -- those counters set how long the next hold lasts.
  if (ev.outcome !== null) return ev;

  ev.outcome = outcome === 'overridden' ? 'overridden' : 'obeyed';
  const rule = db.rules.find((r) => r.id === ev.rule_id);
  if (rule) bump(rule, ev.outcome);
  await save();
  return ev;
}

// The loop that makes this more than a nag: you only find out later whether
// the Veto was right, and your own hindsight is what sharpens it.
export async function recordRegret(eventId, regret) {
  const db = await load();
  const ev = db.events.find((e) => e.id === eventId);
  if (!ev) return null;

  const was = ev.regret;
  const now = !!regret;
  ev.regret = now;

  // Track the TRANSITION, not just the first answer. Saying "it was fine" and
  // later changing your mind to "I regret it" has to count, or the rule's
  // regret tally silently disagrees with the history shown on screen -- and
  // the tally is what lengthens the next hold.
  if (was !== now && ev.outcome === 'overridden') {
    const rule = db.rules.find((r) => r.id === ev.rule_id);
    if (rule) {
      rule.history ||= { tripped: 0, overridden: 0, regretted: 0, obeyed: 0 };
      const n = rule.history.regretted || 0;
      rule.history.regretted = now ? n + 1 : Math.max(0, n - 1);
    }
  }
  await save();
  return ev;
}

export async function pendingRegret() {
  const db = await load();
  return db.events.filter((e) => e.outcome === 'overridden' && e.regret === null);
}

export async function stats() {
  const db = await load();
  const stops = db.events.length;
  const overrides = db.events.filter((e) => e.outcome === 'overridden').length;
  const regrets = db.events.filter((e) => e.regret === true).length;
  return {
    rules: db.rules.length,
    stops,
    obeyed: db.events.filter((e) => e.outcome === 'obeyed').length,
    overrides,
    regrets,
    regretRate: overrides ? +(regrets / overrides).toFixed(2) : null,
  };
}

export async function recent(n = 50) {
  return (await load()).events.slice(0, n);
}
