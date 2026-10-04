/* Unit tests for the grounding guard. No model, no network, instant.
 *
 * This is the component standing between a confused 4B model and a false stop,
 * so it is the one piece that gets tested without the model in the loop.
 *   node src/guardtest.js
 */
import { quoted } from './judge.js';

const R_PAST = { text: 'I regret messages where I drag up things from months ago.' };
const R_LATE = { text: 'I regret messages I send after 1am.' };
const R_FAST = { text: 'I regret replying within five minutes of reading something that stung.' };

const CASES = [
  // [name, draft, what the model claimed to quote, rule, should it be allowed to stop?]
  ['proper subspan is evidence',
    'remember when you bailed on me months ago? classic you.', 'remember when you bailed on me months ago', R_PAST, true],

  ['whole draft + shares rule words -> corroborated',
    'remember when you bailed on me months ago? yeah. classic you.', 'remember when you bailed on me months ago? yeah. classic you.', R_PAST, true],

  ['whole draft + shares nothing -> confabulation',
    'hey, are we still on for 7?', 'hey, are we still on for 7?', R_PAST, false],

  ['quoting the RULE instead of the draft',
    'hey, are we still on for 7?', 'I regret messages where I drag up things from months ago.', R_PAST, false],

  ['time rule needs no word overlap',
    'you never listen to me at all and you know it', 'you never listen to me at all and you know it', R_LATE, true],

  // Known and accepted limitation. When the model quotes the whole draft and
  // the draft shares no vocabulary with the rule, there is nothing left to
  // corroborate with, so the stop is dropped. This fails OPEN by design: the
  // cost is a missed stop, never a false one. A proper subspan quote works
  // regardless of shared vocabulary, which is the common case.
  ['short draft sharing nothing with the rule -> fails open',
    'i hate you', 'i hate you', R_PAST, false],

  ['short draft that does share the rule vocabulary',
    'dragging this up again', 'dragging this up again', R_PAST, true],

  ['empty quote',
    'remember when you bailed on me months ago', '', R_PAST, false],

  ['null quote',
    'remember when you bailed on me months ago', null, R_PAST, false],

  ['stemming: "replying" matches "reply"',
    'i am going to reply to that right now before i cool off', 'i am going to reply to that right now before i cool off', R_FAST, true],

  ['smart quotes and casing are tolerated',
    'Remember when you BAILED on me months ago’s mess', 'remember when you bailed on me months ago', R_PAST, true],
];

let fails = 0;
for (const [name, draft, quote, rule, want] of CASES) {
  const got = quoted(quote, draft, rule);
  if (got !== want) fails++;
  console.log(`${got === want ? 'PASS' : 'FAIL'}  ${name}${got === want ? '' : `  (want ${want}, got ${got})`}`);
}
console.log(fails ? `\n${fails} FAILED` : `\n${CASES.length} guard checks passed`);
process.exit(fails ? 1 : 0);
