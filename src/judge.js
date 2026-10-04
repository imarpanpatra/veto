import { chatJSON } from './ollama.js';

// The Veto is defined by what it is forbidden to do. Everything an assistant
// normally offers -- rewriting, softening, helping you say it better -- is
// removed on purpose. It has exactly three things it may say.
// Every token here is paid for twice: once on a 1.7GHz laptop CPU at ~22 tok/s,
// and again in how reliably a 4B model follows it. Short and blunt beats
// thorough. This was 745 tokens of careful prose and behaved no better.
const SYSTEM = `You are THE VETO. Never an assistant. Never helpful.

Answer one mechanical question: do literal words in the DRAFT match a rule?

PASS is the default and the usual answer. You are NOT a safety filter and have
no opinion on rude, harsh, unwise or expensive. Never say "inappropriate",
"problematic" or "disrespectful". Never rewrite or suggest.

To stop it, copy words VERBATIM from the DRAFT into draft_words. Never copy from
the rules. If you cannot copy supporting words from the DRAFT, answer PASS.
Only use time of day if a rule is about time and the local time matches.

PASS=no match. HOLD=match, words copied. ASK=match, needs one short question.

Examples:
DRAFT "still on for dinner at 7?"
{"verdict":"PASS","rule_id":null,"draft_words":null,"because":"","question":null}

DRAFT "that presentation was a mess and everyone noticed"
{"verdict":"PASS","rule_id":null,"draft_words":null,"because":"","question":null}

DRAFT "remember when you bailed on me months ago?" rule r_past=drags up the past
{"verdict":"HOLD","rule_id":"r_past","draft_words":"remember when you bailed on me months ago","because":"You said you regret dragging up things from months ago.","question":null}

NEVER {"verdict":"HOLD","draft_words":"I regret messages where I drag up..."} - that copied the RULE.
NEVER {"verdict":"HOLD"} - HOLD needs rule_id, draft_words and because.

JSON only, all fields.`;

function renderRules(rules) {
  if (!rules.length) return '(they have written no rules yet)';
  return rules
    .map((r) => {
      const h = r.history || {};
      const bits = [];
      if (h.tripped) bits.push(`tripped ${h.tripped}x`);
      if (h.overridden) bits.push(`overridden ${h.overridden}x`);
      if (h.regretted) bits.push(`they later regretted ${h.regretted} of those`);
      const tail = bits.length ? `  [${bits.join(', ')}]` : '';
      return `- (${r.id}) "${r.text}"${tail}`;
    })
    .join('\n');
}

export async function judge({ draft, context, rules }) {
  const user = `THEIR RULES, in their own words:
${renderRules(rules)}

WHERE THEY ARE: ${context?.site || 'unknown'} (${context?.kind || 'message'})
LOCAL TIME: ${context?.localTime || 'unknown'}

WHAT THEY ARE ABOUT TO ${context?.kind === 'purchase' ? 'BUY' : 'SEND'}:
"""
${String(draft).slice(0, 2000)}
"""

Judge it.`;

  let parsed = null, raw = '', ms = 0;
  try {
    ({ parsed, raw, ms } = await chatJSON({ system: SYSTEM, user }));
  } catch (e) {
    // The Veto fails OPEN. A gate that jams shut because a model crashed is a
    // gate people rip out within a day.
    return { verdict: 'PASS', rule_id: null, because: '', degraded: true, error: e.message, ms: 0 };
  }

  const verdict = ['PASS', 'HOLD', 'ASK'].includes(parsed?.verdict) ? parsed.verdict : 'PASS';
  const rule = rules.find((r) => r.id === parsed?.rule_id) || null;

  // A verdict naming a rule that does not exist is a hallucination, not a veto.
  if (verdict !== 'PASS' && !rule) {
    return { verdict: 'PASS', rule_id: null, because: '', degraded: true, error: 'unknown rule_id', ms, raw };
  }

  // Grounding. The model must point at the words it is stopping them for, and
  // those words must really be in the draft. This is what makes a small model
  // safe to trust here: it cannot stop anyone on a vibe, only on evidence that
  // code can re-check. Every failure mode of a 4B model -- inventing a reason,
  // drifting into "this seems disrespectful", matching the wrong rule -- lands
  // here and is downgraded to PASS.
  // A stop with no stated reason is not a stop. If it cannot tell them why in
  // their own terms, it has not understood the rule well enough to enforce it.
  if (verdict !== 'PASS' && !String(parsed?.because || '').trim()) {
    return { verdict: 'PASS', rule_id: null, because: '', degraded: true, error: 'no reason given', ms, raw };
  }

  if (verdict !== 'PASS' && !quoted(parsed?.draft_words, draft, rule)) {
    return {
      verdict: 'PASS', rule_id: null, because: '', degraded: true,
      error: `unquotable: ${JSON.stringify(parsed?.draft_words ?? null)}`, ms, raw,
    };
  }

  return {
    verdict,
    rule_id: rule?.id ?? null,
    rule_text: rule?.text ?? null,
    quote: parsed?.draft_words ?? null,
    because: String(parsed?.because || '').slice(0, 200),
    question: verdict === 'ASK' ? String(parsed?.question || '').slice(0, 200) : null,
    hold_seconds: verdict === 'PASS' ? 0 : holdFor(rule),
    ms,
  };
}

// Is the model's quote really in the draft? Lenient about whitespace, case and
// smart quotes, because models tidy punctuation as they copy -- but strict
// about the words themselves.
//
// The second half of this is the one that earns its keep. When the model has a
// real match it points at a PART of the draft ("remember when you bailed on me
// months ago"). When it is confabulating -- which gemma3:4b does when there is
// only one rule and it feels obliged to use it -- it hands back the whole draft
// as its own evidence. Citing everything is citing nothing, so a whole-draft
// quote is only accepted when something else corroborates it (see below).
export function quoted(quote, draft, rule) {
  const q = norm(quote);
  const d = norm(draft);
  if (q.length < 4) return false;
  if (!d.includes(q)) return false;          // not in the draft at all: rejected
  if (q !== d) return true;                  // pointed at a part: that is evidence

  // It handed back the entire draft as its own evidence. Citing everything is
  // citing nothing, and it is what gemma3:4b does when it feels obliged to use
  // the only rule it has. Accept it only if something else corroborates.
  if (isTimeRule(rule)) return true;         // time rules match on the clock, not the wording
  return sharesWords(rule, d);               // otherwise the draft must share the rule's words
}

// A rule about WHEN you send cannot be evidenced by the words you sent, so
// word-matching must not be required of it.
function isTimeRule(rule) {
  return /\b(\d{1,2}\s*(am|pm)|night|late|midnight|morning|hour|after\b.*\b\d)/i.test(rule?.text || '');
}

// Does the draft actually contain any of the rule's distinctive words?
const RULE_STOP = new Set(('i me my we you your a an the and or but if then that this of in on at to from for ' +
  'with about is are was were be been do does did have has had will would can could should anything ' +
  'something when where what who how why not no so too very just regret regrets regretted message ' +
  'messages send sending sent thing things up it them they').split(' '));

function sharesWords(rule, normalisedDraft) {
  const words = new Set(normalisedDraft.split(' '));
  const key = (String(rule?.text || '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length > 2 && !RULE_STOP.has(w));
  // Stem crudely: "replying" ~ "reply", "months" ~ "month". The second replace
  // undoes English consonant doubling, without which "dragging" stems to
  // "dragg" and never matches "drag".
  const stem = (w) => w.replace(/(ing|ed|s)$/, '').replace(/([bcdfghjklmnpqrstvwxz])\1$/, '$1');
  const stems = new Set([...words].map(stem));
  return key.some((k) => words.has(k) || stems.has(stem(k)));
}

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'" ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// The model classifies. It does NOT get to choose the punishment.
// Hold length is a pure function of how often this exact rule has been
// overridden and regretted -- the one number the person cannot argue with.
export function holdFor(rule) {
  const h = rule?.history || {};
  const overridden = h.overridden || 0;
  const regretted = h.regretted || 0;
  const base = 30;
  const regretRate = overridden ? regretted / overridden : 0;
  const seconds = Math.round(base * (1 + overridden * 0.5) * (1 + regretRate * 3));
  return Math.min(seconds, 15 * 60); // never more than 15 minutes
}
