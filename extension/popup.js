const D = 'http://127.0.0.1:4777';
const set = (id, v, ok) => {
  const el = document.getElementById(id);
  el.innerHTML = ok === undefined ? v : `<span class="dot" style="background:${ok ? '#4ade80' : '#e2574c'}"></span>${v}`;
};
(async () => {
  try {
    const h = await (await fetch(`${D}/api/health`)).json();
    set('daemon', h.ollama?.up ? 'ready' : 'no model', !!h.ollama?.up);
    set('model', h.model);
    const s = await (await fetch(`${D}/api/stats`)).json();
    set('rules', s.rules);
    set('regret', s.regretRate === null ? 'n/a' : `${Math.round(s.regretRate * 100)}%`);
  } catch {
    set('daemon', 'offline', false);
    set('model', 'n/a'); set('rules', 'n/a'); set('regret', 'n/a');
  }
})();
