import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import fetch from "node-fetch";

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const META_TOKEN = process.env.META_TOKEN;
const BASE = "https://graph.facebook.com/v19.0";

const ACCOUNTS = {
  primary: process.env.META_ACCOUNT_ID,
  chizy:   process.env.ACCOUNT_ID_1 || process.env.META_ACCOUNT_ID,
  letniy:  process.env.ACCOUNT_ID_2 || process.env.META_ACCOUNT_ID,
  pp:      process.env.ACCOUNT_ID_3 || process.env.META_ACCOUNT_ID,
};

const CPP_ALERT = 8; // порог CPP в долларах

const bot = new TelegramBot(TOKEN, { polling: true });

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
function todayRange() { const t = fmtDate(new Date()); return { time_range: JSON.stringify({ since: t, until: t }) }; }
function yesterdayRange() { const d = new Date(); d.setDate(d.getDate()-1); const y = fmtDate(d); return { time_range: JSON.stringify({ since: y, until: y }) }; }
const ATTR = JSON.stringify(["7d_click","1d_view"]);
const F = "spend,impressions,clicks,ctr,actions,action_values";

function parsePurchases(ins) {
  if (!ins) return { purchases: 0, cpp: null, revenue: 0, roas: null, spend: 0 };
  const spend = parseFloat(ins.spend || 0);
  const purchases = parseInt(ins.actions?.find((a) => a.action_type === "purchase")?.value || 0);
  const revenue = parseFloat(ins.action_values?.find((a) => a.action_type === "purchase")?.value || 0);
  const cpp = purchases > 0 ? (spend / purchases).toFixed(2) : null;
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

// -- Inline keyboard --------------------------------------------------------

const MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "📊 Отчёт", callback_data: "report" },
      { text: "⚠️ Алерты", callback_data: "alerts" },
      { text: "📡 Статус", callback_data: "status" },
    ],
    [
      { text: "📅 Сегодня", callback_data: "today" },
      { text: "🏆 Топ", callback_data: "top" },
      { text: "⏸ На паузе", callback_data: "paused" },
    ],
  ],
};

// -- Report builders --------------------------------------------------------

async function buildDailyReport(accKey) {
  const accId = ACCOUNTS[accKey] || ACCOUNTS.primary;
  const [t, y] = await Promise.all([
    mGet(`/act_${accId}/insights`, { fields: F, level: "account", time_range: todayRange().time_range, action_attribution_windows: ATTR }),
    mGet(`/act_${accId}/insights`, { fields: F, level: "account", time_range: yesterdayRange().time_range, action_attribution_windows: ATTR }),
  ]);
  const td = parsePurchases(t.data?.[0]);
  const yd = parsePurchases(y.data?.[0]);
  const tIns = t.data?.[0] || {};
  const cppWarn = td.cpp && parseFloat(td.cpp) > CPP_ALERT ? " 🔴" : "";

  return [
    `📊 *${accKey.toUpperCase()}* | ${fmtDate(new Date())}`,
    `💰 Расход: *$${td.spend.toFixed(2)}* (вчера $${yd.spend.toFixed(2)})`,
    `🛒 Покупки: *${td.purchases}* (вчера ${yd.purchases})`,
    `📈 CPP: *${td.cpp ? `$${td.cpp}` : "нет"}*${cppWarn}`,
    `🔄 ROAS: *${td.roas ? `${td.roas}x` : "нет"}*`,
    `👁 CTR: ${tIns.ctr ? `${parseFloat(tIns.ctr).toFixed(2)}%` : "0%"}`,
  ].join("\n");
}

async function buildAlertsReport(accKey) {
  const accId = ACCOUNTS[accKey] || ACCOUNTS.primary;
  const data = await mGet(`/act_${accId}/adsets`, {
    fields: "name,status,insights{spend,ctr,frequency,actions}",
    time_range: todayRange().time_range,
    action_attribution_windows: ATTR,
    limit: 100,
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
  });

  const alerts = [];
  for (const a of data.data || []) {
    const ins = a.insights?.data?.[0];
    const spend = parseFloat(ins?.spend || 0);
    const ctr = parseFloat(ins?.ctr || 0);
    const freq = parseFloat(ins?.frequency || 0);
    const purchases = parseInt(ins?.actions?.find((x) => x.action_type === "purchase")?.value || 0);
    const cpp = purchases > 0 ? spend / purchases : null;
    if (spend >= 4 && purchases === 0) alerts.push(`🔴 НЕТ КОНВЕРСИЙ: ${a.name} ($${spend.toFixed(2)})`);
    if (cpp && cpp > CPP_ALERT) alerts.push(`🟡 ВЫСОКИЙ CPP: ${a.name} — $${cpp.toFixed(2)} > $${CPP_ALERT}`);
    if (freq > 2.5) alerts.push(`🟠 ЧАСТОТА: ${a.name} — ${freq.toFixed(2)}`);
    if (spend > 2 && ctr < 0.5) alerts.push(`⚪ НИЗКИЙ CTR: ${a.name} — ${ctr.toFixed(2)}%`);
  }

  if (alerts.length === 0) return `✅ *${accKey.toUpperCase()}* — алертов нет`;
  return `⚠️ *${accKey.toUpperCase()}* — ${alerts.length} алертов:\n` + alerts.join("\n");
}

async function buildTodayReport(accKey) {
  const accId = ACCOUNTS[accKey] || ACCOUNTS.primary;
  const data = await mGet(`/act_${accId}/campaigns`, {
    fields: `name,status,insights{${F}}`,
    time_range: todayRange().time_range,
    action_attribution_windows: ATTR,
    limit: 20,
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
  });

  const campaigns = (data.data || []).map((c) => {
    const ins = c.insights?.data?.[0];
    const { purchases, cpp, spend } = parsePurchases(ins);
    return { name: c.name, spend, purchases, cpp };
  }).sort((a, b) => b.spend - a.spend);

  const lines = [`📅 *${accKey.toUpperCase()}* сегодня по кампаниям:`];
  for (const c of campaigns) {
    const cppStr = c.cpp ? `$${c.cpp}` : "нет";
    lines.push(`• ${c.name.substring(0, 30)}: $${c.spend.toFixed(2)} | ${c.purchases} 🛒 | CPP ${cppStr}`);
  }
  if (campaigns.length === 0) lines.push("Нет активных кампаний");
  return lines.join("\n");
}

async function buildTopReport(accKey) {
  const accId = ACCOUNTS[accKey] || ACCOUNTS.primary;
  const data = await mGet(`/act_${accId}/ads`, {
    fields: `name,status,campaign{name},insights{${F}}`,
    time_range: todayRange().time_range,
    action_attribution_windows: ATTR,
    limit: 100,
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
  });

  const ads = (data.data || []).map((a) => {
    const ins = a.insights?.data?.[0];
    const { purchases, cpp, spend } = parsePurchases(ins);
    return { name: a.name, campaign: a.campaign?.name, spend, purchases, cpp: cpp ? parseFloat(cpp) : null };
  }).filter((a) => a.purchases > 0).sort((a, b) => (a.cpp || 99) - (b.cpp || 99)).slice(0, 5);

  if (ads.length === 0) return `🏆 *${accKey.toUpperCase()}* — конверсий сегодня нет`;
  const lines = [`🏆 *${accKey.toUpperCase()}* — топ объявлений:`];
  ads.forEach((a, i) => {
    lines.push(`${i + 1}. ${a.name.substring(0, 28)}\n   $${a.spend.toFixed(2)} | 🛒 ${a.purchases} | CPP $${a.cpp.toFixed(2)}`);
  });
  return lines.join("\n");
}

async function buildPausedReport(accKey) {
  const accId = ACCOUNTS[accKey] || ACCOUNTS.primary;
  const data = await mGet(`/act_${accId}/campaigns`, {
    fields: "name,status,insights{spend}",
    time_range: todayRange().time_range,
    limit: 50,
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["PAUSED"] }]),
  });

  const paused = (data.data || []).map((c) => {
    const spend = parseFloat(c.insights?.data?.[0]?.spend || 0);
    return { name: c.name, spend };
  });

  if (paused.length === 0) return `⏸ *${accKey.toUpperCase()}* — ничего на паузе`;
  const lines = [`⏸ *${accKey.toUpperCase()}* — на паузе (${paused.length}):`];
  paused.forEach((c) => lines.push(`• ${c.name.substring(0, 35)}${c.spend > 0 ? ` ($${c.spend.toFixed(2)} сегодня)` : ""}`));
  return lines.join("\n");
}

// -- Send helpers -----------------------------------------------------------

function send(text, withMenu = false) {
  const opts = { parse_mode: "Markdown" };
  if (withMenu) opts.reply_markup = MENU_KEYBOARD;
  return bot.sendMessage(CHAT_ID, text, opts).catch((e) => console.error("TG send error:", e.message));
}

async function runForAllAccounts(builder, withMenu = false) {
  const keys = uniqueAccounts();
  for (const key of keys) {
    try { await send(await builder(key), withMenu); }
    catch (e) { await send(`❌ Ошибка ${key}: ${e.message}`, false); }
  }
}

// -- Cron schedule (Kyiv summer UTC+3) -------------------------------------

// 9:00 Kyiv = 06:00 UTC — утренний
cron.schedule("0 6 * * *", async () => {
  console.log("[TG] Morning report");
  await send("🌅 *Утренний отчёт*", false);
  await runForAllAccounts(buildDailyReport, true);
});

// 14:00 Kyiv = 11:00 UTC — дневной
cron.schedule("0 11 * * *", async () => {
  console.log("[TG] Midday report");
  await send("☀️ *Дневной срез*", false);
  await runForAllAccounts(buildTodayReport, true);
});

// 21:00 Kyiv = 18:00 UTC — вечерний итог
cron.schedule("0 18 * * *", async () => {
  console.log("[TG] Evening report");
  await send("🌙 *Итог дня*", false);
  await runForAllAccounts(buildDailyReport, true);
});

// Алерты каждые 30 мин 8:00-22:00 UTC
cron.schedule("*/30 8-22 * * *", async () => {
  console.log("[TG] Alert check");
  const keys = uniqueAccounts();
  for (const key of keys) {
    try {
      const report = await buildAlertsReport(key);
      if (report.startsWith("⚠️")) await send(report, true);
    } catch (e) { console.error(`[TG] Alert check error ${key}:`, e.message); }
  }
});

// -- Commands ---------------------------------------------------------------

bot.onText(/\/start/, () => {
  send(
    `👋 *FB Ads Manager v4.0.0*\n\nВыбери команду кнопкой ниже или введи вручную:\n/report — сводка по всем аккаунтам\n/alerts — текущие алерты (CPP > $${CPP_ALERT})\n/status — статус аккаунтов\n/today — сегодня по кампаниям\n/top — топ объявлений по CPP\n/paused — что на паузе\n/menu — показать кнопки`,
    true
  );
});

bot.onText(/\/menu/, () => send("📋 Меню:", true));

bot.onText(/\/report/, async () => {
  await send("⏳ Загружаю...", false);
  await runForAllAccounts(buildDailyReport, true);
});

bot.onText(/\/alerts/, async () => {
  await send("⏳ Проверяю алерты...", false);
  await runForAllAccounts(buildAlertsReport, true);
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
  await send(lines.join("\n"), true);
});

bot.onText(/\/today/, async () => {
  await send("⏳ Загружаю...", false);
  await runForAllAccounts(buildTodayReport, true);
});

bot.onText(/\/top/, async () => {
  await send("⏳ Загружаю...", false);
  await runForAllAccounts(buildTopReport, true);
});

bot.onText(/\/paused/, async () => {
  await send("⏳ Загружаю...", false);
  await runForAllAccounts(buildPausedReport, true);
});

// -- Inline button callbacks ------------------------------------------------

bot.on("callback_query", async (q) => {
  await bot.answerCallbackQuery(q.id);
  const action = q.data;

  const handlers = {
    report: () => runForAllAccounts(buildDailyReport, true),
    alerts: () => runForAllAccounts(buildAlertsReport, true),
    today:  () => runForAllAccounts(buildTodayReport, true),
    top:    () => runForAllAccounts(buildTopReport, true),
    paused: () => runForAllAccounts(buildPausedReport, true),
    status: async () => {
      const lines = ["📡 *Статус аккаунтов:*"];
      for (const [key, id] of Object.entries(ACCOUNTS)) {
        if (!id) continue;
        try {
          const info = await mGet(`/act_${id}`, { fields: "name,account_status" });
          lines.push(`• ${key}: ${info.name} — ${info.account_status === 1 ? "✅ ACTIVE" : "⚠️ " + info.account_status}`);
        } catch (e) { lines.push(`• ${key}: ❌ ${e.message}`); }
      }
      await send(lines.join("\n"), true);
    },
  };

  if (handlers[action]) {
    await send("⏳ Загружаю...", false);
    try { await handlers[action](); }
    catch (e) { await send(`❌ Ошибка: ${e.message}`, true); }
  }
});

// -- Text commands ----------------------------------------------------------

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  const text = (msg.text || "").toLowerCase();

  const scaleMatch = text.match(/масштабируй\s+(\w+)\s+(\d+)\s+([\d.]+)/);
  if (scaleMatch) {
    const [, accKey, entityId, budgetUsd] = scaleMatch;
    try {
      await mPost(`/${entityId}`, { daily_budget: Math.round(parseFloat(budgetUsd) * 100) });
      await send(`✅ Бюджет ${entityId} (${accKey}) → $${budgetUsd}/день`, true);
    } catch (e) { await send(`❌ Ошибка: ${e.message}`, true); }
    return;
  }

  const pauseMatch = text.match(/выключи\s+(?:(\w+)\s+)?(\d+)/);
  if (pauseMatch) {
    const entityId = pauseMatch[2];
    try {
      await mPost(`/${entityId}`, { status: "PAUSED" });
      await send(`⏸ ${entityId} → PAUSED`, true);
    } catch (e) { await send(`❌ Ошибка: ${e.message}`, true); }
    return;
  }

  const enableMatch = text.match(/включи\s+(?:(\w+)\s+)?(\d+)/);
  if (enableMatch) {
    const entityId = enableMatch[2];
    try {
      await mPost(`/${entityId}`, { status: "ACTIVE" });
      await send(`▶️ ${entityId} → ACTIVE`, true);
    } catch (e) { await send(`❌ Ошибка: ${e.message}`, true); }
    return;
  }
});

console.log("[TG] Telegram bot started");
