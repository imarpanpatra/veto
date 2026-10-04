/* Starter rulebook.
 *
 * These are written the way a real rulebook has to be written: first person,
 * past tense, about yourself. Not "don't be rude" -- a rule the Veto can
 * actually check is a sentence you would only write about your own history.
 *
 *   npm run seed
 *
 * Change these to the real ones. A rulebook of someone else's regrets is
 * furniture; it will stop the wrong things and let the right ones through.
 */
import { addRule, load } from './store.js';

const RULES = [
  { text: 'I regret messages I send after 1am.', kind: 'message' },
  { text: 'I regret messages where I drag up things from months ago.', kind: 'message' },
  { text: 'I regret replying within five minutes of reading something that stung.', kind: 'message' },
  { text: 'I regret anything I buy after midnight.', kind: 'purchase' },
  { text: 'I regret buying things on a night I have had a bad day.', kind: 'purchase' },
];

const db = await load();
if (db.rules.length) {
  console.log(`Rulebook already has ${db.rules.length} rule(s). Leaving it alone.`);
  console.log('Delete data/veto.json first if you want to start over.');
  process.exit(0);
}

for (const r of RULES) {
  const added = await addRule(r.text, r.kind);
  console.log(`  + [${added.kind}] ${added.text}`);
}
console.log(`\nSeeded ${RULES.length} rules. Open http://127.0.0.1:4777 to edit them.`);
