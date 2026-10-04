/* Prints the model's raw JSON for one draft. Debug aid, not part of the product.
 *   VETO_MODEL=gemma3:1b node src/raw.js "draft text here"
 */
import { readFileSync } from 'node:fs';
import { chatJSON, MODEL } from './ollama.js';

const src = readFileSync(new URL('./judge.js', import.meta.url), 'utf8');
const SYSTEM = src.split('const SYSTEM = `')[1].split('`;')[0];

const draft = process.argv[2] || 'remember when you bailed on me months ago? yeah. classic you.';

const user = `THEIR RULES, in their own words:
- (r_late) "I regret messages I send after 1am."
- (r_past) "I regret messages where I drag up things from months ago."
- (r_fast) "I regret replying within five minutes of reading something that stung."

WHERE THEY ARE: test (message)
LOCAL TIME: 14:00

WHAT THEY ARE ABOUT TO SEND:
"""
${draft}
"""

Judge it.`;

const r = await chatJSON({ system: SYSTEM, user });
console.log(`model: ${MODEL}  ${r.ms}ms`);
console.log('RAW  :', r.raw);
console.log('PARSE:', JSON.stringify(r.parsed));
