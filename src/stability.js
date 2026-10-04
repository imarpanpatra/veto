/* Is the verdict stable? Same draft, N runs, with a one-rule and a three-rule
 * rulebook. A gate that answers differently each time is not a gate.
 *   node src/stability.js [runs]
 */
import { judge } from './judge.js';

const RUNS = Number(process.argv[2] || 4);
const ONE = [{ id: 'r_past', text: 'I regret messages where I drag up things from months ago.', history: {} }];
const THREE = [
  ONE[0],
  { id: 'r_late', text: 'I regret messages I send after 1am.', history: {} },
  { id: 'r_fast', text: 'I regret replying within five minutes of reading something that stung.', history: {} },
];

const DRAFTS = [
  { label: 'innocuous', text: 'hey, are we still on for 7?', want: 'PASS' },
  { label: 'trips rule', text: 'remember when you bailed on me months ago? classic you.', want: 'HOLD' },
];

for (const [name, rules] of [['1 rule', ONE], ['3 rules', THREE]]) {
  for (const d of DRAFTS) {
    const got = [];
    for (let i = 0; i < RUNS; i++) {
      const v = await judge({ draft: d.text, context: { kind: 'message', localTime: '14:00' }, rules });
      got.push(v.verdict);
    }
    const stable = new Set(got).size === 1;
    const right = got.every((g) => (d.want === 'PASS' ? g === 'PASS' : g !== 'PASS'));
    console.log(
      `${right && stable ? 'PASS' : 'FAIL'}  [${name}] ${d.label.padEnd(11)} want ${d.want.padEnd(4)} got ${got.join(',')}`
    );
  }
}
