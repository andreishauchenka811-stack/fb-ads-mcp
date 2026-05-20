import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import fetch from "node-fetch";

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const META_TOKEN = process.env.META_TOKEN;
const BASE = "https://graph.facebook.com/v19.0";

const ACCOUNTS = {
  chizy:  process.env.ACCOUNT_ID_1 || process.env.META_ACCOUNT_ID,
  letniy: process.env.ACCOUNT_ID_2 || process.env.META_ACCOUNT_ID,
  pp:     process.env.ACCOUNT_ID_3 || process.env.META_ACCOUNT_ID,
};

const CPP_ALERT = 8;
const ALERT_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 часа между одинаковыми алертами

// Память алертов: alertKey -> timestamp последней отправки
const alertSentAt = new Map();

const bot = new TelegramBot(TOKEN, { polling: false });

// Сбрасываем webhook через прямой fetch (deleteWebhook недоступен в 0.63.0)
// Без этого при деплое два процесса дерутся за polling → 409 Conflict
fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook?drop_pending_updates=true`)
  .then(() => bot.startPolling({ restart: false }))
  .catch((e) => console.error("[TG] Init error:", e.message));

bot.on("polling_error", (e) => {
  if (e.message && e.message.includes("409")) {
    console.warn("[TG] 409 Conflict — старый процесс ещё не умер, ждём...");
  } else {
    console.error("[TG] Polling error:", e.message);
  }
});

// -- Meta helpers -----------------------------------------------------------

async function mGet(path, params = {}) {
  const qs = new URLSearchParams({ access_token: META_TOKEN, ...params });
  const r = await fetch(`${BASE}${path}?${qs}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d;
}

async function mPost(path, body = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: META_TOKEN, ...body }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d;
}

function fmtDate(d) { return d.toISOString().split("T")[0]; }
function todayRange()     { const t = fmtDate(new Date()); return { time_range: JSON.stringify({ since: t, until: t }) }; }
function yesterdayRange() { const d = new Date(); d.setDate(d.getDate()-1); const y = fmtDate(d); return { time_range: JSON.stringify({ since: y, until: y }) }; }
function dateRange(days)  { const u = new Date(); const s = new Date(u); s.setDate(u.getDate()-(days-1)); return { time_range: JSON.stringify({ since: fmtDate(s), until: fmtDate(u) }) }; }

const ATTR = JSON.stringify(["7d_click","1d_view"]);
const F    = "spend,impressions,clicks,ctr,actions,action_values";

function parsePurchases(ins) {
  if (!ins) return { purchases: 0, cpp: null, revenue: 0, roas: null, spend: 0 };
  const spend     = parseFloat(ins.spend || 0);
  const purchases = parseInt(ins.actions?.find((a) => a.action_type === "purchase")?.value || 0);
  const revenue   = parseFloat(ins.action_values?.find((a) => a.action_type === "purchase")?.value || 0);
  const cpp  = purchases > 0 ? (spend / purchases).toFixed(2) : null;
  const roas = spend > 0 && revenue > 0 ? (revenue / spend).toFixed(2) : null;
  return { purchases, cpp, revenue, roas, spend };
}

function uniqueAccounts() {
  const seen = new Set();
  return Object.keys(ACCOUNTS).filter((k) => {
    if (!ACCOUNTS[k] || seen.has(ACCOUNTS[k])) return false;
    seen.add(ACCOUNTS[k]); return true;
  });
}

// Проверка кулдауна — возвращает true если алерт можно отправить
function canAlert(key) {
  const last = alertSentAt.get(key);
  if (!last || Date.now() - last > ALERT_COOLDOWN_MS) {
    alertSentAt.set(key, Date.now());
    return true;
  }
  return false;
}

// -- Keyboards --------------------------------------------------------------

const MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "📊 Отчёт",    callback_data: "report" },
      { text: "⚠️ Алерты",  callback_data: "alerts" },
      { text: "📡 Статус",   callback_data: "status" },
    ],
    [
      { text: "📅 Сегодня",  callback_data: "today" },
      { text: "🏆 Топ крео", callback_data: "top" },
      { text: "⏸ На паузе", callback_data: "paused" },
    ],
  ],
};

function pauseKeyboard(entityType, entityId) {
  return {
    inline_keyboard: [[
      { text: `⏸ Выключить`, callback_data: `pause:${entityType}:${entityId}` },
      { text: `✅ Понял, слежу`, callback_data: `dismiss` },
    ]],
  };
}

// -- Report builders --------------------------------------------------------

// УТРО: итоги вчера — потому что в 9:00 сегодня ещё нечего смотреть
async function buildMorningReport(accKey) {
  const accId = ACCOUNTS[accKey];
  const [y, week] = await Promise.all([
    mGet(`/act_${accId}/insights`, { fields: F, level: "account", ...yesterdayRange(), action_attribution_windows: ATTR }),
    mGet(`/act_${accId}/insights`, { fields: F, level: "account", ...dateRange(7), action_attribution_windows: ATTR }),
  ]);
  const yd = parsePurchases(y.data?.[0]);
  const w  = parsePurchases(week.data?.[0]);
  const yIns = y.data?.[0] || {};

  const cppFlag = yd.cpp && parseFloat(yd.cpp) > CPP_ALERT ? " 🔴" : yd.cpp ? " ✅" : "";
  const avgCpp7d = w.purchases > 0 ? (w.spend / w.purchases).toFixed(2) : null;

  return [
    `🌅 *${accKey.toUpperCase()}* — итоги вчера`,
    `💰 Расход: *$${yd.spend.toFixed(2)}*`,
    `🛒 Покупки: *${yd.purchases}*`,
    `📈 CPP: *${yd.cpp ? `$${yd.cpp}` : "нет"}*${cppFlag}`,
    `👁 CTR: ${yIns.ctr ? `${parseFloat(yIns.ctr).toFixed(2)}%` : "0%"}`,
    avgCpp7d ? `📊 CPP за 7д: $${avgCpp7d}` : "",
  ].filter(Boolean).join("\n");
}

// ДЕНЬ: текущий срез по кампаниям
async function buildMiddayReport(accKey) {
  const accId = ACCOUNTS[accKey];
  const [t, pacing] = await Promise.all([
    mGet(`/act_${accId}/insights`, { fields: F, level: "account", ...todayRange(), action_attribution_windows: ATTR }),
    mGet(`/act_${accId}/campaigns`, {
      fields: `name,daily_budget,insights{spend}`,
      ...todayRange(), limit: 20,
      filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    }),
  ]);
  const td   = parsePurchases(t.data?.[0]);
  const tIns = t.data?.[0] || {};

  // Проверяем бюджеты
  const budgetWarnings = [];
  for (const c of pacing.data || []) {
    if (!c.daily_budget) continue;
    const budget  = parseFloat(c.daily_budget) / 100;
    const spent   = parseFloat(c.insights?.data?.[0]?.spend || 0);
    const pct     = budget > 0 ? spent / budget : 0;
    if (pct >= 0.8) budgetWarnings.push(`⚡ ${c.name.substring(0, 25)}: ${Math.round(pct*100)}% бюджета`);
  }

  const lines = [
    `☀️ *${accKey.toUpperCase()}* — дневной срез`,
    `💰 Расход: *$${td.spend.toFixed(2)}*`,
    `🛒 Покупки: *${td.purchases}*`,
    `📈 CPP: *${td.cpp ? `$${td.cpp}` : "нет"}*`,
    `👁 CTR: ${tIns.ctr ? `${parseFloat(tIns.ctr).toFixed(2)}%` : "0%"}`,
  ];
  if (budgetWarnings.length) lines.push("", ...budgetWarnings);
  return lines.join("\n");
}

// ВЕЧЕР: итог дня + конкретные рекомендации
async function buildEveningReport(accKey) {
  const accId = ACCOUNTS[accKey];
  const [t, y, adsData] = await Promise.all([
    mGet(`/act_${accId}/insights`, { fields: F, level: "account", ...todayRange(), action_attribution_windows: ATTR }),
    mGet(`/act_${accId}/insights`, { fields: F, level: "account", ...yesterdayRange(), action_attribution_windows: ATTR }),
    mGet(`/act_${accId}/ads`, {
      fields: `name,status,campaign{name},insights{${F}}`,
      ...todayRange(), action_attribution_windows: ATTR, limit: 100,
    }),
  ]);

  const td   = parsePurchases(t.data?.[0]);
  const yd   = parsePurchases(y.data?.[0]);
  const tIns = t.data?.[0] || {};

  const ads = (adsData.data || []).map((a) => {
    const ins = a.insights?.data?.[0];
    const { purchases, cpp, spend } = parsePurchases(ins);
    return { id: a.id, name: a.name, campaign: a.campaign?.name, status: a.status, spend, purchases, cpp: cpp ? parseFloat(cpp) : null };
  });

  const toScale = ads.filter((a) => a.purchases >= 2 && a.cpp && a.cpp < CPP_ALERT).sort((a, b) => a.cpp - b.cpp).slice(0, 3);
  const toKill  = ads.filter((a) => a.spend >= 4 && a.purchases === 0 && a.status === "ACTIVE");

  const spendDiff = td.spend - yd.spend;
  const purDiff   = td.purchases - yd.purchases;

  const lines = [
    `🌙 *${accKey.toUpperCase()}* — итог дня`,
    `💰 Расход: *$${td.spend.toFixed(2)}* (${spendDiff >= 0 ? "+" : ""}$${spendDiff.toFixed(2)} vs вчера)`,
    `🛒 Покупки: *${td.purchases}* (${purDiff >= 0 ? "+" : ""}${purDiff} vs вчера)`,
    `📈 CPP: *${td.cpp ? `$${td.cpp}` : "нет"}*`,
    `👁 CTR: ${tIns.ctr ? `${parseFloat(tIns.ctr).toFixed(2)}%` : "0%"}`,
  ];

  if (toScale.length) {
    lines.push("", "🚀 *Масштабировать завтра:*");
    toScale.forEach((a) => lines.push(`• ${a.name.substring(0, 30)} — CPP $${a.cpp.toFixed(2)}, ${a.purchases} 🛒`));
  }

  if (toKill.length) {
    lines.push("", "🔴 *Выключить:*");
    toKill.forEach((a) => lines.push(`• ${a.name.substring(0, 30)} — $${a.spend.toFixed(2)} без покупок`));
  }

  if (!toScale.length && !toKill.length) lines.push("", "✅ Всё в норме, действий не требуется");

  return lines.join("\n");
}

// АЛЕРТЫ: с кулдауном, возвращает массив { text, keyboard } или []
async function buildAlerts(accKey) {
  const accId = ACCOUNTS[accKey];

  // Адсеты
  const [adsetsData, campaignsData] = await Promise.all([
    mGet(`/act_${accId}/adsets`, {
      fields: "id,name,status,daily_budget,insights{spend,ctr,frequency,actions}",
      ...todayRange(), action_attribution_windows: ATTR, limit: 100,
      filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    }),
    mGet(`/act_${accId}/campaigns`, {
      fields: "id,name,daily_budget,insights{spend}",
      ...todayRange(), limit: 50,
      filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    }),
  ]);

  const messages = [];

  // --- Алерты по адсетам ---
  for (const a of adsetsData.data || []) {
    const ins   = a.insights?.data?.[0];
    const spend = parseFloat(ins?.spend || 0);
    const ctr   = parseFloat(ins?.ctr || 0);
    const freq  = parseFloat(ins?.frequency || 0);
    const purch = parseInt(ins?.actions?.find((x) => x.action_type === "purchase")?.value || 0);
    const cpp   = purch > 0 ? spend / purch : null;

    if (spend >= 4 && purch === 0) {
      const key = `no_conv:${a.id}`;
      if (canAlert(key)) {
        messages.push({
          text: `🔴 *Нет конверсий*\n${accKey.toUpperCase()} · ${a.name.substring(0, 35)}\nПотрачено $${spend.toFixed(2)} без покупок`,
          keyboard: pauseKeyboard("adset", a.id),
        });
      }
    }

    if (cpp && cpp > CPP_ALERT) {
      const key = `high_cpp:${a.id}`;
      if (canAlert(key)) {
        messages.push({
          text: `🟡 *Высокий CPP*\n${accKey.toUpperCase()} · ${a.name.substring(0, 35)}\nCPP $${cpp.toFixed(2)} > $${CPP_ALERT} (${purch} покупок)`,
          keyboard: pauseKeyboard("adset", a.id),
        });
      }
    }

    if (freq > 3) {
      const key = `freq:${a.id}`;
      if (canAlert(key)) {
        messages.push({
          text: `🟠 *Усталость аудитории*\n${accKey.toUpperCase()} · ${a.name.substring(0, 35)}\nЧастота ${freq.toFixed(2)} — пора менять крео`,
          keyboard: pauseKeyboard("adset", a.id),
        });
      }
    }
  }

  // --- Алерт на исчерпание бюджета кампании ---
  const now = new Date();
  const dayPassedPct = (now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440;

  for (const c of campaignsData.data || []) {
    if (!c.daily_budget) continue;
    const budget = parseFloat(c.daily_budget) / 100;
    const spent  = parseFloat(c.insights?.data?.[0]?.spend || 0);
    const pct    = spent / budget;

    // Если потрачено > 80% а день ещё не прошёл на 80%
    if (pct >= 0.8 && dayPassedPct < 0.8) {
      const key = `budget80:${c.id}`;
      if (canAlert(key)) {
        messages.push({
          text: `⚡ *Бюджет заканчивается*\n${accKey.toUpperCase()} · ${c.name.substring(0, 35)}\n$${spent.toFixed(2)} из $${budget.toFixed(2)} (${Math.round(pct*100)}%) — а день только на ${Math.round(dayPassedPct*100)}%`,
          keyboard: null,
        });
      }
    }
  }

  return messages;
}

// -- Send helpers -----------------------------------------------------------

function send(text, opts = {}) {
  return bot.sendMessage(CHAT_ID, text, { parse_mode: "Markdown", ...opts })
    .catch((e) => console.error("TG send error:", e.message));
}

function sendMenu(text) { return send(text, { reply_markup: MENU_KEYBOARD }); }

async function runForAll(builder, withMenu = false) {
  for (const key of uniqueAccounts()) {
    try {
      const result = await builder(key);
      if (withMenu) await send(result, { reply_markup: MENU_KEYBOARD });
      else await send(result);
    } catch (e) {
      await send(`❌ Ошибка ${key}: ${e.message}`);
    }
  }
}

// -- Cron (Kyiv summer UTC+3) -----------------------------------------------

// 9:00 Kyiv = 06:00 UTC — утро: итоги вчера
cron.schedule("0 6 * * *", async () => {
  console.log("[TG] Morning report");
  await send("🌅 *Доброе утро — итоги вчера:*");
  await runForAll(buildMorningReport, true);
});

// 14:00 Kyiv = 11:00 UTC — дневной срез
cron.schedule("0 11 * * *", async () => {
  console.log("[TG] Midday report");
  await send("☀️ *Дневной срез:*");
  await runForAll(buildMiddayReport, true);
});

// 21:00 Kyiv = 18:00 UTC — вечер: итог + рекомендации
cron.schedule("0 18 * * *", async () => {
  console.log("[TG] Evening report");
  await runForAll(buildEveningReport, true);
});

// Алерты каждые 30 мин 8:00-22:00 UTC — с кулдауном
cron.schedule("*/30 8-22 * * *", async () => {
  console.log("[TG] Alert check");
  for (const key of uniqueAccounts()) {
    try {
      const alerts = await buildAlerts(key);
      for (const alert of alerts) {
        const opts = { parse_mode: "Markdown" };
        if (alert.keyboard) opts.reply_markup = alert.keyboard;
        await bot.sendMessage(CHAT_ID, alert.text, opts).catch((e) => console.error("TG alert error:", e.message));
      }
    } catch (e) {
      console.error(`[TG] Alert error ${key}:`, e.message);
    }
  }
});

// -- Commands ---------------------------------------------------------------

bot.onText(/\/start/, () => sendMenu(
  `👋 *FB Ads Manager v4.0.0*\n\nАлерты приходят автоматически только когда нужно вмешательство.\nРасписание: 9:00 · 14:00 · 21:00\n\nБыстрые команды:`
));

bot.onText(/\/menu/,   () => sendMenu("📋 Меню:"));
bot.onText(/\/report/, async () => { await send("⏳..."); await runForAll(buildMorningReport, true); });
bot.onText(/\/today/,  async () => { await send("⏳..."); await runForAll(buildMiddayReport, true); });
bot.onText(/\/evening/,async () => { await send("⏳..."); await runForAll(buildEveningReport, true); });

bot.onText(/\/alerts/, async () => {
  await send("⏳ Проверяю...");
  let found = false;
  for (const key of uniqueAccounts()) {
    try {
      const alerts = await buildAlerts(key);
      // При ручном запросе игнорируем кулдаун — просто показываем текущие
      if (alerts.length) {
        found = true;
        for (const alert of alerts) {
          const opts = { parse_mode: "Markdown" };
          if (alert.keyboard) opts.reply_markup = alert.keyboard;
          await bot.sendMessage(CHAT_ID, alert.text, opts);
        }
      }
    } catch (e) { await send(`❌ Ошибка ${key}: ${e.message}`); }
  }
  if (!found) await sendMenu("✅ Алертов нет — всё в норме");
});

bot.onText(/\/status/, async () => {
  const lines = ["📡 *Статус аккаунтов:*"];
  for (const [key, id] of Object.entries(ACCOUNTS)) {
    if (!id) continue;
    try {
      const info = await mGet(`/act_${id}`, { fields: "name,account_status" });
      lines.push(`• ${key}: ${info.name} — ${info.account_status === 1 ? "✅ ACTIVE" : "⚠️ " + info.account_status}`);
    } catch (e) { lines.push(`• ${key}: ❌ ${e.message}`); }
  }
  await send(lines.join("\n"), { reply_markup: MENU_KEYBOARD });
});

bot.onText(/\/top/, async () => {
  await send("⏳...");
  for (const key of uniqueAccounts()) {
    try {
      const accId = ACCOUNTS[key];
      const data = await mGet(`/act_${accId}/ads`, {
        fields: `name,insights{${F}}`,
        ...todayRange(), action_attribution_windows: ATTR, limit: 100,
        filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
      });
      const ads = (data.data || []).map((a) => {
        const { purchases, cpp, spend } = parsePurchases(a.insights?.data?.[0]);
        return { name: a.name, spend, purchases, cpp: cpp ? parseFloat(cpp) : null };
      }).filter((a) => a.purchases > 0).sort((a, b) => a.cpp - b.cpp).slice(0, 5);

      if (!ads.length) { await send(`🏆 *${key.toUpperCase()}* — конверсий сегодня нет`, { reply_markup: MENU_KEYBOARD }); continue; }
      const lines = [`🏆 *${key.toUpperCase()}* — топ объявлений:`];
      ads.forEach((a, i) => lines.push(`${i+1}. ${a.name.substring(0,30)}\n   $${a.spend.toFixed(2)} · ${a.purchases} 🛒 · CPP $${a.cpp.toFixed(2)}`));
      await send(lines.join("\n"), { reply_markup: MENU_KEYBOARD });
    } catch (e) { await send(`❌ ${key}: ${e.message}`); }
  }
});

bot.onText(/\/paused/, async () => {
  await send("⏳...");
  for (const key of uniqueAccounts()) {
    try {
      const accId = ACCOUNTS[key];
      const data = await mGet(`/act_${accId}/campaigns`, {
        fields: "name,insights{spend}",
        ...todayRange(), limit: 50,
        filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["PAUSED"] }]),
      });
      const list = (data.data || []).map((c) => {
        const spend = parseFloat(c.insights?.data?.[0]?.spend || 0);
        return `• ${c.name.substring(0,35)}${spend > 0 ? ` ($${spend.toFixed(2)} сегодня)` : ""}`;
      });
      const text = list.length
        ? `⏸ *${key.toUpperCase()}* — на паузе (${list.length}):\n` + list.join("\n")
        : `⏸ *${key.toUpperCase()}* — ничего на паузе`;
      await send(text, { reply_markup: MENU_KEYBOARD });
    } catch (e) { await send(`❌ ${key}: ${e.message}`); }
  }
});

// -- Callback buttons -------------------------------------------------------

bot.on("callback_query", async (q) => {
  await bot.answerCallbackQuery(q.id);
  const data = q.data;

  // Кнопка "Выключить" из алерта: pause:adset:123456
  if (data.startsWith("pause:")) {
    const [, entityType, entityId] = data.split(":");
    try {
      await mPost(`/${entityId}`, { status: "PAUSED" });
      await send(`⏸ Выключено (${entityType} ${entityId})`, { reply_markup: MENU_KEYBOARD });
    } catch (e) { await send(`❌ Ошибка: ${e.message}`); }
    return;
  }

  if (data === "dismiss") { await send("👌 Понял, продолжаю следить", { reply_markup: MENU_KEYBOARD }); return; }

  const map = {
    report:  () => runForAll(buildMorningReport, true),
    today:   () => runForAll(buildMiddayReport, true),
    evening: () => runForAll(buildEveningReport, true),
    top:     () => bot.emit("text", { text: "/top", chat: { id: CHAT_ID } }),
    paused:  () => bot.emit("text", { text: "/paused", chat: { id: CHAT_ID } }),
    status:  () => bot.emit("text", { text: "/status", chat: { id: CHAT_ID } }),
    alerts:  () => bot.emit("text", { text: "/alerts", chat: { id: CHAT_ID } }),
  };

  if (map[data]) {
    await send("⏳...");
    try { await map[data](); } catch (e) { await send(`❌ Ошибка: ${e.message}`); }
  }
});

// -- Текстовые команды ------------------------------------------------------

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  const text = (msg.text || "").toLowerCase().trim();

  const scaleMatch = text.match(/масштабируй\s+(\w+)\s+(\d+)\s+([\d.]+)/);
  if (scaleMatch) {
    const [, , entityId, budgetUsd] = scaleMatch;
    try {
      await mPost(`/${entityId}`, { daily_budget: Math.round(parseFloat(budgetUsd) * 100) });
      await send(`✅ Бюджет ${entityId} → $${budgetUsd}/день`, { reply_markup: MENU_KEYBOARD });
    } catch (e) { await send(`❌ ${e.message}`); }
    return;
  }

  const pauseMatch = text.match(/выключи\s+(?:\w+\s+)?(\d+)/);
  if (pauseMatch) {
    try {
      await mPost(`/${pauseMatch[1]}`, { status: "PAUSED" });
      await send(`⏸ ${pauseMatch[1]} → PAUSED`, { reply_markup: MENU_KEYBOARD });
    } catch (e) { await send(`❌ ${e.message}`); }
    return;
  }

  const enableMatch = text.match(/включи\s+(?:\w+\s+)?(\d+)/);
  if (enableMatch) {
    try {
      await mPost(`/${enableMatch[1]}`, { status: "ACTIVE" });
      await send(`▶️ ${enableMatch[1]} → ACTIVE`, { reply_markup: MENU_KEYBOARD });
    } catch (e) { await send(`❌ ${e.message}`); }
    return;
  }
});

console.log("[TG] Telegram bot started");
