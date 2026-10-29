// бот прокачки: приветствие на /start, напоминания и синхронизация данных приложения между устройствами.
// токен в секрете BOT_TOKEN, настройки напоминаний в KV USERS, данные приложения в базе D1 (привязка DB).
const APP = "https://prokachka.pages.dev";
const BOT_V = "v35"; // версия бота: видно по адресу /v, чтобы проверить, что выложилась свежая
const OWNER = 424765559; // telegram id владельца: ему приложение показывает статистику
const HELLO = [
  "о, наконец-то ты тут! рад тебя видеть! скорее жми кнопку, давай превратим жизнь в игру",
  "юху, ты пришел! жми кнопку, начинаем апгрейдиться",
  "привет! тут всё, что ты делаешь, превращается в опыт. жми кнопку и посмотрим, какой у тебя уровень",
  "и снова здравствуй, игрок! жми кнопку, пора ступить на тропу героя",
];
const REMIND = [
  "ну хотя бы пять минуточек. загляни в прокачку: начни с небольшого дела",
  "сегодня в прокачке так пусто без тебя :(",
  "день ещё не закончился, поднажми",
  "пссс.. на доске объявлений все ещё висит квест для тебя",
  "лучше неидеальное действие, чем идеальное бездействие. газ?",
];
const pick = a => a[Math.floor(Math.random() * a.length)];
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then(r => r.json()).catch(() => ({ ok: false }));

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const hmac = async (key, msg) => {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
};
async function hookPath(env) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("prokachka:" + env.BOT_TOKEN));
  return "/hook/" + hex(d).slice(0, 24);
}
// проверка подписи telegram: так убеждаемся, что запрос пришёл из настоящего приложения и от этого человека
async function checkInitData(env, initData) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash"); p.delete("hash");
  if (!hash) return null;
  const dcs = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
  const secret = await hmac("WebAppData", env.BOT_TOKEN);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") || 0);
  if (!(age < 60 * 60 * 24 * 30)) return null;
  try { return JSON.parse(p.get("user")).id; } catch (e) { return null; }
}
// то же, но возвращает человека целиком: имя и фото для командных квестов
async function checkUser(env, initData) {
  const id = await checkInitData(env, initData);
  if (!id) return null;
  try { const u = JSON.parse(new URLSearchParams(initData).get("user")); return { id, name: cut([u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "игрок", 40), photo: /^https:\/\//.test(u.photo_url || "") ? u.photo_url : "", username: cut(u.username, 40) }; } catch (e) { return { id, name: "игрок", photo: "", username: "" }; }
}
const localNow = tz => {
  const d = new Date(Date.now() + (Number(tz) || 0) * 60000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
};

// во сколько напоминать: первое время и ещё 1-2 через равные промежутки в течение дня
const timesFor = (start, count) => {
  const step = count === 2 ? 5 : count === 3 ? 4 : 0;
  const out = [];
  for (let i = 0; i < count; i++) { const h = start + i * step; if (h <= 23) out.push(h); }
  return out;
};
const hh = h => String(h).padStart(2, "0") + ":00";
const cut = (x, n) => String(x || "").replace(/\s+/g, " ").trim().slice(0, n);
const appBtn = text => ({ inline_keyboard: [[{ text, web_app: { url: APP } }]] });
const offerText = "после того, как ты начнёшь вносить дела в свой список, я смогу время от времени напоминать тебе о них. давай выберем время и регулярность этих напоминаний. сколько раз в день?";
const offerKb = { inline_keyboard: [[
  { text: "1 раз", callback_data: "n:1" }, { text: "2 раза", callback_data: "n:2" }, { text: "3 раза", callback_data: "n:3" },
], [{ text: "не надо", callback_data: "n:0" }]] };
const hoursKb = { inline_keyboard: [
  [8, 10, 12].map(h => ({ text: hh(h), callback_data: "t:" + h })),
  [15, 18, 20].map(h => ({ text: hh(h), callback_data: "t:" + h })),
  [{ text: "22:00", callback_data: "t:22" }],
] };

function reminderText(r) {
  const todo = (r.todo || []).filter(Boolean);
  const head = pick(REMIND);
  const lines = [];
  if (r.quest) lines.push("главное на сегодня: " + r.quest);
  if (todo.length) lines.push((r.quest ? "ещё в планах:\n" : "в планах на сегодня:\n") + todo.slice(0, 10).map(t => "• " + t).join("\n"));
  return lines.length ? lines.join("\n\n") : head;
}

const defRec = () => ({ on: false, hour: 20, count: 1, times: [], tz: 0, last: "", todo: [], quest: "", sent: { d: "", h: [] }, offered: false, cfg: false, rep: true, wkOn: true, first: "", dd: [], prof: [], day: null, wk: null, jn: 0 });
const shiftDate = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
const shareBtn = text => ({ text: "поделиться", url: "https://t.me/share/url?url=" + encodeURIComponent("https://t.me/prokachkaaa_bot") + "&text=" + encodeURIComponent(text) });

// итоги дня: что сделано сегодня. если пусто, мягко зовём вернуться
function dayText(r, date) {
  const d = r.day && r.day.d === date ? r.day : null;
  const items = d ? (d.items || []) : [];
  if (!d || (!items.length && !d.rt)) return null;
  const L = ["итоги дня", ""];
  items.forEach(i => L.push("• " + i.t + " +" + i.x));
  if (d.more > 0) L.push("• ещё " + d.more + " " + plural(d.more, "дело", "дела", "дел"));
  if (d.rt > 0) L.push("рутина ×" + d.rt);
  L.push("", "всего +" + d.xp + " опыта");
  return L.join("\n");
}
const MISS = "давно тебя не видел, уже соскучился 💔";
function weekText(r, date) {
  const w = r.wk;
  if (!w || !w.n || !r.seen || r.seen < shiftDate(date, -1)) return "итоги недели\n\nна этой неделе было тихо. загляни в прокачку и начни с маленького дела";
  const L = ["итоги недели", "", "+" + w.xp + " опыта · " + w.n + " " + plural(w.n, "дело", "дела", "дел") + " · активных дней: " + w.days + " из 7"];
  if (w.top) L.push("сильнее всего росла: " + w.top);
  L.push("уровень " + w.lvl + (w.st > 1 ? " · серия " + w.st + " " + plural(w.st, "день", "дня", "дней") : ""));
  return L.join("\n");
}
const repKb = (kind, text) => ({ inline_keyboard: [
  [{ text: "открыть прокачку", web_app: { url: APP } }].concat(kind === "wk" ? [shareBtn(text)] : []),
  [{ text: kind === "wk" ? "не присылать итоги недели" : "не присылать итоги дня", callback_data: "x:" + kind }],
] });
const statsPath = async env => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("stats:" + env.BOT_TOKEN));
  return "/stats/" + hex(d).slice(0, 20);
};
async function statsPage(env, asJson) {
  const today = new Date().toISOString().slice(0, 10);
  const days = Array.from({ length: 14 }, (_, i) => shiftDate(today, i - 13));
  const act = Object.fromEntries(days.map(d => [d, 0])), neu = Object.fromEntries(days.map(d => [d, 0]));
  const profs = {};
  let total = 0, w7 = 0, back = 0, rem = 0, rep = 0, blocked = 0;
  let cursor;
  do {
    const l = await env.USERS.list({ prefix: "u:", cursor });
    for (const k of l.keys) {
      const r = await env.USERS.get(k.name, "json"); if (!r) continue;
      total++;
      const dd = r.dd || [];
      if (dd.some(d => d >= shiftDate(today, -6))) w7++;
      if (dd.length >= 2) back++;
      if (r.on) rem++;
      if (r.on && r.rep !== false) rep++;
      if (r.err) blocked++;
      dd.forEach(d => { if (d in act) act[d]++; });
      if (r.first && r.first in neu) neu[r.first]++;
      (r.prof || []).forEach(p => profs[p] = (profs[p] || 0) + 1);
    }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  const pct = (a, b) => b ? Math.round(a * 100 / b) + "%" : "0%";
  if (asJson) return { total, w7, back, rem, rep, blocked, days: days.map(d => [d.slice(8), act[d]]), profs: Object.entries(profs).sort((a, b) => b[1] - a[1]).slice(0, 14) };
  const max = Math.max(1, ...days.map(d => act[d]));
  const bars = days.map(d => `<div class="b"><i style="height:${Math.round(act[d] / max * 100)}%"></i><s>${act[d]}</s><u>${d.slice(8)}</u></div>`).join("");
  const PN = { design: "дизайнер", dev: "разработчик", ai: "нейросети и ии", mkt: "маркетолог", creator: "автор контента", biz: "предприниматель", law: "юрист", med: "врач", teach: "преподаватель", stud: "студент", beauty: "мастер бьюти", coach: "тренер", parent: "родитель", other: "другое" };
  const pl = Object.entries(profs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li><span>${PN[k] || k}</span><b>${v}</b></li>`).join("") || "<li><span>пока нет данных</span></li>";
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>прокачка: статистика</title>
<style>body{margin:0;padding:24px 16px;background:#14121a;color:#f2eef8;font:16px/1.5 system-ui,sans-serif}main{max-width:560px;margin:0 auto}h1{font-size:22px;margin:0 0 16px;font-weight:600}
.g{display:grid;grid-template-columns:1fr 1fr;gap:10px}.c{background:#1e1b27;border-radius:14px;padding:14px}.c b{display:block;font-size:28px}.c span{color:#a79fb8;font-size:13px}
h2{font-size:15px;color:#a79fb8;margin:24px 0 8px;font-weight:500}.bars{display:flex;gap:4px;align-items:flex-end;height:120px;background:#1e1b27;border-radius:14px;padding:12px 10px 0}
.b{flex:1;height:100%;position:relative;display:flex;align-items:flex-end}.b i{display:block;width:100%;background:#b28dff;border-radius:4px 4px 0 0;min-height:2px}.b s{position:absolute;top:-2px;width:100%;text-align:center;font-size:10px;text-decoration:none;color:#a79fb8}
.b u{position:absolute;bottom:-18px;width:100%;text-align:center;font-size:10px;text-decoration:none;color:#a79fb8}ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;background:#1e1b27;border-radius:10px;padding:8px 12px;margin-bottom:6px}</style>
<main><h1>прокачка: статистика</h1><div class=g>
<div class=c><b>${total}</b><span>зашли всего</span></div><div class=c><b>${w7}</b><span>активны за 7 дней</span></div>
<div class=c><b>${pct(back, total)}</b><span>вернулись (${back})</span></div><div class=c><b>${rem}</b><span>включили напоминания</span></div>
<div class=c><b>${rep}</b><span>получают итоги</span></div><div class=c><b>${blocked}</b><span>бот не достучался</span></div></div>
<h2>активные по дням, 14 дней</h2><div class=bars>${bars}</div><div style="height:22px"></div>
<h2>чем занимаются</h2><ul>${pl}</ul>
<p style="color:#6e6781;font-size:12px;margin-top:24px">активность считается с момента обновления бота, раньше не записывалась.</p></main>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
// приложение закрыли: если человек ещё не настраивал напоминания, предлагаем это в чате (один раз)
async function offerIfNeeded(env, uid, tz) {
  const key = "u:" + uid;
  const old = await env.USERS.get(key, "json");
  const r = Object.assign(defRec(), old || {});
  if (r.offered || r.cfg) return r;
  if (tz !== undefined) r.tz = tz;
  const res = await tg(env, "sendMessage", { chat_id: uid, text: offerText, reply_markup: offerKb });
  r.offered = !!res.ok; r.err = res.ok ? "" : String(res.description || "fail");
  await env.USERS.put(key, JSON.stringify(r));
  return r;
}

// сколько всего людей: считаем только ключи, значения не читаем, поэтому дёшево
async function userCount(env) {
  let n = 0, cursor;
  do { const l = await env.USERS.list({ prefix: "u:", cursor }); n += l.keys.length; cursor = l.list_complete ? undefined : l.cursor; } while (cursor);
  return n;
}
// новый человек открыл приложение в первый раз: короткое уведомление владельцу
async function notifyJoin(env, u, r) {
  if (!u || u.id === OWNER) return;
  const who = (u.name || "игрок") + (u.username ? " @" + u.username : "");
  const rem = r.cfg ? (r.on ? "включены" : "отключены") : "ещё не выбраны";
  let tail = "";
  try { const n = await userCount(env); tail = "\nвсего людей в прокачке: " + n; } catch (e) {}
  await tg(env, "sendMessage", {
    chat_id: OWNER,
    text: "✨ новый человек в прокачке\n\n" + who + "\nid " + u.id + "\nнапоминания: " + rem + tail,
    reply_markup: { inline_keyboard: [[{ text: "написать", url: u.username ? "https://t.me/" + u.username : "tg://user?id=" + u.id }]] },
    disable_notification: false,
  });
}

// рассылка: черновик лежит в KV под ключом bc:cur, отправка идёт пачками (лимит бесплатного cloudflare: ~45 внешних запросов за запуск)
const NEWS_KB = { inline_keyboard: [[{ text: "открыть прокачку", web_app: { url: APP } }], [{ text: "не присылать новости", callback_data: "x:news" }]] };
const BC_KB = { inline_keyboard: [[{ text: "отправить всем", callback_data: "b:go" }, { text: "отмена", callback_data: "b:no" }]] };
// поддержка: человек пишет боту, сообщения и скрины уходят владельцу, ответ реплаем возвращается человеку
const SUP_TTL = 30 * 60 * 1000;
const SUP_TEXT = "это поддержка прокачки 🛟\n\nнапиши, что случилось или что хочется улучшить, и приложи скриншоты, если есть. всё, что пришлёшь сюда в ближайшие 30 минут, я передам лично создательнице приложения. она читает каждое сообщение: исправляет ошибки и учитывает идеи в следующих обновлениях.\n\nчто уйдёт: только то, что ты сюда напишешь или пришлёшь, и твоё имя в телеграме, чтобы можно было ответить. данные из приложения не отправляются.\n\nответ придёт сюда, в этот чат. когда закончишь, нажми «готово».";
const SUP_KB = { inline_keyboard: [[{ text: "готово", callback_data: "sup:off" }]] };
const menuKb = r => ({ inline_keyboard: [[{ text: "открыть прокачку", web_app: { url: APP } }], [{ text: "события за 48 часов", callback_data: "ev:menu" }], [{ text: "написать в поддержку", callback_data: "sup:on" }], [r && r.news === false ? { text: "снова присылать новости", callback_data: "nw:on" } : { text: "не присылать новости", callback_data: "x:news" }]] });

// календарь владельца: присылаешь боту .ics, события копятся в kv и отдаются живой лентой, на которую айфон подписывается один раз
const calKey = async env => { let k = await env.USERS.get("cal:key"); if (!k) { k = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, "0")).join(""); await env.USERS.put("cal:key", k); } return k; };
function icsParse(t) {
  t = t.replace(/\r?\n[ \t]/g, "");
  const tz = (t.match(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/g) || []).map(x => x.replace(/\r?\n/g, "\r\n"));
  const ev = (t.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || []).map(b => { const m = b.match(/^UID:(.+)$/m); return m ? { uid: m[1].trim(), body: b.replace(/\r?\n/g, "\r\n") } : null; }).filter(Boolean);
  return { tz, ev };
}
async function calSave(env, text) {
  const p = icsParse(text); if (!p.ev.length) return 0;
  const cur = await env.USERS.get("cal:data", "json") || { tz: [], ev: {} };
  for (const e of p.ev) cur.ev[e.uid] = e.body;
  for (const z of p.tz) { const id = (z.match(/TZID:(.+)/) || [])[1]; if (id && !cur.tz.some(x => x.includes("TZID:" + id))) cur.tz.push(z); }
  await env.USERS.put("cal:data", JSON.stringify(cur));
  return p.ev.length;
}
async function calFeed(env) {
  const d = await env.USERS.get("cal:data", "json") || { tz: [], ev: {} };
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//prokachka//calendar//RU", "CALSCALE:GREGORIAN", "X-WR-CALNAME:прокачка", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"].concat(d.tz, Object.values(d.ev), ["END:VCALENDAR"]).join("\r\n") + "\r\n";
}
async function calLinks(env, origin) {
  const k = await calKey(env), n = Object.keys((await env.USERS.get("cal:data", "json") || { ev: {} }).ev).length;
  return "📅 календарь\nсобытий в ленте: " + n + "\n\nподписка (один раз, потом обновляется сама): открой в safari на айфоне\n" + origin + "/cal/" + k + "/go\n\nпросто добавить события один раз (без подписки):\n" + origin + "/cal/" + k + ".ics\n\nчтобы добавить новые события, пришли мне сюда .ics файлом: они допишутся в ленту.";
}

// текстовые команды календаря без нейросетей: /add 24.11 18:30 эфир 2ч !1ч, /list, /del 3
const MSK = 3 * 3600000;
const MONTHS = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const p2 = n => String(n).padStart(2, "0");
const icsEsc = t => t.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const fmtL = d => "" + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + "T" + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + "00";
const fmtD = d => "" + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate());
function parseEv(line) {
  let t = line.trim().replace(/^[-—•*]\s*/, ""); if (!t) return null;
  let dd, mm, yy, m;
  if ((m = t.match(/^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?(?=\s|$)\s*/))) { dd = +m[1]; mm = +m[2]; yy = m[3] ? +m[3] : 0; }
  else if ((m = t.match(/^(\d{1,2})\s+([а-яё]+)\s*/i))) { const i = MONTHS.findIndex(x => m[2].toLowerCase().startsWith(x)); if (i < 0) return { err: "не поняла дату в строке: " + line }; dd = +m[1]; mm = i + 1; yy = 0; }
  else return { err: "не поняла дату в строке: " + line };
  t = t.slice(m[0].length);
  if (yy && yy < 100) yy += 2000;
  const now = new Date(Date.now() + MSK);
  if (!yy) { yy = now.getUTCFullYear(); const cand = Date.UTC(yy, mm - 1, dd); if (cand < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86400000) yy++; }
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return { err: "не поняла дату в строке: " + line };
  let hh = null, mi = 0;
  if ((m = t.match(/^(?:в\s+)?(\d{1,2})[:.](\d{2})(?=\s|$)\s*/i))) { hh = +m[1]; mi = +m[2]; t = t.slice(m[0].length); if (hh > 23 || mi > 59) return { err: "не поняла время в строке: " + line }; }
  let alarm = null;
  if ((m = t.match(/(?:^|\s)!\s*(нет|0|(\d+(?:[.,]\d+)?)\s*(мин\w*|ч\w*|д\w*))(?=\s|$)/i))) {
    if (/^(нет|0)$/i.test(m[1])) alarm = 0; else { const n = parseFloat(m[2].replace(",", ".")), u = m[3].toLowerCase(); alarm = Math.round(n * (u.startsWith("м") ? 1 : u.startsWith("ч") ? 60 : 1440)); }
    t = t.replace(m[0], " ");
  }
  let dur = 60;
  if (hh !== null && (m = t.match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s?(ч|час|часа|часов|мин)(?=\s|$)/i))) { const n = parseFloat(m[1].replace(",", ".")); dur = Math.round(n * (m[2].toLowerCase() === "мин" ? 1 : 60)); t = t.replace(m[0], " "); }
  const title = t.replace(/\s+/g, " ").trim() || "событие";
  const uid = "tg" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + "@prokachka";
  const L = ["BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:" + fmtL(new Date()) .slice(0, 15) + "Z", "SUMMARY:" + icsEsc(title)];
  let when;
  if (hh === null) {
    const s0 = new Date(Date.UTC(yy, mm - 1, dd)), e0 = new Date(Date.UTC(yy, mm - 1, dd + 1));
    L.push("DTSTART;VALUE=DATE:" + fmtD(s0), "DTEND;VALUE=DATE:" + fmtD(e0));
    when = p2(dd) + "." + p2(mm) + "." + yy + " весь день";
    if (alarm === null) alarm = -540; // 9:00 в день события
  } else {
    const s0 = new Date(Date.UTC(yy, mm - 1, dd, hh, mi)), e0 = new Date(s0.getTime() + dur * 60000);
    L.push("DTSTART;TZID=Europe/Moscow:" + fmtL(s0), "DTEND;TZID=Europe/Moscow:" + fmtL(e0));
    when = p2(dd) + "." + p2(mm) + "." + yy + " " + p2(hh) + ":" + p2(mi);
    if (alarm === null) alarm = 60;
  }
  if (alarm) L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEsc(title), "TRIGGER:" + (alarm > 0 ? "-PT" + alarm + "M" : "PT" + (-alarm) + "M"), "END:VALARM");
  L.push("END:VEVENT");
  return { uid, body: L.join("\r\n"), title, when };
}
const MSK_TZ = "BEGIN:VTIMEZONE\r\nTZID:Europe/Moscow\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0300\r\nTZOFFSETTO:+0300\r\nTZNAME:MSK\r\nEND:STANDARD\r\nEND:VTIMEZONE";
async function calAdd(env, text) {
  const cur = await env.USERS.get("cal:data", "json") || { tz: [], ev: {} };
  if (!cur.tz.some(x => x.includes("TZID:Europe/Moscow"))) cur.tz.push(MSK_TZ);
  const ok = [], bad = [];
  for (const line of text.split(/\r?\n/)) { if (!line.trim()) continue; const e = parseEv(line); if (!e) continue; if (e.err) bad.push(e.err); else { cur.ev[e.uid] = e.body; ok.push(e.when + " · " + e.title); } }
  if (ok.length) await env.USERS.put("cal:data", JSON.stringify(cur));
  return { ok, bad };
}
function evInfo(body) {
  const g = re => { const m = body.match(re); return m ? m[1] : ""; };
  const st = g(/^DTSTART[^:\r\n]*:(\d{8}(?:T\d{6})?)/m), title = g(/^SUMMARY:(.*)$/m).replace(/\\([,;])/g, "$1").replace(/\\n/g, " ");
  const d = st.slice(6, 8) + "." + st.slice(4, 6) + "." + st.slice(0, 4), tm = st.length > 8 ? " " + st.slice(9, 11) + ":" + st.slice(11, 13) : " весь день";
  return { key: st.slice(0, 8) + (st.slice(9, 13) || "0000"), text: d + tm + " · " + title };
}
async function calList(env) {
  const cur = await env.USERS.get("cal:data", "json") || { tz: [], ev: {} };
  const now = new Date(Date.now() + MSK), today = fmtD(now);
  const rows = Object.entries(cur.ev).map(([uid, b]) => ({ uid, ...evInfo(b) })).filter(r => r.key.slice(0, 8) >= today).sort((a, b) => a.key < b.key ? -1 : 1);
  await env.USERS.put("cal:list", JSON.stringify(rows.map(r => r.uid)), { expirationTtl: 86400 });
  return rows.length ? rows.map((r, i) => (i + 1) + ". " + r.text).join("\n") + "\n\nчтобы удалить: /del 2 (можно несколько: /del 1 3)" : "ближайших событий нет. добавить: /add 24.11 18:30 эфир";
}
async function calDel(env, nums) {
  const ids = await env.USERS.get("cal:list", "json");
  if (!ids) return "сначала пришли /list, чтобы я знала номера";
  const cur = await env.USERS.get("cal:data", "json") || { tz: [], ev: {} }, gone = [];
  for (const n of nums) { const uid = ids[n - 1]; if (uid && cur.ev[uid]) { gone.push(evInfo(cur.ev[uid]).text); delete cur.ev[uid]; } }
  if (!gone.length) return "не нашла события с такими номерами. пришли /list";
  await env.USERS.put("cal:data", JSON.stringify(cur)); await env.USERS.delete("cal:list");
  return "удалила:\n" + gone.join("\n") + "\n\nномера сбросились, пришли /list ещё раз";
}
const CAL_HELP = "📅 как добавить событие:\n/add 24.11 18:30 эфир с куратором\n\nможно несколько, каждое с новой строки:\n/add\n23.10 11:00 эфир\n26.11 23:59 дедлайн проекта\n\nформаты: дата 24.11 или 24 ноября (год по желанию), время 18:30 (без времени = на весь день). длительность: 2ч или 90мин (по умолчанию 1 час). напоминание: !30мин, !2ч, !1д или !нет (по умолчанию за час, а для события на весь день в 9:00).";
async function setCommands(env) {
  if (await env.USERS.get("cmds:" + BOT_V)) return;
  await tg(env, "setMyCommands", { commands: [{ command: "menu", description: "меню" }, { command: "events", description: "события за 48 часов" }, { command: "support", description: "написать в поддержку" }, { command: "start", description: "открыть прокачку" }] });
  await tg(env, "setMyCommands", { scope: { type: "chat", chat_id: OWNER }, commands: [{ command: "menu", description: "меню" }, { command: "events", description: "события за 48 часов" }, { command: "support", description: "написать в поддержку" }, { command: "send", description: "рассылка новостей" }, { command: "stats", description: "статистика" }, { command: "calendar", description: "календарь для айфона" }, { command: "add", description: "добавить событие в календарь" }, { command: "list", description: "ближайшие события" }, { command: "del", description: "удалить событие по номеру" }, { command: "start", description: "открыть прокачку" }] });
  await env.USERS.put("cmds:" + BOT_V, "1");
}
async function supStart(env, chat, rec) {
  rec.sup = Date.now(); rec.supId = rec.sup; await env.USERS.put("u:" + chat, JSON.stringify(rec));
  await tg(env, "sendMessage", { chat_id: chat, text: SUP_TEXT, reply_markup: SUP_KB });
}
async function supStop(env, chat, rec, quiet) {
  const had = rec.sup; rec.sup = 0; await env.USERS.put("u:" + chat, JSON.stringify(rec));
  if (!quiet) await tg(env, "sendMessage", { chat_id: chat, text: had && rec.supHdr === rec.supId ? "спасибо! всё передала. если ответят, сообщение придёт сюда. написать ещё — /support" : "хорошо. написать в поддержку можно в любой момент — /support", reply_markup: { inline_keyboard: [[{ text: "открыть прокачку", web_app: { url: APP } }]] } });
}
async function supForward(env, m, rec) {
  const chat = m.chat.id; const now = Date.now();
  if (rec.supHdr !== rec.supId) {
    const who = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") + (m.from.username ? " @" + m.from.username : "") + " · id " + m.from.id;
    const h = await tg(env, "sendMessage", { chat_id: OWNER, text: "📩 обращение в поддержку\nот: " + who + "\n\nчтобы ответить, сделай reply на любое сообщение ниже: я перешлю ответ человеку." });
    if (h.ok) await env.USERS.put("sr:" + h.result.message_id, String(chat), { expirationTtl: 2592000 });
    rec.supHdr = rec.supId;
  }
  const c = await tg(env, "copyMessage", { chat_id: OWNER, from_chat_id: chat, message_id: m.message_id });
  if (c.ok) await env.USERS.put("sr:" + c.result.message_id, String(chat), { expirationTtl: 2592000 });
  rec.sup = now;
  const ack = !rec.supAck || now - rec.supAck > 15000; if (ack) rec.supAck = now;
  await env.USERS.put("u:" + chat, JSON.stringify(rec));
  if (ack) await tg(env, "sendMessage", { chat_id: chat, text: c.ok ? "получила и передала ✅ можно дослать ещё скрины или текст. когда всё, нажми «готово»." : "не получилось передать, попробуй ещё раз чуть позже.", reply_markup: SUP_KB });
}
// длинный текст режем на сообщения до 4096 знаков по абзацам, форматирование (жирный и т.п.) переносим
function bcParts(text, ents) {
  const out = []; let pos = 0; const L = 4000;
  while (pos < text.length) {
    let end = Math.min(text.length, pos + L);
    if (end < text.length) { const cut = Math.max(text.lastIndexOf("\n\n", end), text.lastIndexOf("\n", end)); if (cut > pos + 500) end = cut; else { const sp = text.lastIndexOf(" ", end); if (sp > pos + 500) end = sp; } }
    const t = text.slice(pos, end);
    const en = (ents || []).filter(x => x.offset >= pos && x.offset + x.length <= end).map(x => Object.assign({}, x, { offset: x.offset - pos }));
    if (t.trim()) out.push({ text: t, entities: en });
    pos = end; while (text[pos] === "\n") pos++;
  }
  return out;
}
const CAP = 1024;
// одна рассылка одному человеку: картинки/видео, текст подписью если влезает, иначе отдельным сообщением следом
async function bcSend(env, chat, b, kb) {
  const text = (b.text || "").trim() ? b.text : "";
  const ents = b.ents || [];
  const fits = text && text.length <= CAP;
  const parts = text && !fits ? bcParts(text, ents) : [];
  const last = !parts.length;
  let first = null;
  const keep = r => { if (!first) first = r; return r; };
  if (b.type === "photo" || b.type === "animation" || b.type === "video") {
    const m = b.type === "photo" ? "sendPhoto" : b.type === "animation" ? "sendAnimation" : "sendVideo";
    const body = { chat_id: chat, [b.type]: b.file };
    if (fits) { body.caption = text; if (ents.length) body.caption_entities = ents; }
    if (last) body.reply_markup = kb;
    keep(await tg(env, m, body));
  } else if (b.type === "album") {
    const items = b.media || (b.files || [b.file]).filter(Boolean).map(f => ({ t: "photo", f }));
    const media = items.map((x, i) => i === 0 && fits ? Object.assign({ type: x.t, media: x.f, caption: text }, ents.length ? { caption_entities: ents } : {}) : { type: x.t, media: x.f });
    keep(await tg(env, "sendMediaGroup", { chat_id: chat, media }));
    if (!first.ok) return first;
    if (last) await tg(env, "sendMessage", { chat_id: chat, text: "что нового в прокачке ↑", reply_markup: kb });
  } else if (!parts.length) {
    keep(await tg(env, "sendMessage", Object.assign({ chat_id: chat, text: text || " ", reply_markup: kb }, ents.length ? { entities: ents } : {})));
  }
  if (first && !first.ok) return first;
  for (let i = 0; i < parts.length; i++) {
    const body = { chat_id: chat, text: parts[i].text };
    if (parts[i].entities.length) body.entities = parts[i].entities;
    if (i === parts.length - 1) body.reply_markup = kb;
    keep(await tg(env, "sendMessage", body));
  }
  return first || { ok: false };
}
// альбом: телеграм присылает каждое фото отдельным сообщением. копим их в D1 (там нет задержки, как у списка KV),
// первое сообщение группы «забирает» сборку и через 4 секунды собирает пост целиком
async function bcpInit(env) { await env.DB.prepare("CREATE TABLE IF NOT EXISTS bcp (gid TEXT NOT NULL, mid INTEGER NOT NULL, kind TEXT, file TEXT, cap TEXT, ents TEXT, PRIMARY KEY (gid, mid))").run(); }
// что за медиа в сообщении: фото, видео или картинка, отправленная файлом (без сжатия)
function mediaOf(m) {
  if (m.photo && m.photo.length) return { kind: "photo", file: m.photo[m.photo.length - 1].file_id };
  if (m.video) return { kind: "video", file: m.video.file_id };
  if (m.document && /^(image|video)\//.test(m.document.mime_type || "")) return { kind: "document", file: m.document.file_id };
  return null;
}
let bcpReady = false;
async function bcpAdd(env, m, gid) {
  if (!bcpReady) { await bcpInit(env); bcpReady = true; }
  const md = mediaOf(m) || { kind: "", file: "" };
  // одним запросом: само фото и «заявка» на сборку. меньше обращений к базе, значит фото альбома доезжают быстрее
  const r = await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO bcp (gid, mid, kind, file, cap, ents) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(gid, m.message_id, md.kind, md.file, m.caption || "", JSON.stringify(m.caption_entities || [])),
    env.DB.prepare("INSERT OR IGNORE INTO bcp (gid, mid, kind) VALUES (?1, -1, 'claim')").bind(gid),
  ]);
  const c = r && r[1];
  return !!(c && c.meta && c.meta.changes);
}
const albumRows = async (env, gid) => (await env.DB.prepare("SELECT mid, kind, file, cap, ents FROM bcp WHERE gid = ?1 AND mid >= 0 ORDER BY mid").bind(gid).all()).results || [];
async function albumFlow(env, chat, gid) {
  // ждём, пока телеграм доставит все фото: собираем, пока новые приходят, и идём дальше после 3 секунд тишины (но не дольше 22 секунд)
  const t0 = Date.now(); let n = -1, still = 0, rows = [];
  await new Promise(r => setTimeout(r, 2500));
  while (Date.now() - t0 < 22000) {
    rows = await albumRows(env, gid);
    if (rows.length === n) { still += 1; if (still >= 2) break; } else { n = rows.length; still = 0; }
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!rows.length) return;
  const loose = gid.startsWith("d:");
  const capRow = rows.find(r => /^\/send(@\w+)?(\s|$)/.test(r.cap || "")) || null;
  const cur = await env.USERS.get("bc:cur", "json");
  if (cur && cur.state === "sending") { await tg(env, "sendMessage", { chat_id: chat, text: "прошлая рассылка ещё идёт, подожди отчёта." }); return; }
  const fresh = cur && cur.state === "draft" && Date.now() - parseInt(cur.id, 36) < 3600000;
  // для фото, присланных по одному, берём текст черновика, даже если к нему уже прилипла первая картинка
  const draftText = fresh && cur.text && (cur.type === "text" || loose) ? cur : null;
  const prevMedia = loose && fresh && cur.type !== "text" ? (cur.media || (cur.files || [cur.file]).filter(Boolean).map(f => ({ t: cur.type === "video" ? "video" : "photo", f }))) : [];
  let text = "", ents = [];
  if (capRow) {
    const raw = capRow.cap; const pre = raw.length - raw.replace(/^\/send(@\w+)?\s*/, "").length;
    text = raw.slice(pre).replace(/\s+$/, "");
    ents = JSON.parse(capRow.ents || "[]").filter(x => x.offset >= pre && x.offset + x.length <= pre + text.length && x.type !== "bot_command").map(x => Object.assign({}, x, { offset: x.offset - pre }));
    if (!text && draftText) { text = draftText.text; ents = draftText.ents || []; }
  } else if (draftText) { text = draftText.text; ents = draftText.ents || []; }
  else {
    await tg(env, "sendMessage", { chat_id: chat, text: "вижу альбом. чтобы сделать из него рассылку, начни подпись с /send или сначала пришли /send и текст, а потом картинки." });
    return;
  }
  let all = prevMedia.concat(rows.filter(r => r.file).map(r => ({ t: r.kind || "photo", f: r.file })));
  // телеграм не смешивает в одном альбоме файлы с фото и видео: если прислали вперемешку, оставляем фото и видео
  const docs = all.filter(x => x.t === "document"), vis = all.filter(x => x.t !== "document");
  let note = "";
  if (docs.length && vis.length) { all = vis; note = "\n(часть картинок пришла файлами, а часть фото. телеграм не собирает их в один альбом, поэтому взяла только фото. пришли всё одинаково: лучше фото, со сжатием)"; }
  const items = all.slice(0, 10);
  if (!items.length) return;
  const one = items.length === 1 && items[0].t !== "document";
  const b = { id: Date.now().toString(36), text, ents, type: one ? (items[0].t === "video" ? "video" : "photo") : "album", file: items[0].f, media: items, files: items.map(x => x.f), state: "draft", ok: 0, fail: 0, skip: 0 };
  await env.USERS.put("bc:cur", JSON.stringify(b));
  await tg(env, "sendMessage", { chat_id: chat, text: "так увидят люди" + (all.length > 10 ? " (взяла первые 10 из " + all.length + ", больше телеграм в один пост не пускает)" : "") + note + (text.length > CAP ? "\n(текст длиннее подписи в 1024 знака, это предел телеграма. поэтому он придёт отдельным сообщением сразу под картинками. чтобы был один пост, сократи текст до 1024 знаков)" : "") });
  await bcSend(env, chat, b, BC_KB);
}
async function bcRun(env) {
  const b = await env.USERS.get("bc:cur", "json");
  if (!b || b.state !== "sending") return;
  if (b.lock && Date.now() - b.lock < 55000) return; // другая пачка ещё идёт
  b.lock = Date.now(); await env.USERS.put("bc:cur", JSON.stringify(b));
  let budget = 40, left = false, cursor;
  outer: do {
    const l = await env.USERS.list({ prefix: "u:", cursor });
    for (const k of l.keys) {
      const r = await env.USERS.get(k.name, "json");
      if (!r || r.bc === b.id) continue;
      if (r.news === false || r.err) { r.bc = b.id; b.skip = (b.skip || 0) + 1; await env.USERS.put(k.name, JSON.stringify(r)); continue; }
      if (budget <= 0) { left = true; break outer; }
      budget -= (b.type === "album" ? 2 : 1) + ((b.text || "").length > CAP ? Math.ceil(b.text.length / 4000) : 0);
      const res = await bcSend(env, Number(k.name.slice(2)), b, NEWS_KB);
      r.bc = b.id;
      if (res.ok) b.ok = (b.ok || 0) + 1;
      else { b.fail = (b.fail || 0) + 1; if (res.error_code === 403) { r.on = false; r.err = "403"; } }
      await env.USERS.put(k.name, JSON.stringify(r));
    }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  b.lock = 0;
  if (!left) b.state = "done";
  await env.USERS.put("bc:cur", JSON.stringify(b));
  if (!left) await tg(env, "sendMessage", { chat_id: OWNER, text: "рассылка закончена\nдоставлено: " + (b.ok || 0) + "\nне получили (заблокировали бота или отказались от новостей): " + ((b.skip || 0) + (b.fail || 0)) });
}

// разбор ссылки на товар: название, цена, картинки из метаданных страницы (open graph, schema.org, json-ld)
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
function safeUrl(s) {
  let u; try { u = new URL(String(s || "").trim()); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h.endsWith(".local") || h.endsWith(".internal") || h === "localhost") return null;
  return u;
}
const ent = s => String(s == null ? "" : s).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, "&");
async function getLimited(u, headers, max, ms) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(u, { headers, redirect: "follow", signal: ac.signal });
    const rd = res.body && res.body.getReader(); const chunks = []; let n = 0;
    if (rd) while (true) { const x = await rd.read(); if (x.done) break; chunks.push(x.value); n += x.value.length; if (n >= max) { try { await rd.cancel(); } catch (e) {} break; } }
    const buf = new Uint8Array(Math.min(n, max)); let o = 0;
    for (const c of chunks) { const take = Math.min(c.length, buf.length - o); buf.set(c.subarray(0, take), o); o += take; if (o >= buf.length) break; }
    return { res, buf };
  } finally { clearTimeout(t); }
}
const attr = (t, n) => { const m = t.match(new RegExp("\\b" + n + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i")); return m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : null; };
function decodeHtml(buf, ct) {
  let cs = (/charset=([\w-]+)/i.exec(ct || "") || [])[1];
  if (!cs) cs = (/charset=["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(buf.subarray(0, 3000))) || [])[1];
  try { return new TextDecoder(cs || "utf-8").decode(buf); } catch (e) { return new TextDecoder("utf-8").decode(buf); }
}
const toNum = v => { if (v == null) return 0; const n = parseFloat(String(v).replace(/[\s\u00a0]/g, "").replace(",", ".").replace(/[^\d.]/g, "")); return isFinite(n) ? n : 0; };
const CUR = { RUB: "₽", RUR: "₽", USD: "$", EUR: "€", KZT: "₸", BYN: "Br", UAH: "₴" };
function findProducts(node, out, depth) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) { node.forEach(x => findProducts(x, out, depth + 1)); return; }
  if (typeof node !== "object") return;
  const ty = [].concat(node["@type"] || []).map(String);
  if (ty.some(x => /product/i.test(x))) out.push(node);
  if (node["@graph"]) findProducts(node["@graph"], out, depth + 1);
  if (node.mainEntity) findProducts(node.mainEntity, out, depth + 1);
  if (node.itemListElement) findProducts(node.itemListElement, out, depth + 1);
}
function parseProduct(html, base) {
  const M = {};
  for (const t of html.match(/<meta\b[^>]*>/gi) || []) {
    const k = (attr(t, "property") || attr(t, "name") || attr(t, "itemprop") || "").toLowerCase(), v = attr(t, "content");
    if (k && v != null && v !== "") (M[k] = M[k] || []).push(ent(v).trim());
  }
  const first = k => (M[k] || [])[0] || "";
  const prods = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { findProducts(JSON.parse(m[1].trim()), prods, 0); } catch (e) {}
  }
  const P = prods[0] || {};
  let offer = P.offers; if (Array.isArray(offer)) offer = offer[0]; offer = offer || {};
  let imgs = [].concat(P.image || []).map(x => typeof x === "string" ? x : (x && (x.url || x.contentUrl)) || "");
  imgs = imgs.concat(M["og:image"] || [], M["og:image:url"] || [], M["og:image:secure_url"] || [], M["twitter:image"] || [], M["twitter:image:src"] || []);
  const seen = new Set(), images = [];
  for (const i of imgs) {
    let u; try { u = new URL(ent(i), base).href; } catch (e) { continue; }
    if (!/^https?:/.test(u) || seen.has(u)) continue; seen.add(u); images.push(u);
  }
  const titleTag = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const title = ent(P.name || first("og:title") || first("twitter:title") || titleTag).replace(/\s+/g, " ").trim().slice(0, 140);
  const price = toNum(offer.price || offer.lowPrice || first("product:price:amount") || first("og:price:amount") || first("price"));
  const cur = String(offer.priceCurrency || first("product:price:currency") || first("og:price:currency") || first("pricecurrency") || "").toUpperCase();
  return { title, price: price > 0 ? Math.round(price) : 0, cur: CUR[cur] || cur, images: images.slice(0, 5), site: ent(first("og:site_name")) || new URL(base).hostname.replace(/^www\./, "") };
}


// ================= данные приложения: база D1 (привязка DB) =================
// сервер хранит каждую запись отдельно и принимает только более свежую версию (по времени правки),
// поэтому телефон и ноутбук не затирают друг друга. ver растёт с каждым изменением: устройство спрашивает «что нового после ver».
const J = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: Object.assign({ "content-type": "application/json" }, CORS) });
let dbReady = false;
async function dbInit(env) {
  if (dbReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS st (uid INTEGER PRIMARY KEY, ver INTEGER NOT NULL DEFAULT 0, pver INTEGER NOT NULL DEFAULT 0, profile TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ent (uid INTEGER NOT NULL, id TEXT NOT NULL, upd INTEGER NOT NULL, sv INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (uid, id))"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS ent_sv ON ent (uid, sv)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS hist (uid INTEGER NOT NULL, hid TEXT NOT NULL, ts INTEGER NOT NULL, sv INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (uid, hid))"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS hist_sv ON hist (uid, sv)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS img (uid INTEGER NOT NULL, rid TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (uid, rid))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tq (id TEXT PRIMARY KEY, code TEXT NOT NULL, owner INTEGER NOT NULL, upd INTEGER NOT NULL, data TEXT NOT NULL)"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS tq_code ON tq (code)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tqm (qid TEXT NOT NULL, uid INTEGER NOT NULL, name TEXT, photo TEXT, joined INTEGER, PRIMARY KEY (qid, uid))"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS tqm_uid ON tqm (uid)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tqt (qid TEXT NOT NULL, id TEXT NOT NULL, upd INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (qid, id))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tqc (qid TEXT NOT NULL, tid TEXT NOT NULL, id TEXT NOT NULL, uid INTEGER NOT NULL, ts INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (qid, id))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tqe (qid TEXT NOT NULL, ts INTEGER NOT NULL, uid INTEGER NOT NULL, tid TEXT, who TEXT, txt TEXT NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS tqe_q ON tqe (qid, ts)"),
  ]);
  dbReady = true;
}
const LISTS = ["rewards", "challenges", "goals", "achCustom", "purchases", "custom"];
function mergeProf(L, r) {
  if (!L) return r; if (!r) return L;
  const ru = r.upd || 0, lu = L.upd || 0;
  const newer = ru > lu ? r : L, older = ru > lu ? L : r;
  const gone = new Set([].concat(L.gone || [], r.gone || []));
  const out = JSON.parse(JSON.stringify(newer));
  for (const k of LISTS) {
    const A = Array.isArray(newer[k]) ? newer[k] : [], B = Array.isArray(older[k]) ? older[k] : [];
    if (!A.concat(B).every(x => x && typeof x === "object" && x.id)) continue;
    const ids = new Set(A.map(x => x.id));
    out[k] = A.concat(B.filter(x => !ids.has(x.id))).filter(x => !gone.has(x.id));
  }
  out.gone = [...gone].slice(-400); out.upd = Math.max(ru, lu); delete out.fresh;
  return out;
}
const sid = x => typeof x === "string" && x.length > 0 && x.length <= 40;
async function stSync(env, uid, b) {
  await dbInit(env);
  const row = await env.DB.prepare("SELECT ver, pver, profile FROM st WHERE uid = ?1").bind(uid).first();
  let ver = row ? row.ver : 0, pver = row ? row.pver : 0;
  let prof = null; try { prof = row && row.profile ? JSON.parse(row.profile) : null; } catch (e) {}
  const nv = Math.max(ver + 1, Date.now());
  const st = [];
  for (const e of (Array.isArray(b.entries) ? b.entries.slice(0, 3000) : [])) {
    if (!e || !sid(e.id)) continue;
    const data = JSON.stringify(e); if (data.length > 30000) continue;
    st.push(env.DB.prepare("INSERT INTO ent (uid, id, upd, sv, data) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (uid, id) DO UPDATE SET upd = excluded.upd, sv = excluded.sv, data = excluded.data WHERE excluded.upd > ent.upd")
      .bind(uid, e.id, Number(e.upd || e.ts || 0), nv, data));
  }
  for (const h of (Array.isArray(b.hist) ? b.hist.slice(0, 400) : [])) {
    if (!h || !sid(h.hid)) continue;
    const data = JSON.stringify(h); if (data.length > 30000) continue;
    st.push(env.DB.prepare("INSERT OR IGNORE INTO hist (uid, hid, ts, sv, data) VALUES (?1, ?2, ?3, ?4, ?5)").bind(uid, h.hid, Number(h.ts) || 0, nv, data));
  }
  for (const im of (Array.isArray(b.imgs) ? b.imgs.slice(0, 3) : [])) {
    if (!im || !sid(im.rid) || typeof im.data !== "string" || !im.data.startsWith("data:image/") || im.data.length > 1800000) continue;
    st.push(env.DB.prepare("INSERT OR IGNORE INTO img (uid, rid, data) VALUES (?1, ?2, ?3)").bind(uid, im.rid, im.data));
  }
  let changed = 0;
  for (let i = 0; i < st.length; i += 50) {
    const res = await env.DB.batch(st.slice(i, i + 50));
    res.forEach(x => { changed += (x.meta && x.meta.changes) || 0; });
  }
  if (b.profile && typeof b.profile === "object") {
    const m = mergeProf(prof, b.profile);
    if (JSON.stringify(m) !== JSON.stringify(prof)) { prof = m; pver = nv; changed++; }
  }
  if (changed) {
    ver = nv;
    await env.DB.prepare("INSERT INTO st (uid, ver, pver, profile) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (uid) DO UPDATE SET ver = ?2, pver = ?3, profile = ?4")
      .bind(uid, ver, pver, prof ? JSON.stringify(prof) : null).run();
    // архив не растёт бесконечно: держим последние 500 изменений
    await env.DB.prepare("DELETE FROM hist WHERE uid = ?1 AND hid NOT IN (SELECT hid FROM hist WHERE uid = ?1 ORDER BY ts DESC LIMIT 500)").bind(uid).run();
  }
  const since = Number(b.since);
  if (since < 0) return { ok: true }; // отправка при закрытии приложения: ответ не нужен
  const out = { ver };
  out.entries = (await env.DB.prepare("SELECT data FROM ent WHERE uid = ?1 AND sv > ?2").bind(uid, since || 0).all()).results.map(x => JSON.parse(x.data));
  if (prof && pver > (since || 0)) out.profile = prof;
  out.hist = (await env.DB.prepare("SELECT data FROM hist WHERE uid = ?1 AND sv > ?2 ORDER BY ts").bind(uid, since || 0).all()).results.map(x => JSON.parse(x.data));
  out.imgs = (await env.DB.prepare("SELECT rid FROM img WHERE uid = ?1").bind(uid).all()).results.map(x => x.rid);
  const want = (Array.isArray(b.want) ? b.want : []).filter(sid).slice(0, 3);
  if (want.length) {
    out.img = {};
    for (const rid of want) { const r = await env.DB.prepare("SELECT data FROM img WHERE uid = ?1 AND rid = ?2").bind(uid, rid).first(); out.img[rid] = r ? r.data : ""; }
  }
  return out;
}
// сверка через бота: список дел на сегодня прямо с сервера (то, что увидит любое устройство)
async function verifyText(env, uid, date) {
  await dbInit(env);
  const rows = (await env.DB.prepare("SELECT data FROM ent WHERE uid = ?1").bind(uid).all()).results.map(x => { try { return JSON.parse(x.data); } catch (e) { return null; } }).filter(e => e && !e.del && e.title).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const plan = rows.filter(e => e.planned && e.date === date);
  const over = rows.filter(e => e.planned && e.date < date);
  const done = rows.filter(e => !e.planned && e.date === date && e.type !== "routine");
  const ahead = rows.filter(e => e.planned && e.date > date).length;
  const L = ["сверка задач на " + date.slice(8, 10) + "." + date.slice(5, 7), ""];
  L.push(plan.length ? "в планах на сегодня (" + plan.length + "):\n" + plan.slice(0, 30).map(e => "• " + cut(e.title, 80)).join("\n") : "в планах на сегодня пусто");
  if (over.length) L.push("", "осталось с прошлых дней (" + over.length + "):\n" + over.slice(0, 15).map(e => "• " + cut(e.title, 80) + " (" + e.date.slice(8, 10) + "." + e.date.slice(5, 7) + ")").join("\n"));
  if (done.length) L.push("", "уже сделано (" + done.length + "):\n" + done.slice(0, 15).map(e => "• " + cut(e.title, 80)).join("\n"));
  if (ahead) L.push("", "впереди: " + ahead + " " + plural(ahead, "дело", "дела", "дел"));
  L.push("", "всё верно? нажми «синхронизировать устройства», и на телефоне и компьютере будет ровно этот список.");
  return L.join("\n").slice(0, 4000);
}
const verifyKb = { inline_keyboard: [[{ text: "✅ синхронизировать устройства", callback_data: "s:1" }], [{ text: "открыть прокачку", web_app: { url: APP } }]] };

// ================= командные квесты =================
// квест общий для всех участников: задачи с ответственным, дедлайном и комментариями. бот пишет всем о каждом изменении.
const rnd = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const pj = t => { try { return JSON.parse(t); } catch (e) { return null; } };
const ddmm = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d.slice(8, 10) + "." + d.slice(5, 7) : "";
const tqBtn = qid => ({ inline_keyboard: [[{ text: "открыть квест", web_app: { url: APP + "#tq=" + qid } }]] });
// клод — участник-помощник: ему можно поручать задачи, но уведомления в телеграм ему не уходят
const CLAUDE_UID = -1, CLAUDE_NAME = "клод";
const uniqIds = a => [...new Set((a || []).map(Number).filter(n => Number.isInteger(n) && n !== 0))];
const memName = (ms, id) => id === CLAUDE_UID ? CLAUDE_NAME : ((ms.find(m => m.uid === id) || {}).name || "");
const whosOf = t => (Array.isArray(t && t.whos) && t.whos.length ? t.whos : (t && t.who ? [t.who] : [])).map(Number);
const tqMembers = async (env, qid) => (await env.DB.prepare("SELECT uid, name FROM tqm WHERE qid = ?1").bind(qid).all()).results;
// одно уведомление человеку. новые задачи копим: пока их не больше трёх — обычные сообщения,
// с четвёртой прошлые убираем и держим вместо них одно сводное со списком и кнопкой
async function tqSend(env, uid, text, qid, nt) {
  if (!(uid > 0)) return;
  text = text.slice(0, 4000);
  if (!nt || !env.USERS) { await tg(env, "sendMessage", { chat_id: uid, text, reply_markup: tqBtn(qid) }); return; }
  const key = "tqn:" + uid;
  const b = Object.assign({ ids: [], items: [], sum: 0 }, await env.USERS.get(key, "json") || {});
  b.items.push({ t: cut(nt.title, 120), q: qid, qt: cut(nt.quest, 120) });
  if (b.items.length <= 3) {
    const r = await tg(env, "sendMessage", { chat_id: uid, text, reply_markup: tqBtn(qid) });
    if (r.ok && r.result) b.ids.push(r.result.message_id);
  } else {
    for (const id of b.ids.concat(b.sum ? [b.sum] : [])) await tg(env, "deleteMessage", { chat_id: uid, message_id: id });
    b.ids = []; b.sum = 0;
    const qs = [...new Set(b.items.map(i => i.q))];
    const L = ["🪧 новых задач: " + b.items.length, qs.length === 1 ? "в квесте «" + (b.items[0].qt || "") + "»" : "в квестах: " + [...new Set(b.items.map(i => i.qt))].map(x => "«" + x + "»").join(", "), ""];
    b.items.slice(-10).forEach(i => L.push("🪷 " + i.t));
    if (b.items.length > 10) L.push("…и ещё " + (b.items.length - 10));
    const r = await tg(env, "sendMessage", { chat_id: uid, text: L.join("\n").slice(0, 4000), reply_markup: { inline_keyboard: [[{ text: "посмотреть новые задачки", web_app: { url: APP + (qs.length === 1 ? "#tq=" + qs[0] : "") } }]] } });
    if (r.ok && r.result) b.sum = r.result.message_id;
  }
  await env.USERS.put(key, JSON.stringify(b), { expirationTtl: 172800 });
}
// человек открыл приложение: копилку новых задач начинаем заново
const tqSeen = async (env, uid) => { if (env.USERS) await env.USERS.delete("tqn:" + uid); };
// журнал событий командных квестов: из него бот собирает сводку «за 48 часов». who — связанные с задачей люди, чтобы найти «мои задачи»
const tqLog = (env, qid, uid, txt, tid, who) => env.DB.prepare("INSERT INTO tqe (qid, ts, uid, tid, who, txt) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(qid, Date.now(), uid, tid || "", who && who.length ? "," + uniqIds(who).join(",") + "," : "", cut(txt, 400)).run();
const ymd = x => /^\d{4}-\d{2}-\d{2}$/.test(x || "") ? x : "";
const cleanRe = a => (Array.isArray(a) ? a : []).slice(0, 60).filter(x => x && sid(x.id) && String(x.t || "").trim()).map(x => ({ id: x.id, t: cut(x.t, 600), ts: Number(x.ts) || 0, uid: Number(x.uid) || 0, by: cut(x.by || "", 60) }));
const cleanNotes = a => (Array.isArray(a) ? a : []).slice(0, 40).filter(x => x && sid(x.id) && String(x.t || "").trim()).map(x => ({ id: x.id, h: cut(x.h || "", 120), t: cut(x.t, 1500), d: ymd(x.d), by: cut(x.by || "", 60), uid: Number(x.uid) || 0, ed: ymd(x.ed), eb: cut(x.eb || "", 60), re: cleanRe(x.re) }));
const cleanFiles = a => (Array.isArray(a) ? a : []).slice(0, 40).filter(x => x && sid(x.id) && /^https?:\/\//i.test(String(x.u || ""))).map(x => ({ id: x.id, k: "link", t: cut(x.t || x.u, 120), u: String(x.u).slice(0, 500), d: ymd(x.d), by: cut(x.by || "", 60) }));
const cleanSubs = a => (Array.isArray(a) ? a : []).slice(0, 40).filter(x => x && sid(x.id) && String(x.t || "").trim()).map(x => ({ id: x.id, t: cut(x.t, 160), done: !!x.done, who: Number(x.who) || 0 }));
function cleanQuest(q, old) {
  const o = old || {};
  const stages = (Array.isArray(q.stages) ? q.stages : o.stages || []).slice(0, 20).filter(x => x && sid(x.id)).map(x => ({ id: x.id, title: cut(x.title, 120), deadline: /^\d{4}-\d{2}-\d{2}$/.test(x.deadline || "") ? x.deadline : "", done: !!x.done, r1: x.r1 || "", r0: x.r0 || "" }));
  return { id: o.id || q.id, title: cut(q.title, 120) || o.title || "командный квест", about: String(q.about || "").slice(0, 1500), deadline: /^\d{4}-\d{2}-\d{2}$/.test(q.deadline || "") ? q.deadline : "", stages, created: o.created || Date.now(), upd: Date.now(), r1: o.r1 || "", r0: o.r0 || "", notes: cleanNotes(q.notes !== undefined ? q.notes : o.notes), files: cleanFiles(q.files !== undefined ? q.files : o.files) };
}
function cleanTask(t, old) {
  const o = old || {};
  const whos = uniqIds(Array.isArray(t.whos) ? t.whos : (t.who ? [t.who] : [])).slice(0, 20);
  return { id: t.id, title: cut(t.title, 160) || o.title || "задача", essence: String(t.essence || "").slice(0, 2000), whos, who: whos.find(x => x > 0) || whos[0] || 0, start: /^\d{4}-\d{2}-\d{2}$/.test(t.start || "") ? t.start : "", deadline: /^\d{4}-\d{2}-\d{2}$/.test(t.deadline || "") ? t.deadline : "", stage: sid(t.stage) ? t.stage : "", done: !!t.done, doneBy: t.done ? (Number(t.doneBy) || o.doneBy || 0) : 0, doneAt: t.done ? (o.done ? o.doneAt : Date.now()) : 0, del: !!t.del, by: o.by || Number(t.by) || 0, created: o.created || Date.now(), upd: Number(t.upd) || Date.now(), r1: o.deadline === t.deadline ? (o.r1 || "") : "", r0: o.deadline === t.deadline ? (o.r0 || "") : "", subs: cleanSubs(t.subs !== undefined ? t.subs : o.subs) };
}
async function tqMember(env, qid, uid) { return !!(await env.DB.prepare("SELECT 1 AS x FROM tqm WHERE qid = ?1 AND uid = ?2").bind(qid, uid).first()); }
// владелице приходит копия всего, что ушло другим из-за её действий: видно, что и кому отправилось
// картинка из приложения: data-url jpeg/png/webp до ~1,5 МБ -> байты
function memeBytes(d) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+\/=]+)$/.exec(String(d || ""));
  if (!m || m[2].length > 2000000) return null;
  try { const bin = atob(m[2]); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return { type: m[1], bytes: a }; } catch (e) { return null; }
}
async function tqSendPhoto(env, uid, meme, caption, qid) {
  const fd = new FormData();
  fd.append("chat_id", String(uid));
  fd.append("photo", new Blob([meme.bytes], { type: meme.type }), "meme." + meme.type.split("/")[1]);
  const short = caption.length <= 1000;
  if (short) { fd.append("caption", caption); fd.append("reply_markup", JSON.stringify(tqBtn(qid))); }
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: "POST", body: fd }).then(x => x.json()).catch(() => ({ ok: false }));
  if (!short) await tg(env, "sendMessage", { chat_id: uid, text: caption.slice(0, 4000), reply_markup: tqBtn(qid) });
  return r.ok;
}
async function tqEcho(env, qid, from, uids, text, meme) {
  if (from !== OWNER) return;
  const ids = uniqIds(uids).filter(x => x !== from && x > 0);
  if (!ids.length) return;
  const ms = await tqMembers(env, qid);
  const names = ids.map(x => memName(ms, x) || "участник").join(", ");
  const msg = "📤 ушло: " + names + "\n\n" + text;
  if (meme && await tqSendPhoto(env, from, meme, msg, qid)) return;
  await tqSend(env, from, msg, qid);
}
async function tqNotify(env, qid, exceptUid, text) {
  const ms = (await env.DB.prepare("SELECT uid FROM tqm WHERE qid = ?1").bind(qid).all()).results;
  for (const m of ms) if (m.uid !== exceptUid) await tqSend(env, m.uid, text, qid);
  await tqEcho(env, qid, exceptUid, ms.map(m => m.uid), text);
}
// уведомление только тем, кто связан с задачей: ответственные, автор, участники обсуждения
async function tqNotifyTo(env, qid, uids, exceptUid, text, nt) {
  for (const uid of uniqIds(uids)) if (uid !== exceptUid) await tqSend(env, uid, text, qid, nt);
  await tqEcho(env, qid, exceptUid, uids, text);
}
async function tqList(env, uid) {
  const qs = (await env.DB.prepare("SELECT q.id, q.code, q.owner, q.data FROM tq q JOIN tqm m ON m.qid = q.id WHERE m.uid = ?1").bind(uid).all()).results;
  const out = [];
  for (const q of qs) {
    const data = pj(q.data); if (!data || data.del) continue;
    const members = (await env.DB.prepare("SELECT uid, name, photo, joined FROM tqm WHERE qid = ?1 ORDER BY joined").bind(q.id).all()).results;
    const tasks = (await env.DB.prepare("SELECT data FROM tqt WHERE qid = ?1").bind(q.id).all()).results.map(x => pj(x.data)).filter(t => t && !t.del);
    const comments = (await env.DB.prepare("SELECT id, tid, uid, ts, text FROM tqc WHERE qid = ?1 ORDER BY ts").bind(q.id).all()).results;
    out.push(Object.assign(data, { code: q.code, owner: q.owner, members, tasks, comments }));
  }
  return out.sort((a, b) => (b.created || 0) - (a.created || 0));
}
async function tqOp(env, ctx, u, b) {
  await dbInit(env);
  const f = b.g !== "m"; // род для сообщений: приложение присылает пол из профиля
  const V = (m, w) => f ? w : m;
  const op = b.op;
  const later = p => ctx.waitUntil(p.catch(() => {}));
  // имя и фото участника обновляем при каждом заходе
  await env.DB.prepare("UPDATE tqm SET name = ?2, photo = ?3 WHERE uid = ?1").bind(u.id, u.name, u.photo).run();
  if (op === "list") { later(tqSeen(env, u.id)); return { list: await tqList(env, u.id) }; }
  if (op === "save") {
    const q = b.quest || {};
    if (!sid(q.id)) return { error: "bad" };
    const row = await env.DB.prepare("SELECT data FROM tq WHERE id = ?1").bind(q.id).first();
    if (!row) {
      const data = cleanQuest(q, null);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO tq (id, code, owner, upd, data) VALUES (?1, ?2, ?3, ?4, ?5)").bind(q.id, rnd(10), u.id, data.upd, JSON.stringify(data)),
        env.DB.prepare("INSERT OR IGNORE INTO tqm (qid, uid, name, photo, joined) VALUES (?1, ?2, ?3, ?4, ?5)").bind(q.id, u.id, u.name, u.photo, Date.now()),
      ]);
    } else {
      if (!await tqMember(env, q.id, u.id)) return { error: "not member" };
      const old = pj(row.data) || {};
      const data = cleanQuest(q, old);
      if (q.del) data.del = true;
      // этапы: напоминания уже отправленные не теряем
      data.stages.forEach(st => { const os = (old.stages || []).find(x => x.id === st.id); if (os && os.deadline === st.deadline) { st.r1 = os.r1 || ""; st.r0 = os.r0 || ""; } });
      if (old.deadline !== data.deadline) { data.r1 = ""; data.r0 = ""; }
      await env.DB.prepare("UPDATE tq SET upd = ?2, data = ?3 WHERE id = ?1").bind(q.id, data.upd, JSON.stringify(data)).run();
      const ev = [];
      if (q.del) ev.push("" + V("закрыл", "закрыла") + " квест");
      else {
        if (old.deadline !== data.deadline && data.deadline) ev.push("" + V("поставил", "поставила") + " дедлайн квеста: " + ddmm(data.deadline));
        data.stages.forEach(st => { const os = (old.stages || []).find(x => x.id === st.id); if (!os) ev.push("" + V("добавил", "добавила") + " этап «" + st.title + "»" + (st.deadline ? " до " + ddmm(st.deadline) : "")); else if (!os.done && st.done) ev.push("" + V("закрыл", "закрыла") + " этап «" + st.title + "» ✅"); else if (os.deadline !== st.deadline && st.deadline) ev.push("" + V("перенёс", "перенесла") + " этап «" + st.title + "» на " + ddmm(st.deadline)); });
      }
      if (ev.length) { later(tqNotify(env, q.id, u.id, u.name + " " + ev.join(", ") + "\nквест «" + data.title + "»")); later(tqLog(env, q.id, u.id, "🪧 " + u.name + " " + ev.join(", "))); }
      // новый тезис в материалах: всем участникам, кроме автора, с кнопкой прямо к тезису
      if (!q.del) {
        const fresh = (data.notes || []).filter(n => !(old.notes || []).some(o => o.id === n.id)).slice(0, 3);
        if (fresh.length) later((async () => {
          const ms = await tqMembers(env, q.id);
          const rec = uniqIds(ms.map(m => m.uid)).filter(x => x > 0); // автору тоже: так видно, что ушло команде
          for (const n of fresh) {
            const text = ("💡 " + u.name + " " + V("добавил", "добавила") + " тезис в квесте «" + (data.title || "без названия") + "»\n\n" + (n.h ? "📌 " + n.h + "\n" : "") + cut(n.t, 700)).slice(0, 4000);
            const kb = { inline_keyboard: [[{ text: "открыть тезис", web_app: { url: APP + "#tq=" + q.id + "&n=" + n.id } }]] };
            for (const uid of rec) await tg(env, "sendMessage", { chat_id: uid, text, reply_markup: kb });
            await tqLog(env, q.id, u.id, "💡 " + u.name + " " + V("добавил", "добавила") + " тезис" + (n.h ? " «" + n.h + "»" : ""));
          }
        })());
      }
    }
    return { list: await tqList(env, u.id) };
  }
  if (op === "task") {
    const t = b.task || {}, qid = b.qid;
    if (!sid(qid) || !sid(t.id) || !await tqMember(env, qid, u.id)) return { error: "bad" };
    const qrow = await env.DB.prepare("SELECT data FROM tq WHERE id = ?1").bind(qid).first(); const q = pj(qrow && qrow.data) || {};
    const row = await env.DB.prepare("SELECT data FROM tqt WHERE qid = ?1 AND id = ?2").bind(qid, t.id).first();
    const old = row ? pj(row.data) : null;
    if (!old) t.by = u.id;
    if (t.done && !(old && old.done)) t.doneBy = u.id;
    const data = cleanTask(t, old);
    data.upd = Date.now();
    await env.DB.prepare("INSERT INTO tqt (qid, id, upd, data) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (qid, id) DO UPDATE SET upd = excluded.upd, data = excluded.data").bind(qid, t.id, data.upd, JSON.stringify(data)).run();
    const all = (await env.DB.prepare("SELECT data FROM tqt WHERE qid = ?1").bind(qid).all()).results.map(x => pj(x.data)).filter(x => x && !x.del);
    const dn = all.filter(x => x.done).length;
    const ms = await tqMembers(env, qid);
    const names = ids => ids.map(x => memName(ms, x)).filter(Boolean).join(", ");
    // карточка задачи: кто поставил, суть, дедлайн, ответственные — каждое своей строкой
    const card = tail => ["🪧 Какой квест: " + (q.title || "без названия"),
      "🪷 Суть задачи: " + data.title,
      "👤 Поставил(а): " + (memName(ms, data.by) || u.name),
      "⌛️ Дедлайн: " + (data.deadline ? ddmm(data.deadline) : "без дедлайна"),
      "👥 Ответственные: " + (names(data.whos) || "пока никто")].join("\n") + (tail ? "\n\n" + tail : "");
    const was = old ? whosOf(old) : [];
    let head = "", nt = null;
    if (!old) { head = "➕ новая задача"; nt = { title: data.title, quest: q.title || "" }; }
    else if (data.del && !old.del) head = "🗑 " + u.name + " " + V("удалил", "удалила") + " задачу";
    else if (data.done && !old.done) head = "✅ " + u.name + " " + V("закрыл", "закрыла") + " задачу";
    else if (!data.done && old.done) head = "↩️ " + u.name + " " + V("вернул", "вернула") + " задачу в работу";
    else if (data.whos.join() !== was.join()) head = "👥 " + u.name + " " + V("поменял", "поменяла") + " ответственных";
    else if (data.deadline !== old.deadline) head = "⌛️ " + u.name + " " + V("поменял", "поменяла") + " дедлайн";
    else if (data.title !== old.title || data.essence !== old.essence) head = "✏️ " + u.name + " " + V("изменил", "изменила") + " задачу";
    if (head) later(tqLog(env, qid, u.id, (old ? head : "➕ " + u.name + " " + V("добавил", "добавила") + " задачу") + " «" + data.title + "»" + (head.startsWith("⌛️") && data.deadline ? " на " + ddmm(data.deadline) : "") + (head.startsWith("👥") ? ": " + (names(data.whos) || "никто") : ""), data.id, [...data.whos, ...was, data.by]));
    if (head) {
      const tail = (data.done && !old.done) ? "готово " + dn + " из " + all.length : "";
      let rec = uniqIds([...data.whos, ...was, data.by]).filter(x => x > 0 && x !== u.id);
      if (!rec.length && !data.whos.filter(x => x > 0).length) rec = ms.map(m => m.uid).filter(x => x !== u.id);
      later(tqNotifyTo(env, qid, rec, u.id, head + "\n\n" + card(tail), nt));
    }
    return { list: await tqList(env, u.id) };
  }
  if (op === "comment") {
    const qid = b.qid, tid = b.tid, text = String(b.text || "").trim().slice(0, 1500);
    if (!sid(qid) || !sid(tid) || !text || !await tqMember(env, qid, u.id)) return { error: "bad" };
    await env.DB.prepare("INSERT INTO tqc (qid, tid, id, uid, ts, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(qid, tid, rnd(12), u.id, Date.now(), text).run();
    const tr = await env.DB.prepare("SELECT data FROM tqt WHERE qid = ?1 AND id = ?2").bind(qid, tid).first(); const t = pj(tr && tr.data) || {};
    const qr = await env.DB.prepare("SELECT data FROM tq WHERE id = ?1").bind(qid).first(); const q = pj(qr && qr.data) || {};
    const ms = await tqMembers(env, qid);
    const spoke = (await env.DB.prepare("SELECT DISTINCT uid FROM tqc WHERE qid = ?1 AND tid = ?2").bind(qid, tid).all()).results.map(x => x.uid);
    let rec = uniqIds([...whosOf(t), t.by, ...spoke]).filter(x => x > 0 && x !== u.id);
    if (!rec.length || tid === "_q") rec = ms.map(m => m.uid).filter(x => x > 0 && x !== u.id);
    const msg = "✉️ " + (u.username ? "@" + u.username : u.name) + " говорит в квесте @" + (q.title || "без названия") + ":\n" + (tid === "_q" ? "💬 комментарий ко всему квесту" : "🪷 Суть задачи: " + (t.title || "")) + "\n\n" + cut(text, 600);
    later(tqNotifyTo(env, qid, rec, u.id, msg));
    later(tqLog(env, qid, u.id, "✉️ " + u.name + (tid === "_q" ? " в квесте: " : " в задаче «" + (t.title || "") + "»: ") + cut(text, 140), tid, [...whosOf(t), t.by, ...spoke]));
    return { list: await tqList(env, u.id) };
  }
  if (op === "nudge") {
    // напоминание о задаче: ответственным или всей команде, по кнопке из приложения
    const qid = b.qid, tid = b.tid;
    if (!sid(qid) || !sid(tid) || !await tqMember(env, qid, u.id)) return { error: "bad" };
    const tr = await env.DB.prepare("SELECT data FROM tqt WHERE qid = ?1 AND id = ?2").bind(qid, tid).first(); const t = pj(tr && tr.data);
    if (!t || t.del || t.done) return { error: "bad" };
    const qr = await env.DB.prepare("SELECT data FROM tq WHERE id = ?1").bind(qid).first(); const q = pj(qr && qr.data) || {};
    const ms = await tqMembers(env, qid);
    const key = "nudge:" + qid + ":" + tid + ":" + u.id;
    if (env.USERS && await env.USERS.get(key)) return { error: "wait" };
    const all = b.scope === "all";
    const rec = uniqIds(all ? ms.map(m => m.uid) : whosOf(t)).filter(x => x > 0 && x !== u.id);
    if (!rec.length) return { error: "nobody" };
    const names = whosOf(t).map(x => memName(ms, x)).filter(Boolean).join(", ");
    const note = String(b.note || "").trim().slice(0, 400);
    const meme = b.img ? memeBytes(b.img) : null;
    if (b.img && !meme) return { error: "img" };
    const text = "🔔 " + u.name + " напоминает о задачке\n\n🪧 Какой квест: " + (q.title || "без названия") + "\n🪷 Суть задачи: " + (t.title || "") + "\n⌛️ Дедлайн: " + (t.deadline ? ddmm(t.deadline) : "без дедлайна") + "\n👥 Ответственные: " + (names || "пока никто") + (note ? "\n\n💬 " + u.name + " пишет: " + note : "");
    for (const uid of rec) { if (meme) { if (!await tqSendPhoto(env, uid, meme, text, qid)) await tqSend(env, uid, text, qid); } else await tqSend(env, uid, text, qid); }
    await tqEcho(env, qid, u.id, rec, text, meme);
    if (env.USERS) await env.USERS.put(key, "1", { expirationTtl: 120 });
    later(tqLog(env, qid, u.id, "🔔 " + u.name + " " + V("напомнил", "напомнила") + " о задаче «" + (t.title || "") + "»" + (all ? " всей команде" : ""), tid, [...whosOf(t), t.by]));
    return { sent: rec.length };
  }
  if (op === "join") {
    const code = String(b.code || "").slice(0, 20);
    const q = await env.DB.prepare("SELECT id, data FROM tq WHERE code = ?1").bind(code).first();
    if (!q) return { error: "not found" };
    const was = await tqMember(env, q.id, u.id);
    if (!was) {
      await env.DB.prepare("INSERT OR IGNORE INTO tqm (qid, uid, name, photo, joined) VALUES (?1, ?2, ?3, ?4, ?5)").bind(q.id, u.id, u.name, u.photo, Date.now()).run();
      later(tqNotify(env, q.id, u.id, "🙌 " + u.name + " " + V("присоединился", "присоединилась") + " к квесту «" + ((pj(q.data) || {}).title || "") + "»"));
      later(tqLog(env, q.id, u.id, "🙌 " + u.name + " " + V("присоединился", "присоединилась") + " к квесту"));
    }
    return { joined: q.id, list: await tqList(env, u.id) };
  }
  if (op === "leave") {
    if (!sid(b.qid)) return { error: "bad" };
    await env.DB.prepare("DELETE FROM tqm WHERE qid = ?1 AND uid = ?2").bind(b.qid, u.id).run();
    later(tqNotify(env, b.qid, u.id, "👋 " + u.name + " " + V("вышел", "вышла") + " из квеста"));
    later(tqLog(env, b.qid, u.id, "👋 " + u.name + " " + V("вышел", "вышла") + " из квеста"));
    return { list: await tqList(env, u.id) };
  }
  return { error: "op" };
}
// сводка «что было за 48 часов»: по квесту, по моим задачам, обновления приложения, для владельца — кто пришёл
const H48 = 48 * 3600000;
const hm = ts => { const d = new Date(ts + MSK); return p2(d.getUTCDate()) + "." + p2(d.getUTCMonth() + 1) + " " + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()); };
const EV_BACK = { inline_keyboard: [[{ text: "← к выбору", callback_data: "ev:menu" }]] };
async function evMenu(env, uid) {
  const rows = [];
  if (env.DB) {
    await dbInit(env);
    const qs = (await env.DB.prepare("SELECT q.id, q.data FROM tq q JOIN tqm m ON m.qid = q.id WHERE m.uid = ?1").bind(uid).all()).results;
    for (const q of qs) { const d = pj(q.data) || {}; if (!d.del && q.id.length <= 50) rows.push([{ text: "🪧 " + cut(d.title || "квест", 40), callback_data: "ev:q:" + q.id }]); }
    rows.push([{ text: "🪷 мои задачи", callback_data: "ev:my" }]);
  }
  rows.push([{ text: "✨ обновления прокачки", callback_data: "ev:app" }]);
  if (uid === OWNER) rows.push([{ text: "🛠 для разработчика: кто пришёл", callback_data: "ev:dev" }]);
  return { text: "события за последние 48 часов\n\nвыбери, что показать:", reply_markup: { inline_keyboard: rows } };
}
const evLines = rs => rs.map(r => hm(r.ts) + " · " + r.txt);
async function evQuest(env, uid, qid) {
  await dbInit(env);
  if (!await tqMember(env, qid, uid)) return "этого квеста у тебя нет";
  const q = pj(((await env.DB.prepare("SELECT data FROM tq WHERE id = ?1").bind(qid).first()) || {}).data) || {};
  const rs = (await env.DB.prepare("SELECT ts, txt FROM tqe WHERE qid = ?1 AND ts > ?2 ORDER BY ts DESC LIMIT 40").bind(qid, Date.now() - H48).all()).results;
  const ts = (await env.DB.prepare("SELECT data FROM tqt WHERE qid = ?1").bind(qid).all()).results.map(x => pj(x.data)).filter(t => t && !t.del);
  const dn = ts.filter(t => t.done).length;
  return "🪧 квест «" + (q.title || "") + "» · 48 часов\n" + "готово задач: " + dn + " из " + ts.length + "\n\n" + (rs.length ? evLines(rs).join("\n") : "за 48 часов в квесте ничего не менялось");
}
async function evMine(env, uid) {
  await dbInit(env);
  const qs = (await env.DB.prepare("SELECT q.id, q.data FROM tq q JOIN tqm m ON m.qid = q.id WHERE m.uid = ?1").bind(uid).all()).results;
  const L = ["🪷 мои задачи · 48 часов"]; let open = [];
  for (const q of qs) {
    const d = pj(q.data) || {}; if (d.del) continue;
    const rs = (await env.DB.prepare("SELECT ts, txt FROM tqe WHERE qid = ?1 AND ts > ?2 AND who LIKE ?3 ORDER BY ts DESC LIMIT 20").bind(q.id, Date.now() - H48, "%," + uid + ",%").all()).results;
    const ts = (await env.DB.prepare("SELECT data FROM tqt WHERE qid = ?1").bind(q.id).all()).results.map(x => pj(x.data)).filter(t => t && !t.del && !t.done && whosOf(t).includes(uid));
    ts.forEach(t => open.push({ t: t.title, d: t.deadline, q: d.title }));
    if (rs.length) L.push("", "🪧 «" + cut(d.title, 60) + "»", ...evLines(rs));
  }
  if (L.length === 1) L.push("", "за 48 часов по твоим задачам ничего не происходило");
  open.sort((a, b) => (a.d || "9") < (b.d || "9") ? -1 : 1);
  if (open.length) { L.push("", "сейчас на тебе: " + open.length + " " + plural(open.length, "задача", "задачи", "задач")); open.slice(0, 8).forEach(o => L.push("— " + o.t + (o.d ? " · до " + ddmm(o.d) : "") + " (" + cut(o.q, 30) + ")")); }
  return L.join("\n");
}
const gxPlain = t => String(t).replace(/\{([^|}]*)\|([^}]*)\}/g, (_, f, m) => m ? f + "/" + m : "(" + f + ")");
async function evApp() {
  let html = "";
  try { const r = await fetch(APP + "/", { cf: { cacheTtl: 300 } }); html = await r.text(); } catch (e) {}
  const re = /\{id:"([^"]+)",date:"(\d{4}-\d{2}-\d{2})",kind:"(\w+)",title:"([^"]+)"/g; const all = []; let m;
  while ((m = re.exec(html))) all.push({ d: m[2], t: gxPlain(m[4]) });
  const v = (html.match(/APP_V="(v\d+)"/) || [])[1] || "";
  const lim = new Date(Date.now() + MSK - H48).toISOString().slice(0, 10);
  const fresh = all.filter(x => x.d >= lim);
  const list = fresh.length ? fresh : all.slice(0, 3);
  return "✨ обновления прокачки" + (v ? " · сейчас " + v : "") + "\n\n" + (fresh.length ? "" : "за 48 часов новых не было, последние:\n") + (list.length ? list.map(x => ddmm(x.d) + " · " + x.t).join("\n") : "не получилось загрузить список, попробуй позже");
}
async function evDev(env) {
  const now = Date.now(), lim = new Date(now + MSK - H48).toISOString().slice(0, 10), yd = new Date(now + MSK - 864e5).toISOString().slice(0, 10);
  const fresh = []; let total = 0, active = 0, cursor;
  do {
    const l = await env.USERS.list({ prefix: "u:", cursor });
    for (const k of l.keys) {
      const id = Number(k.name.slice(2)); if (!id) continue; total++;
      const r = await env.USERS.get(k.name, "json"); if (!r) continue;
      if (r.seen && r.seen >= yd) active++;
      if (id === OWNER) continue;
      if (r.ft ? r.ft > now - H48 : (r.first && r.first >= lim)) fresh.push({ ts: r.ft || 0, d: r.first, nm: r.nm || "без имени", un: r.un || "", id });
    }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  fresh.sort((a, b) => (b.ts || 0) - (a.ts || 0) || (a.d < b.d ? 1 : -1));
  return "🛠 для разработчика · 48 часов\n\nновых людей: " + fresh.length + "\nзаходили за сутки: " + active + "\nвсего в прокачке: " + total + "\n\n" +
    (fresh.length ? fresh.slice(0, 40).map(x => (x.ts ? hm(x.ts) : ddmm(x.d)) + " · " + x.nm + (x.un ? " @" + x.un : "") + " · id " + x.id).join("\n") : "за 48 часов новых людей не было");
}

// напоминания о дедлайнах: за день и в день дедлайна, утром по московскому времени
async function tqRemind(env) {
  if (!env.DB) return;
  await dbInit(env);
  await env.DB.prepare("DELETE FROM tqe WHERE ts < ?1").bind(Date.now() - 7 * 864e5).run().catch(() => {});
  const t = localNow(180); if (t.hour < 10) return;
  const today = t.date, tomorrow = shiftDate(today, 1);
  const qs = (await env.DB.prepare("SELECT id, data FROM tq").all()).results;
  for (const qr of qs) {
    const q = pj(qr.data); if (!q || q.del) continue;
    const msgs = []; let qDirty = false;
    const check = (o, label) => {
      if (!o.deadline || o.done) return;
      if (o.deadline === tomorrow && o.r1 !== today) { o.r1 = today; msgs.push("⏰ завтра дедлайн: " + label); return true; }
      if (o.deadline === today && o.r0 !== today) { o.r0 = today; msgs.push("🔥 сегодня дедлайн: " + label); return true; }
      return false;
    };
    if (check(q, "весь квест «" + q.title + "»")) qDirty = true;
    (q.stages || []).forEach(st => { if (check(st, "этап «" + st.title + "»")) qDirty = true; });
    if (qDirty) await env.DB.prepare("UPDATE tq SET data = ?2 WHERE id = ?1").bind(q.id, JSON.stringify(q)).run();
    const ms = await tqMembers(env, q.id);
    const nm = id => memName(ms, id);
    const ts = (await env.DB.prepare("SELECT id, data FROM tqt WHERE qid = ?1").bind(q.id).all()).results;
    // дедлайны задач напоминаем только тем, кто с ними связан; дедлайны квеста и этапов — всей команде
    const mine = new Map();
    for (const tr of ts) {
      const x = pj(tr.data); if (!x || x.del) continue;
      const w = whosOf(x);
      if (check(x, "«" + x.title + "»" + (w.length ? " · " + (w.length > 1 ? "ответственные" : "ответственный") + ": " + w.map(nm).filter(Boolean).join(", ") : ""))) {
        await env.DB.prepare("UPDATE tqt SET data = ?3 WHERE qid = ?1 AND id = ?2").bind(q.id, x.id, JSON.stringify(x)).run();
        const line = msgs.pop();
        let rec = uniqIds([...w, x.by]).filter(y => y > 0);
        if (!rec.length) rec = ms.map(m => m.uid);
        rec.forEach(uid => mine.set(uid, (mine.get(uid) || []).concat(line)));
      }
    }
    for (const m of ms) {
      const L = msgs.concat(mine.get(m.uid) || []);
      if (L.length) await tg(env, "sendMessage", { chat_id: m.uid, text: ("квест «" + q.title + "»\n" + L.join("\n")).slice(0, 4000), reply_markup: tqBtn(q.id) });
    }
  }
}
// событие в календарь: файл .ics на весь день (айфон и мак откроют его в календаре)
function icsFile(title, date, note) {
  const d = date.replace(/-/g, ""), e = shiftDate(date, 1).replace(/-/g, "");
  const esc = s => String(s || "").replace(/[\\;,]/g, m => "\\" + m).replace(/\n/g, "\\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//prokachka//RU", "BEGIN:VEVENT", "UID:" + rnd(16) + "@prokachka", "DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z",
    "DTSTART;VALUE=DATE:" + d, "DTEND;VALUE=DATE:" + e, "SUMMARY:" + esc(title), "DESCRIPTION:" + esc(note), "BEGIN:VALARM", "TRIGGER:-PT15H", "ACTION:DISPLAY", "DESCRIPTION:" + esc(title), "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (!env.BOT_TOKEN) return new Response("нет секрета BOT_TOKEN", { status: 500 });
    const path = await hookPath(env);

    if (url.pathname === "/v") return new Response(BOT_V, { headers: { "content-type": "text/plain; charset=utf-8", ...CORS } });

    if (url.pathname === "/setup") {
      const out = {};
      out.webhook = await tg(env, "setWebhook", { url: url.origin + path, allowed_updates: ["message", "callback_query"] });
      out.menu = await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "прокачка", web_app: { url: APP } } });
      await env.USERS.delete("cmds:" + BOT_V); await setCommands(env); out.commands = "ok";
      out.short = await tg(env, "setMyShortDescription", { short_description: "превращаю жизнь в игру: навыки, опыт и квесты" });
      out.kv = env.USERS ? "ok" : "нет привязки USERS";
      out.stats = url.origin + await statsPath(env);
      return new Response(JSON.stringify(out, null, 1), { headers: { "content-type": "application/json; charset=utf-8" } });
    }

    if (env.USERS) {
      const cm = url.pathname.match(/^\/cal\/([0-9a-f]+)(\.ics|\/go)$/);
      if (cm && cm[1] === await calKey(env)) {
        if (cm[2] === "/go") return new Response(null, { status: 302, headers: { location: "webcal://" + url.host + "/cal/" + cm[1] + ".ics" } });
        return new Response(await calFeed(env), { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" } });
      }
    }

    if (url.pathname === await statsPath(env) && env.USERS) return statsPage(env);

    // то же самое для владельца прямо в приложении: доступ по telegram id, который проверяется подписью
    if (url.pathname === "/owner-stats" && req.method === "POST" && env.USERS) {
      const b = await req.json().catch(() => null);
      const uid = b && b.initData ? await checkInitData(env, String(b.initData)) : null;
      if (uid !== OWNER) return new Response("no", { status: 403, headers: CORS });
      const data = await statsPage(env, true);
      data.url = url.origin + await statsPath(env);
      return new Response(JSON.stringify(data), { headers: Object.assign({ "content-type": "application/json" }, CORS) });
    }

    // автозаполнение хотелки по ссылке: только для людей из приложения (подпись telegram)
    if ((url.pathname === "/unfurl" || url.pathname === "/img") && req.method === "POST") {
      const b = await req.json().catch(() => null);
      const uid = b && b.initData ? await checkInitData(env, String(b.initData)) : null;
      if (!uid) return new Response("bad", { status: 401, headers: CORS });
      const u = safeUrl(b.url);
      if (!u) return new Response(JSON.stringify({ ok: false, reason: "link" }), { headers: Object.assign({ "content-type": "application/json" }, CORS) });
      try {
        if (url.pathname === "/img") {
          const ref = safeUrl(b.ref);
          const { res, buf } = await getLimited(u.href, { "user-agent": UA, accept: "image/avif,image/webp,image/*,*/*;q=0.8", referer: (ref || u).origin + "/" }, 6e6, 9000);
          const ct = res.headers.get("content-type") || "";
          if (!res.ok || !/^image\//i.test(ct) || /svg/i.test(ct) || !buf.length) return new Response("no", { status: 415, headers: CORS });
          return new Response(buf, { headers: Object.assign({ "content-type": ct, "cache-control": "no-store" }, CORS) });
        }
        const { res, buf } = await getLimited(u.href, { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "ru-RU,ru;q=0.9,en;q=0.7" }, 800000, 9000);
        const fin = safeUrl(res.url) || u;
        const out = { ok: false, status: res.status, final: fin.href };
        if (res.ok) {
          const info = parseProduct(decodeHtml(buf, res.headers.get("content-type")), fin.href);
          Object.assign(out, info);
          out.ok = !!(info.title || info.price || info.images.length);
          if (/captcha|antibot|access denied|are you a robot|подтвердите, что вы не робот|доступ ограничен/i.test(info.title)) { out.ok = false; out.blocked = true; }
        } else out.blocked = true;
        return new Response(JSON.stringify(out), { headers: Object.assign({ "content-type": "application/json" }, CORS) });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: "fetch" }), { headers: Object.assign({ "content-type": "application/json" }, CORS) });
      }
    }

    // приложение сообщает «я открыто»: если человек ещё не настраивал напоминания, бот сразу предлагает это в чате
    if (url.pathname === "/alive" && req.method === "POST") {
      if (!env.USERS) return new Response("no kv", { status: 500, headers: CORS });
      const b = await req.json().catch(() => null);
      const uid = b && b.initData ? await checkInitData(env, String(b.initData)) : null;
      if (!uid) return new Response("bad", { status: 401, headers: CORS });
      const r = Object.assign(defRec(), await env.USERS.get("u:" + uid, "json") || {});
      const need = false; // предложение теперь приходит на /start, сигнал оставлен на всякий случай
      return new Response(JSON.stringify({ need }), { headers: Object.assign({ "content-type": "application/json" }, CORS) });
    }

    // приложение сообщает настройки напоминаний
    if ((url.pathname === "/sync" || url.pathname === "/closed") && req.method === "POST") {
      if (!env.USERS) return new Response("no kv", { status: 500, headers: CORS });
      const b = await req.json().catch(() => null);
      const who = b && b.initData ? await checkUser(env, String(b.initData)) : null;
      const uid = who && who.id;
      if (!uid) return new Response("bad", { status: 401, headers: CORS });
      const key = "u:" + uid;
      const old = await env.USERS.get(key, "json");
      const r = Object.assign(defRec(), old || {});
      // первый вход: записи ещё нет или человек нажимал /start, но приложение не открывал
      const firstOpen = url.pathname === "/sync" && !r.jn && !r.first;
      if (firstOpen) { r.jn = 1; r.ft = Date.now(); }
      if (url.pathname === "/sync") { r.nm = who.name || r.nm || ""; r.un = who.username || ""; }
      r.tz = Math.max(-840, Math.min(840, parseInt(b.tz, 10) || 0));
      if (url.pathname === "/sync") {
        const lt = localNow(r.tz).date;
        r.seen = lt; if (!r.first) r.first = lt;
        r.dd = (r.dd || []).filter(d => d !== lt).concat(lt).slice(-30);
        if (Array.isArray(b.prof)) r.prof = b.prof.slice(0, 3).map(x => cut(x, 30)).filter(Boolean);
        if (b.day && typeof b.day === "object") r.day = { d: cut(b.day.d, 10), rt: Math.max(0, parseInt(b.day.rt, 10) || 0), xp: Math.max(0, parseInt(b.day.xp, 10) || 0), more: Math.max(0, parseInt(b.day.more, 10) || 0), items: (Array.isArray(b.day.items) ? b.day.items : []).slice(0, 5).map(i => ({ t: cut(i.t, 50), x: parseInt(i.x, 10) || 0 })) };
        if (b.wk && typeof b.wk === "object") r.wk = { xp: parseInt(b.wk.xp, 10) || 0, n: parseInt(b.wk.n, 10) || 0, days: parseInt(b.wk.days, 10) || 0, top: cut(b.wk.top, 40), lvl: parseInt(b.wk.lvl, 10) || 1, st: parseInt(b.wk.st, 10) || 0 };
        if (/^\d{4}-\d{2}-\d{2}$/.test(b.last || "")) r.last = b.last;
        if (Array.isArray(b.todo)) r.todo = b.todo.slice(0, 10).map(t => cut(t, 80)).filter(Boolean);
        if (typeof b.quest === "string") r.quest = cut(b.quest, 100);
        if (b.cfg) { // человек поменял настройки в приложении
          r.on = !!b.cfg.on;
          r.hour = Math.min(23, Math.max(0, parseInt(b.cfg.hour, 10) || 20));
          r.count = Math.min(3, Math.max(1, parseInt(b.cfg.count, 10) || 1));
          r.times = timesFor(r.hour, r.count);
          r.rep = b.cfg.rep !== false; r.wkOn = b.cfg.wk !== false;
          r.cfg = true; r.offered = true;
        }
      } else {
        return new Response("ok", { headers: CORS });
      }
      if (JSON.stringify(old) !== JSON.stringify(r)) await env.USERS.put(key, JSON.stringify(r));
      if (firstOpen) ctx.waitUntil(notifyJoin(env, who, r).catch(() => {}));
      return new Response(JSON.stringify({ cfg: r.cfg ? { on: r.on, hour: r.hour, count: r.count } : null }), { headers: Object.assign({ "content-type": "application/json" }, CORS) });
    }

    // ответы на кнопки в чате
    if (url.pathname === "/ics" && req.method === "GET") {
      const date = url.searchParams.get("d") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response("bad date", { status: 400 });
      return new Response(icsFile(cut(url.searchParams.get("t"), 200), date, String(url.searchParams.get("n") || "").slice(0, 1000)), { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": "attachment; filename=\"prokachka-" + date + ".ics\"" } });
    }
    if (url.pathname === "/tq" && req.method === "POST") {
      if (!env.DB) return J({ error: "no db" }, 500);
      const b = await req.json().catch(() => null);
      const u = b && b.initData ? await checkUser(env, String(b.initData)) : null;
      if (!u) return J({ error: "bad" }, 401);
      return J(await tqOp(env, ctx, u, b));
    }
    if ((url.pathname === "/st" || url.pathname === "/verify") && req.method === "POST") {
      if (!env.DB) return J({ error: "no db" }, 500);
      const b = await req.json().catch(() => null);
      const uid = b && b.initData ? await checkInitData(env, String(b.initData)) : null;
      if (!uid) return J({ error: "bad" }, 401);
      if (url.pathname === "/st") return J(await stSync(env, uid, b));
      const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : localNow(b.tz).date;
      const res = await tg(env, "sendMessage", { chat_id: uid, text: await verifyText(env, uid, date), reply_markup: verifyKb });
      return J({ ok: !!res.ok });
    }

    if (url.pathname === path && req.method === "POST") {
      const u = await req.json().catch(() => null);
      const cq = u && u.callback_query;
      if (cq && cq.data && env.USERS) {
        const uid = cq.from.id, key = "u:" + uid;
        const r = Object.assign(defRec(), { offered: true }, await env.USERS.get(key, "json") || {});
        const chat = cq.message.chat.id, mid = cq.message.message_id;
        const [kind, val] = cq.data.split(":");
        if (kind === "ev") {
          let out;
          if (val === "menu") out = await evMenu(env, uid);
          else {
            const text = val === "q" ? await evQuest(env, uid, cq.data.slice(5)) : val === "my" ? await evMine(env, uid) : val === "app" ? await evApp() : val === "dev" && uid === OWNER ? await evDev(env) : "нет доступа";
            out = { text: text.slice(0, 4000), reply_markup: EV_BACK };
          }
          await tg(env, "editMessageText", Object.assign({ chat_id: chat, message_id: mid, disable_web_page_preview: true }, out));
          await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
          return new Response("ok");
        }
        if (kind === "s") {
          // сервер уже хранит один общий список: подтверждаем и напоминаем, что устройства подтянут его сами
          const ver = env.DB ? await env.DB.prepare("SELECT ver FROM st WHERE uid = ?1").bind(uid).first() : null;
          const t = (cq.message.text || "").replace(/\n\nвсё верно\?[\s\S]*$/, "");
          await tg(env, "editMessageText", { chat_id: chat, message_id: mid, text: (t + "\n\n✅ синхронизировано" + (ver ? "" : " (данных на сервере пока нет, открой приложение)") + ". открой прокачку на любом устройстве: там будет этот же список, приложение подтянет его само.").slice(0, 4000), reply_markup: appBtn("открыть прокачку") });
        } else if (kind === "sup") {
          await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } });
          if (val === "on") await supStart(env, chat, r); else await supStop(env, chat, r);
        } else if (kind === "nw") {
          r.news = true; await env.USERS.put(key, JSON.stringify(r));
          await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: menuKb(r) });
          await tg(env, "sendMessage", { chat_id: chat, text: "хорошо, новости снова буду присылать." });
        } else if (kind === "x") {
          if (val === "news") r.news = false; else if (val === "wk") r.wkOn = false; else r.rep = false;
          await env.USERS.put(key, JSON.stringify(r));
          await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: appBtn("открыть прокачку") });
          await tg(env, "sendMessage", { chat_id: chat, text: val === "news" ? "новости больше не буду присылать. если передумаешь, напиши мне /news" : (val === "wk" ? "итоги недели" : "итоги дня") + " больше не буду присылать. вернуть можно в настройках приложения." });
        } else if (kind === "b") {
          const b = uid === OWNER ? await env.USERS.get("bc:cur", "json") : null;
          if (b && b.state === "draft") {
            await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } });
            if (val === "go") {
              b.state = "sending"; await env.USERS.put("bc:cur", JSON.stringify(b));
              await tg(env, "sendMessage", { chat_id: chat, text: "отправляю. если людей много, остаток дойдёт с ближайшими запусками, в конце пришлю отчёт." });
              ctx.waitUntil(bcRun(env));
            } else {
              b.state = "cancelled"; await env.USERS.put("bc:cur", JSON.stringify(b));
              await tg(env, "sendMessage", { chat_id: chat, text: "отменила, никому не ушло." });
            }
          }
        } else if (kind === "n") {
          const n = Number(val);
          if (!n) {
            r.on = false; r.cfg = true;
            await env.USERS.put(key, JSON.stringify(r));
            await tg(env, "editMessageText", { chat_id: chat, message_id: mid, text: "хорошо, не буду напоминать. включить можно в настройках приложения." });
          } else {
            r.count = n; await env.USERS.put(key, JSON.stringify(r));
            await tg(env, "editMessageText", { chat_id: chat, message_id: mid, text: n === 1 ? "во сколько напоминать?" : "во сколько первое напоминание? остальные разложу по дню сама.", reply_markup: hoursKb });
          }
        } else if (kind === "t") {
          r.hour = Number(val); r.times = timesFor(r.hour, r.count); r.on = true; r.cfg = true;
          await env.USERS.put(key, JSON.stringify(r));
          await tg(env, "editMessageText", { chat_id: chat, message_id: mid, text: "готово. напомню в " + r.times.map(hh).join(", ") + ", если за день будет пусто или останутся дела в планах. поменять можно в настройках приложения.", reply_markup: appBtn("открыть прокачку") });
        }
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
        return new Response("ok");
      }
      const m = u && u.message;
      if (m && m.chat && m.chat.type === "private") {
        const chat = m.chat.id;
        const rec = env.USERS ? Object.assign(defRec(), await env.USERS.get("u:" + chat, "json") || {}) : null;
        const raw = m.text || m.caption || "";
        if (/^\/(events|48)(@\w+)?\s*$/.test(raw)) {
          await tg(env, "sendMessage", Object.assign({ chat_id: chat }, await evMenu(env, chat)));
          return new Response("ok");
        }
        if (/^\/news(@\w+)?\s*$/.test(raw) && rec) {
          rec.news = true; await env.USERS.put("u:" + chat, JSON.stringify(rec));
          await tg(env, "sendMessage", { chat_id: chat, text: "хорошо, новости снова буду присылать." });
          return new Response("ok");
        }
        if (m.from && m.from.id === OWNER && env.USERS && /^\/add(@\w+)?(\s|$)/.test(raw)) {
          const body = raw.replace(/^\/add(@\w+)?\s*/, "");
          if (!body.trim()) { await tg(env, "sendMessage", { chat_id: chat, text: CAL_HELP }); return new Response("ok"); }
          const r = await calAdd(env, body);
          await tg(env, "sendMessage", { chat_id: chat, text: (r.ok.length ? "добавила 📅\n" + r.ok.join("\n") + "\n\nв календаре на айфоне появится в течение часа" : "") + (r.bad.length ? (r.ok.length ? "\n\n" : "") + r.bad.join("\n") + "\n\nпример: /add 24.11 18:30 эфир" : "") });
          return new Response("ok");
        }
        if (m.from && m.from.id === OWNER && env.USERS && /^\/list(@\w+)?\s*$/.test(raw)) {
          await tg(env, "sendMessage", { chat_id: chat, text: await calList(env) });
          return new Response("ok");
        }
        if (m.from && m.from.id === OWNER && env.USERS && /^\/del(@\w+)?(\s|$)/.test(raw)) {
          const nums = (raw.match(/\d+/g) || []).map(Number);
          await tg(env, "sendMessage", { chat_id: chat, text: nums.length ? await calDel(env, nums) : "укажи номер из /list, например: /del 2" });
          return new Response("ok");
        }
        if (m.from && m.from.id === OWNER && env.USERS && /^\/calendar(@\w+)?\s*$/.test(raw)) {
          await tg(env, "sendMessage", { chat_id: chat, text: await calLinks(env, new URL(req.url).origin), disable_web_page_preview: true });
          return new Response("ok");
        }
        if (m.from && m.from.id === OWNER && env.USERS && m.document && (/\.ics$/i.test(m.document.file_name || "") || /calendar/.test(m.document.mime_type || ""))) {
          const f = await tg(env, "getFile", { file_id: m.document.file_id });
          const txt = f.ok ? await (await fetch("https://api.telegram.org/file/bot" + env.BOT_TOKEN + "/" + f.result.file_path)).text() : "";
          const n = txt ? await calSave(env, txt) : 0;
          await tg(env, "sendMessage", { chat_id: chat, text: n ? "добавила событий: " + n + " 📅\n\n" + await calLinks(env, new URL(req.url).origin) : "не нашла событий в этом файле", disable_web_page_preview: true });
          return new Response("ok");
        }
        if (rec) ctx.waitUntil(setCommands(env));
        // ответ владельца на обращение: reply на пересланное сообщение уходит человеку
        if (m.from && m.from.id === OWNER && m.reply_to_message && env.USERS && !/^\/send/.test(raw)) {
          const to = await env.USERS.get("sr:" + m.reply_to_message.message_id);
          if (to) {
            await tg(env, "sendMessage", { chat_id: Number(to), text: "💬 ответ от поддержки прокачки:" });
            const c = await tg(env, "copyMessage", { chat_id: Number(to), from_chat_id: chat, message_id: m.message_id });
            await tg(env, "sendMessage", { chat_id: chat, text: c.ok ? "ответ отправлен ✅" : "не получилось отправить: " + (c.description || "ошибка") });
            return new Response("ok");
          }
        }
        if (/^\/(menu|help)(@\w+)?\s*$/.test(raw) && rec) {
          if (rec.sup) await supStop(env, chat, rec, true);
          await tg(env, "sendMessage", { chat_id: chat, text: "меню прокачки", reply_markup: menuKb(rec) });
          return new Response("ok");
        }
        if (/^\/support(@\w+)?\s*$/.test(raw) && rec) { await supStart(env, chat, rec); return new Response("ok"); }
        if (/^\/done(@\w+)?\s*$/.test(raw) && rec) { await supStop(env, chat, rec); return new Response("ok"); }
        // картинки владельца для рассылки собираем раньше поддержки: иначе в режиме поддержки каждое фото альбома уходило отдельно
        if (m.from && m.from.id === OWNER && mediaOf(m) && env.USERS && env.DB) {
          let gid = m.media_group_id ? String(m.media_group_id) : "";
          // фото, присланные по одному после /send и текста, тоже склеиваем в один альбом, а не в отдельные посты
          if (!gid && !raw) {
            const cd = await env.USERS.get("bc:cur", "json");
            if (cd && cd.state === "draft" && Date.now() - parseInt(cd.id, 36) < 3600000) gid = "d:" + cd.id;
          }
          if (gid) {
            if (await bcpAdd(env, m, gid)) ctx.waitUntil(albumFlow(env, chat, gid));
            return new Response("ok");
          }
        }
        if (rec && rec.sup && Date.now() - rec.sup < SUP_TTL && !/^\//.test(raw)) { await supForward(env, m, rec); return new Response("ok"); }
        // одиночная картинка без подписи сразу после текста /send — приклеиваем к нему
        let sendLike = /^\/send(@\w+)?(\s|$)/.test(raw);
        if (!sendLike && m.from && m.from.id === OWNER && (m.photo || m.video || m.animation) && !raw && env.USERS) {
          const cd = await env.USERS.get("bc:cur", "json");
          if (cd && cd.state === "draft" && cd.type === "text" && Date.now() - parseInt(cd.id, 36) < 3600000) sendLike = true;
        }
        if (sendLike && m.from && m.from.id === OWNER && env.USERS) {
          const pre = raw.length - raw.replace(/^\/send(@\w+)?\s*/, "").length;
          const text = raw.slice(pre).replace(/\s+$/, "");
          const ents = (m.entities || m.caption_entities || []).filter(x => x.offset >= pre && x.offset + x.length <= pre + text.length && x.type !== "bot_command").map(x => Object.assign({}, x, { offset: x.offset - pre }));
          let type = "text", file = "";
          if (m.photo && m.photo.length) { type = m.media_group_id ? "album" : "photo"; file = m.photo[m.photo.length - 1].file_id; }
          else if (m.animation) { type = "animation"; file = m.animation.file_id; }
          else if (m.video) { type = "video"; file = m.video.file_id; }
          const cur = await env.USERS.get("bc:cur", "json");
          if (cur && cur.state === "sending") { await tg(env, "sendMessage", { chat_id: chat, text: "прошлая рассылка ещё идёт, подожди отчёта." }); return new Response("ok"); }
          if (!text && type === "text") { await tg(env, "sendMessage", { chat_id: chat, text: "как отправить новость:\n\n1) /send и текст — любой длины, жирный и ссылки сохранятся\n2) потом картинки (можно альбомом до 10 штук), гифку или видео — приклею их к этому тексту\n\nможно и сразу картинки с текстом в подписи. если текст длиннее подписи, он придёт отдельным сообщением сразу под картинками." }); return new Response("ok"); }
          const b = { id: Date.now().toString(36), text: text || "", ents, type, file, state: "draft", ok: 0, fail: 0, skip: 0 };
          // склейка черновика: сначала текст, потом картинки (или наоборот)
          if (cur && cur.state === "draft" && Date.now() - parseInt(cur.id, 36) < 3600000) {
            if (type !== "text" && !text && cur.text) { b.text = cur.text; b.ents = cur.ents || []; }
            if (type === "text" && cur.type !== "text") { b.type = cur.type; b.file = cur.file; b.files = cur.files; b.media = cur.media; }
          }
          await env.USERS.put("bc:cur", JSON.stringify(b));
          await tg(env, "sendMessage", { chat_id: chat, text: "так увидят люди" + (b.type === "text" ? ". можешь прислать картинки или альбом следующим сообщением, приклею их к тексту." : "") + (b.text.length > CAP && b.type !== "text" ? "\n(текст длиннее подписи, поэтому придёт отдельным сообщением под картинками)" : "") });
          await bcSend(env, chat, b, BC_KB);
          return new Response("ok");
        }
        if (/^\/stats/.test(m.text || "") && m.from && m.from.id === OWNER && env.USERS) {
          const d = await statsPage(env, true);
          const L = ["статистика прокачки", "",
            "людей зашло всего: " + d.total,
            "были в приложении за 7 дней: " + d.w7,
            "вернулись на другой день: " + d.back + " из " + d.total,
            "включили напоминания: " + d.rem,
            "получают итоги дня: " + d.rep,
            "бот не смог им написать: " + d.blocked, "",
            "сколько людей заходило по дням:"];
          d.days.slice(-7).forEach(x => L.push(x[0] + " число: " + x[1]));
          const PN = { design: "дизайнеры", dev: "разработчики", ai: "нейросети и ии", mkt: "маркетологи", creator: "авторы контента", biz: "предприниматели", law: "юристы", med: "врачи", teach: "преподаватели", stud: "студенты", beauty: "мастера бьюти", coach: "тренеры", parent: "родители", other: "другое" };
          if (d.profs.length) { L.push("", "чем занимаются:"); d.profs.forEach(p => L.push((PN[p[0]] || p[0]) + ": " + p[1])); }
          L.push("", "цифры по дням и профессиям копятся с момента обновления бота");
          await tg(env, "sendMessage", { chat_id: chat, text: L.join("\n") });
          return new Response("ok");
        }
        const inv = /^\/start\s+tqj_([a-z0-9]{6,20})/.exec(m.text || "");
        if (inv && env.DB) {
          await dbInit(env);
          const q = await env.DB.prepare("SELECT data FROM tq WHERE code = ?1").bind(inv[1]).first();
          const d = q ? pj(q.data) : null;
          await tg(env, "sendMessage", { chat_id: chat, text: d ? "тебя позвали в командный квест «" + d.title + "»" + (d.deadline ? " (до " + ddmm(d.deadline) + ")" : "") + ".\nнажми кнопку, чтобы присоединиться: будешь видеть задачи команды, а я буду писать, когда кто-то что-то сделал." : "приглашение устарело или квест закрыли. попроси новую ссылку.", reply_markup: d ? { inline_keyboard: [[{ text: "присоединиться", web_app: { url: APP + "#tqj=" + inv[1] } }]] } : appBtn("открыть прокачку") });
          return new Response("ok");
        }
        const isStart = /^\/start/.test(m.text || "");
        if (isStart && rec && !rec.cfg) {
          // 1) то же, что в описании бота: картинка и текст
          const d = await tg(env, "getMyDescription", {});
          const text = (d.result && d.result.description) || "привет! это мини-апка, которая превратит твою жизнь в игру с ачивками.";
          const ph = await tg(env, "sendPhoto", { chat_id: chat, photo: APP + "/welcome.jpg", caption: text.slice(0, 1000), reply_markup: appBtn("открыть прокачку") });
          if (!ph.ok) await tg(env, "sendMessage", { chat_id: chat, text, reply_markup: appBtn("открыть прокачку") });
          // 2) настройка напоминаний
          const res = await tg(env, "sendMessage", { chat_id: chat, text: offerText, reply_markup: offerKb });
          rec.offered = !!res.ok; rec.err = res.ok ? "" : String(res.description || "fail");
          rec.nm = cut([m.from.first_name, m.from.last_name].filter(Boolean).join(" "), 40); rec.un = cut(m.from.username, 40);
          await env.USERS.put("u:" + chat, JSON.stringify(rec));
        } else {
          await tg(env, "sendMessage", { chat_id: chat, text: pick(HELLO), reply_markup: appBtn("открыть прокачку") });
        }
      }
      return new Response("ok");
    }
    return new Response("прокачка", { status: 200 });
  },

  async scheduled(event, env) {
    if (!env.BOT_TOKEN || !env.USERS) return;
    await bcRun(env);
    try { await tqRemind(env); } catch (e) {}
    let cursor;
    do {
      const l = await env.USERS.list({ prefix: "u:", cursor });
      for (const k of l.keys) {
        const r = await env.USERS.get(k.name, "json");
        if (!r || !r.on) continue;
        const chat = Number(k.name.slice(2));
        const t = localNow(r.tz);
        if (!r.sent || r.sent.d !== t.date) r.sent = Object.assign({}, r.sent, { d: t.date, h: [] });
        let dirty = false;
        // напоминания
        const slot = (r.times || []).find(h => t.hour >= h && t.hour <= h + 1 && !r.sent.h.includes(h));
        if (slot !== undefined) {
          const hasTodo = (r.todo || []).length > 0 || !!r.quest;
          if (!(r.last === t.date && !hasTodo)) {
            const res = await tg(env, "sendMessage", { chat_id: chat, text: reminderText(r), reply_markup: appBtn("открыть прокачку") });
            if (res.ok) r.sent.h.push(slot); else if (res.error_code === 403) r.on = false;
            dirty = true;
          }
        }
        // итоги недели: воскресенье, 19:00
        const dow = new Date(Date.parse(t.date + "T00:00:00Z")).getUTCDay();
        if (r.on && r.wkOn !== false && dow === 0 && t.hour >= 19 && t.hour <= 20 && r.sent.wk !== t.date) {
          const txt = weekText(r, t.date);
          const res = await tg(env, "sendMessage", { chat_id: chat, text: txt, reply_markup: repKb("wk", txt.replace("итоги недели\n\n", "моя неделя в прокачке: ")) });
          r.sent.wk = t.date; if (res.error_code === 403) r.on = false; dirty = true;
        }
        // итоги дня: 21:00
        if (r.on && r.rep !== false && t.hour >= 21 && t.hour <= 22 && r.sent.rep !== t.date) {
          const txt = dayText(r, t.date);
          const res = await tg(env, "sendMessage", { chat_id: chat, text: txt || MISS, reply_markup: txt ? repKb("rep") : appBtn("открыть прокачку") });
          r.sent.rep = t.date; if (res.error_code === 403) r.on = false; dirty = true;
        }
        if (dirty) await env.USERS.put(k.name, JSON.stringify(r));
      }
      cursor = l.list_complete ? undefined : l.cursor;
    } while (cursor);
  },
};
