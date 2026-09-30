const TOKEN = process.env.TG_TOKEN || '';
const CHAT_ID = process.env.TG_CHAT || '';
const THRESHOLD = 65, STRONG = 80, RISK_PCT = 1;
const M5 = 300000;
const PAIRS = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD','EURGBP','EURJPY','GBPJPY','AUDJPY','CHFJPY','CADJPY','EURAUD','EURCAD','EURCHF','GBPAUD','GBPCAD','GBPCHF','AUDCAD','AUDCHF','CADCHF'];
const JFILE = 'signals-bo.json';

async function api(m, body) {
  const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/' + m, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return r.json();
}

const send = async (chat, text) => {
  console.log('send to', chat);
  const r = await api('sendMessage', { chat_id: chat, text, parse_mode: 'HTML' });
  console.log('TG:', JSON.stringify(r).slice(0, 100));
};

const fmt5 = p => p >= 100 ? p.toFixed(3) : p.toFixed(5);
const pp = p => p.slice(0, 3) + '/' + p.slice(3);

async function k5(sym) {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '=X?interval=5m&range=30d', { headers: { 'user-agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (!j.chart || !j.chart.result || !j.chart.result[0]) return [];
  const res = j.chart.result[0];
  const q = res.indicators.quote[0];
  const out = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ t: res.timestamp[i] * 1000, o, h, l, c });
  }
  return out;
}

function agg(c, n) {
  const map = new Map();
  for (const x of c) {
    const k = Math.floor(x.t / (n * M5));
    const g = map.get(k);
    if (!g) map.set(k, { t: k * n * M5, o: x.o, h: x.h, l: x.l, c: x.c });
    else { g.h = Math.max(g.h, x.h); g.l = Math.min(g.l, x.l); g.c = x.c; }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function ema(v, p) {
  const k = 2 / (p + 1), o = [v[0]];
  for (let i = 1; i < v.length; i++) o.push(v[i] * k + o[i - 1] * (1 - k));
  return o;
}

function pattern(last, prev) {
  const range = (last.h - last.l) || 1e-9, body = Math.abs(last.c - last.o), up = last.c >= last.o;
  const wU = last.h - Math.max(last.o, last.c), wL = Math.min(last.o, last.c) - last.l;
  if (wL >= 2 * body && wL >= 0.6 * range) return { dir: 1, name: '🔨 Пин-бар (молот)' };
  if (wU >= 2 * body && wU >= 0.6 * range) return { dir: -1, name: '🌠 Пин-бар (вынос)' };
  if (up && prev.c < prev.o && last.c > prev.o && last.o <= prev.c) return { dir: 1, name: '🐂 Бычье поглощение' };
  if (!up && prev.c > prev.o && last.c < prev.o && last.o >= prev.c) return { dir: -1, name: '🐻 Медвежье поглощение' };
  return { dir: 0, name: 'Нет' };
}

function score(c5) {
  const last = c5[c5.length - 1], prev = c5[c5.length - 2];
  const m15 = agg(c5, 3), h1 = agg(c5, 12);
  const cl5 = c5.map(x => x.c), cl15 = m15.map(x => x.c), cl1 = h1.map(x => x.c);
  const i5 = cl5.length - 1, i15 = cl15.length - 1, i1 = cl1.length - 1;
  
  const e5015 = ema(cl15, 50), e20015 = ema(cl15, 200), e501 = ema(cl1, 50), e2001 = ema(cl1, 200);
  const m15up = e5015[i15] > e20015[i15], h1up = e501[i1] > e2001[i1];
  const s1 = (m15up ? 50 : -50) + (h1up ? 50 : -50);
  
  const e20 = ema(cl5, 20), e50 = ema(cl5, 50);
  let s2 = (e20[i5] > e50[i5] ? 40 : -40) + (last.c >= last.o ? 20 : -20);
  
  const sw = [];
  for (let i = 2; i <= i5 - 2; i++) {
    let H = true, L = true;
    for (let j = i - 2; j <= i + 2; j++) {
      if (c5[j].h > c5[i].h) H = false;
      if (c5[j].l < c5[i].l) L = false;
    }
    if (H) sw.push({ t: 'H', p: c5[i].h });
    if (L) sw.push({ t: 'L', p: c5[i].l });
  }
  const sh = sw.filter(w => w.t === 'H').slice(-2), sll = sw.filter(w => w.t === 'L').slice(-2);
  if (sh.length === 2 && sll.length === 2) {
    if (sh[1].p > sh[0].p && sll[1].p > sll[0].p) s2 += 40;
    else if (sh[1].p < sh[0].p && sll[1].p < sll[0].p) s2 -= 40;
  }
  s2 = Math.max(-100, Math.min(100, s2));
  
  const pat = pattern(last, prev);
  let streak = 0;
  for (let i = i5 - 1; i >= Math.max(1, i5 - 4); i--) {
    const d = c5[i].c >= c5[i].o ? 1 : -1;
    if (pat.dir !== 0 && d === -pat.dir) streak++; else break;
  }
  const s3 = pat.dir === 0 ? 0 : pat.dir * (streak >= 3 ? 60 : 35);
  
  const ranges = c5.slice(-21, -1).map(x => x.h - x.l);
  const avgR = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const rNow = last.h - last.l;
  let s4 = 0, squeeze = false;
  if (rNow > 2.5 * avgR) s4 = (last.c >= last.o ? -60 : 60);
  else if (rNow < 0.5 * avgR) squeeze = true;
  
  const total = 0.30 * s1 + 0.25 * s2 + 0.25 * s3 + 0.20 * s4;
  return { total: Math.round(total), s1, s2, s3, s4, squeeze, pat, m15up, h1up };
}

async function newsBlock() {
  let list = [];
  try { list = await (await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json')).json(); } catch (e) { return () => false; }
  const now = Date.now();
  return p => {
    const cur = [p.slice(0, 3), p.slice(3)];
    for (const e of list) {
      if (e.impact !== 'High' || !cur.includes(e.country)) continue;
      if (Math.abs(now - Date.parse(e.date)) < 45 * 60000) return true;
    }
    return false;
  };
}

async function ghLoad() {
  if (!process.env.GITHUB_TOKEN || !process.env.GH_REPO) return { sha: null, data: {} };
  try {
    const r = await fetch('https://api.github.com/repos/' + process.env.GH_REPO + '/contents/' + JFILE, { headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: 'application/vnd.github+json' } });
    if (r.ok) { const j = await r.json(); return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) }; }
    return { sha: null, data: {} };
  } catch (e) { return { sha: null, data: {} }; }
}

async function ghSave(sha, data) {
  try {
    await fetch('https://api.github.com/repos/' + process.env.GH_REPO + '/contents/' + JFILE, { method: 'PUT', headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'content-type': 'application/json' }, body: JSON.stringify({ message: 'bo journal update', content: Buffer.from(JSON.stringify(data)).toString('base64'), sha: sha || undefined }) });
  } catch (e) { console.log('save err', e.message); }
}

function signalText(p, dir, r, E, n) {
  const d = new Date(E);
  const hh = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  const dirText = dir === 1 ? '⬆ ВВЕРХ (CALL)' : '⬇ ВНИЗ (PUT)';
  const expText = n === 1 ? '5 мин (1 свеча) 🔥' : '10 мин (2 свечи)';
  return `🎯 <b>BO СИГНАЛ · M5</b>\n💱 <b>${pp(p)}</b> · ${dirText}\n🕐 Вход: с открытия свечи ${hh} UTC\n⏳ Экспирация: ${expText}\n📊 Уверенность: ${Math.min(99, Math.abs(r.total))}/100\n🧭 M15/H1: ${r.m15up ? '⬆' : '⬇'} / ${r.h1up ? '⬆' : '⬇'}\n🕯 Паттерн: ${r.pat.name}\n🌪 Кламакс: ${r.s4 !== 0 ? 'Да (истощение)' : 'Нет'}\n💰 Ставка: ${RISK_PCT}% депозита\n⚠️ <i>Не финансовая рекомендация</i>`;
}

function resultText(s, entry, exp, win, push, m) {
  const wl = m.win + m.loss;
  const wr = wl ? Math.round(100 * m.win / wl) : 0;
  const resEmoji = push ? '↩️' : (win ? '✅' : '');
  const resText = push ? 'Возврат (цена без изменений)' : (win ? 'WIN' : 'LOSS');
  return ` <b>BO ИТОГ</b>\n💱 ${pp(s.p)} ${s.dir === 1 ? '⬆' : ''}\n💵 Вход: ${fmt5(entry)} → Экспирация: ${fmt5(exp)}\n${resEmoji} <b>${resText}</b>\n📊 Статистика: ${m.win}/${wl} = ${wr}% (безубыток ≈58%)`;
}

async function track() {
  const { sha, data } = await ghLoad();
  if (!data.open) return;
  if (!data.meta) data.meta = { tot: 0, win: 0, loss: 0, push: 0 };
  let changed = false;
  const now = Date.now();
  
  for (const k of Object.keys(data.open)) {
    const s = data.open[k];
    if (now - s.E > 24 * 3600e3) { delete data.open[k]; changed = true; continue; }
    if (now < s.E + s.n * M5 + 60000) continue;
    try {
      const c = await k5(s.p);
      const eC = c.find(x => x.t === s.E);
      const xC = c.find(x => x.t === s.E + (s.n - 1) * M5);
      if (!eC || !xC) continue;
      const entry = eC.o, exp = xC.c;
      const push = exp === entry, win = s.dir === 1 ? exp > entry : exp < entry;
      delete data.open[k];
      data.meta.tot++; if (push) data.meta.push++; else if (win) data.meta.win++; else data.meta.loss++;
      changed = true;
      await send(CHAT_ID, resultText(s, entry, exp, win, push, data.meta));
    } catch (e) { console.log('track err', e.message); }
  }
  if (changed) await ghSave(sha, data);
}

async function fullReport() {
  const news = await newsBlock();
  const hour = new Date().getUTCHours();
  const inSession = hour >= 7 && hour <= 19;
  const now = Date.now();
  
  let report = `📊 <b>ДЕТАЛЬНЫЙ ОТЧЕТ · M5</b>\n`;
  report += ` Время: ${new Date().toISOString().slice(11, 16)} UTC\n`;
  report += `📅 Сессия: ${inSession ? '✅ Активна (07-19 UTC)' : '⚠️ Вне сессии (низкая волатильность)'}\n\n`;
  
  let signals = [], watch = [], skip = [];
  
  for (const p of PAIRS) {
    try {
      const c = await k5(p);
      if (c.length < 50) continue;
      const closed = c.slice(0, -1);
      if (now - closed[closed.length - 1].t > 20 * 60000) continue;
      
      const r = score(closed);
      const blocked = news(p);
      
      if (blocked) {
        skip.push(`📰 <b>${pp(p)}</b> - Важные новости (пропустить)`);
      } else if (r.squeeze) {
        skip.push(`📉 <b>${pp(p)}</b> - Сжатие рынка (нет волатильности)`);
      } else if (Math.abs(r.total) >= THRESHOLD) {
        const dir = r.total > 0 ? 'CALL ⬆' : 'PUT ';
        const exp = Math.abs(r.total) >= STRONG ? '5 мин' : '10 мин';
        signals.push(` <b>${pp(p)}</b> - ВХОДИ СЕЙЧАС (${dir})\n   Уверенность: ${Math.abs(r.total)}% | Экспирация: ${exp}\n   Паттерн: ${r.pat.name}`);
      } else if (Math.abs(r.total) >= 40) {
        const dir = r.total > 0 ? 'CALL' : 'PUT';
        watch.push(`🟡 <b>${pp(p)}</b> - НАБЛЮДАЙ (готовится ${dir})\n   Уверенность: ${Math.abs(r.total)}% (нужно ${THRESHOLD}%)`);
      } else {
        skip.push(`🔴 <b>${pp(p)}</b> - Нет направления (${Math.abs(r.total)}%)`);
      }
    } catch (e) { /* ignore */ }
  }
  
  if (signals.length > 0) report += `━━━━━━━━━━━━━━━━━━━━\n⚡ <b>СИГНАЛЫ СЕЙЧАС (${signals.length})</b>\n━━━━━━━━━━━━━━━━━━━━\n` + signals.join('\n\n') + '\n\n';
  if (watch.length > 0) report += `━━━━━━━━━━━━━━━━━━━━\n👀 <b>НАБЛЮДАТЬ (${watch.length})</b>\n━━━━━━━━━━━━━━━━━━━━\n` + watch.join('\n\n') + '\n\n';
  
  report += `⛔ <b>ПРОПУСТИТЬ (${skip.length} пар)</b>\n`;
  report += `<i>Рынок во флэте, новости или нет четкого направления.</i>\n\n`;
  
  const { data } = await ghLoad();
  const m = data.meta || { win: 0, loss: 0, tot: 0 };
  const wl = m.win + m.loss;
  const wr = wl ? Math.round(100 * m.win / wl) : 0;
  report += `📈 <b>СТАТИСТИКА БОТА</b>\nВсего сделок: ${m.tot}\nWin/Loss: ${m.win}/${m.loss} = <b>${wr}%</b>\n<i>(Цель для безубытка на БО: ≥58%)</i>`;
  
  return report;
}

async function ci() {
  if (!TOKEN || !CHAT_ID) { console.log('no secrets'); return; }
  
  if (process.env.COMMAND === 'report') {
    const report = await fullReport();
    await send(CHAT_ID, report);
    return;
  }

  await track();
  const hour = new Date().getUTCHours();
  if (hour < 7 || hour > 19) { console.log('outside session'); return; }
  
  const news = await newsBlock();
  const now = Date.now();
  const E = Math.ceil(now / M5) * M5;
  const { sha, data } = await ghLoad();
  if (!data.meta) data.meta = { tot: 0, win: 0, loss: 0, push: 0 };
  let changed = false;
  
  for (const p of PAIRS) {
    try {
      const c = await k5(p);
      const closed = c.slice(0, -1);
      if (now - closed[closed.length - 1].t > 20 * 60000) continue;
      
      const r = score(closed);
      if (r.squeeze) continue;
      
      const dir = r.total >= THRESHOLD ? 1 : r.total <= -THRESHOLD ? -1 : 0;
      if (!dir) continue;
      if (news(p)) { console.log('news block', p); continue; }
      
      data.open = data.open || {};
      if (data.open[p]) continue;
      
      const n = Math.abs(r.total) >= STRONG ? 1 : 2; 
      
      await send(CHAT_ID, signalText(p, dir, r, E, n));
      data.open[p] = { p, dir, E, n };
      changed = true;
    } catch (e) { console.log(p, e.message); }
  }
  if (changed) await ghSave(sha, data);
}

ci().then(() => { console.log('bo done'); process.exit(0); }).catch(e => { console.log(e); process.exit(0); });
