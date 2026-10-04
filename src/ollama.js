// Thin Ollama client. No SDK, no key, no network beyond localhost.
// This file is the entire "AI provider" surface of the project.

const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
export const MODEL = process.env.VETO_MODEL || 'gemma3:4b';

export async function isUp() {
  try {
    const r = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { up: false, reason: `HTTP ${r.status}` };
    const { models = [] } = await r.json();
    const names = models.map((m) => m.name);
    return {
      up: true,
      models: names,
      // Exact match only. Prefix-matching the family name reported "ready"
      // when gemma3:1b was installed and gemma3:4b was the configured model.
      hasModel: names.some((n) => n.replace(/:latest$/, '') === MODEL.replace(/:latest$/, '')),
    };
  } catch (e) {
    return { up: false, reason: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

// Ask for JSON and get JSON. Gemma is small; `format: json` keeps it honest.
// 45s was not enough: the very first call after a restart pays for a 2.9GB
// model load on top of ~23s of inference, and it timed out. These calls happen
// while the person is still typing, so a long ceiling costs them nothing.
export async function chatJSON({ system, user, timeoutMs = 90000 }) {
  const started = Date.now();
  const r = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: 'json',
      // temperature 0: a gate that answers differently each time is not a gate.
      // Greedy decoding makes the same draft always get the same verdict, which
      // matters more here than any variety a sampler could add.
      // On a laptop CPU every one of these matters. num_thread defaults to
      // half the cores; there is no reason to leave the other half idle.
      // keep_alive stops a 2.9GB reload between judgements.
      // num_ctx stays at the model's default 4096. Halving it to 2048 was
      // tempting for speed, but system prompt + a long rulebook + a 2000-char
      // draft can approach that, and context overflow does not error -- it
      // silently drops the start of the prompt, which is the instructions.
      keep_alive: '15m',
      options: { temperature: 0, num_predict: 160, num_thread: 8, num_ctx: 4096 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text().catch(() => '')}`);
  const body = await r.json();
  const raw = body?.message?.content ?? '';
  return { raw, parsed: safeParse(raw), ms: Date.now() - started };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
