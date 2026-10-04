/* Deterministic stand-in for the model, used ONLY when VETO_DEMO=1.
 *
 * This exists so the hosted demo can be clicked by someone without a GPU.
 * It is keyword matching, not a model, and the README says so plainly. The
 * real Veto runs gemma3:4b on your own machine and never calls out.
 */
const CUES = [
  { re: /\b(remember when|last year|months ago|you always|you never|back then)\b/i, why: 'You said you regret messages that drag up old history.' },
  { re: /\b(hate|stupid|idiot|shut up|whatever|done with you)\b/i, why: 'You said you regret sending things you wrote while angry.' },
  { re: /\[purchase\]/i, why: 'You said you regret buying things late at night.' },
];

export function demoJudge({ draft, rules }) {
  const hit = CUES.find((c) => c.re.test(draft));
  if (!hit || !rules.length) return { verdict: 'PASS', rule_id: null, because: '', demo: true, ms: 12 };
  const rule = rules[0];
  const lateNight = new Date().getHours() >= 23 || new Date().getHours() < 5;
  return {
    verdict: lateNight ? 'ASK' : 'HOLD',
    rule_id: rule.id,
    rule_text: rule.text,
    because: hit.why,
    question: lateNight ? 'Would you still send this at 9am tomorrow?' : null,
    demo: true,
    ms: 12,
  };
}
