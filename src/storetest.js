/* Store tests. No model, no server, no network.
 *
 * These cover the counters that decide how long the next hold lasts, so a
 * double-count here quietly makes the Veto harsher than the person earned.
 *   node src/storetest.js
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VETO_DATA = join(mkdtempSync(join(tmpdir(), 'veto-')), 'veto.json');

const s = await import('./store.js');

let fails = 0;
const ok = (c, label, extra = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!c) fails++;
};

const rule = await s.addRule('I regret messages where I drag up things from months ago.');
ok(rule.id === 'r_drag_months', 'rule id is built from the rule words', rule.id);

const dup = await s.addRule('I regret messages where I drag up things from months ago.');
ok(dup.id !== rule.id, 'duplicate rule text gets a distinct id', dup.id);
await s.removeRule(dup.id);

const DRAFT = 'remember when you bailed on me months ago, classic you';
const stop = (d = DRAFT) =>
  s.recordStop({ verdict: 'HOLD', rule_id: rule.id, draft: d, because: 'x', context: {}, hold_seconds: 30 });

const a = await stop();
const b = await stop();
ok(a.id === b.id, 'pressing Enter twice on a held draft reuses the one stop', `${a.id} / ${b.id}`);
ok((await s.getRules())[0].history.tripped === 1, 'and does not double-count tripped');

await s.recordOutcome(a.id, 'overridden');
await s.recordOutcome(a.id, 'overridden');
ok((await s.getRules())[0].history.overridden === 1, 'outcome recorded once even if sent twice');

// A resolved stop no longer blocks a fresh one for the same text.
const c = await stop();
ok(c.id !== a.id, 'a new stop is created once the old one was answered');
await s.recordOutcome(c.id, 'obeyed');
ok((await s.getRules())[0].history.obeyed === 1, 'obeyed counted separately');

await s.recordRegret(a.id, false);
ok((await s.getRules())[0].history.regretted === 0, 'saying it was fine counts nothing');

await s.recordRegret(a.id, true);
ok((await s.getRules())[0].history.regretted === 1, 'changing your mind to regret DOES count');

await s.recordRegret(a.id, true);
ok((await s.getRules())[0].history.regretted === 1, 'answering regret twice counts once');

await s.recordRegret(a.id, false);
ok((await s.getRules())[0].history.regretted === 0, 'taking it back decrements');

const st = await s.stats();
ok(st.regrets === 0 && st.overrides === 1, 'stats agree with rule history', JSON.stringify(st));

console.log(fails ? `\n${fails} FAILED` : '\nstore behaves');
process.exit(fails ? 1 : 0);
