const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const DEC = /^\d+(\.\d{1,9})?$/;
const nano = (u) => { if (!DEC.test(String(u))) return null; const [i, f = ''] = String(u).split('.'); return BigInt(i) * 1000000000n + BigInt((f + '000000000').slice(0, 9)); };
const usd = (n) => { const f = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/, ''); return `$${n / 1000000000n}${f ? '.' + f : ''}`; };

function render(text, label) {
  const calls = [];
  let bad = 0;
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { calls.push(JSON.parse(l)); } catch { bad++; } }
  const by = new Map();
  let cost = 0n, cmpPaid = 0n, cmpCheap = 0n, n = 0, unpriced = 0, denied = 0, est = 0;
  for (const c of calls) {
    if (c.outcome === 'denied') { denied++; continue; }
    if (!['settled', 'unpriced'].includes(c.outcome)) continue;
    n++;
    const m = by.get(c.model) ?? { calls: 0, cost: 0n, cheap: 0n, cmp: 0, venue: new Map() };
    m.calls++;
    const k = c.cost ? nano(c.cost.usd) : null;
    if (k === null) unpriced++;
    else {
      cost += k; m.cost += k; if (c.cost.estimate) est++;
      const ch = c.cheapest ? nano(c.cheapest.usd) : null;
      if (ch !== null) { cmpPaid += k; cmpCheap += ch; m.cheap += ch; m.cmp++; const v = `${c.cheapest.provider} ${c.cheapest.model}`; m.venue.set(v, (m.venue.get(v) ?? 0) + 1); }
    }
    by.set(c.model, m);
  }
  $('sum').innerHTML = `<p>${esc(label)}: ${n} call(s), ${usd(cost)}${est ? ` (${est} estimated)` : ''}. Unpriced ${unpriced}, denied by caps ${denied}${bad ? `, ${bad} unreadable line(s)` : ''}.${cmpPaid ? ` Where both prices are known: <b>${usd(cmpPaid)}</b> paid vs <b>${usd(cmpCheap)}</b> at the cheapest listed venue.` : ''}</p>`;
  const rows = [...by.entries()].sort((a, b) => (b[1].cost > a[1].cost ? 1 : -1));
  $('tbl').innerHTML = rows.length ? `<thead><tr><th>Model</th><th>Calls</th><th>Cost</th><th>Cheapest listed</th><th>Where</th></tr></thead><tbody>${rows.map(([k, m]) => `<tr><td><code>${esc(k)}</code></td><td class="num">${m.calls}</td><td class="num">${usd(m.cost)}</td><td class="num">${m.cmp ? usd(m.cheap) : '–'}</td><td>${esc([...m.venue.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v)[0] ?? '')}</td></tr>`).join('')}</tbody>` : '';
}

$('file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) render(await f.text(), f.name); });
$('sample').addEventListener('click', async () => { const r = await fetch('sample-calls.jsonl'); render(await r.text(), 'Synthetic sample'); });
