/* End-to-end proof against a running daemon. Exercises the whole loop:
 * rule -> stop -> override -> regret -> harsher hold next time. */
const B = process.env.VETO_BASE || 'http://127.0.0.1:4777';
const j = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) });
  return r.json();
};
let fails = 0;
const ok = (c, label, extra = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!c) fails++; };

// This test asserts on exact counts and on which rule gets named, so a store
// that already has rules or events in it produces confusing failures that look
// like product bugs. Say so plainly instead.
const existing = await j('GET', '/api/stats');
if (existing.rules || existing.stops) {
  console.error(`Store is not empty (${existing.rules} rules, ${existing.stops} stops).`);
  console.error('Stop the daemon, delete data/, and start it again before running this.');
  process.exit(2);
}

const rule = await j('POST', '/api/rules', { text: 'I regret messages where I drag up things from months ago.' });
ok(!!rule.id, 'rule created', rule.id);

const clean = await j('POST', '/api/judge', { draft: 'hey, are we still on for 7?', context: { site: 'web.whatsapp.com', kind: 'message' } });
ok(clean.verdict === 'PASS', 'innocuous draft passes', clean.verdict);

const hot = await j('POST', '/api/judge', { draft: 'remember when you ditched me months ago? classic you.', context: { site: 'web.whatsapp.com', kind: 'message' } });
ok(hot.verdict !== 'PASS', 'rule-tripping draft is stopped', hot.verdict);
ok(!!hot.event_id, 'stop was recorded before the choice', hot.event_id);
ok(hot.rule_id === rule.id, 'names the rule it tripped');
const firstHold = hot.hold_seconds;
ok(firstHold > 0, 'hold has a duration', firstHold + 's');

await j('POST', `/api/events/${hot.event_id}/outcome`, { outcome: 'overridden' });
const pend = await j('GET', '/api/pending-regret');
ok(pend.some((e) => e.id === hot.event_id), 'override queued for regret review');

await j('POST', `/api/events/${hot.event_id}/regret`, { regret: true });
const s = await j('GET', '/api/stats');
ok(s.overrides === 1 && s.regrets === 1, 'regret recorded', JSON.stringify(s));

const again = await j('POST', '/api/judge', { draft: 'remember when you ditched me months ago? classic you.', context: { site: 'web.whatsapp.com', kind: 'message' } });
ok(again.hold_seconds > firstHold, 'hold escalates after a regretted override', `${firstHold}s -> ${again.hold_seconds}s`);

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
