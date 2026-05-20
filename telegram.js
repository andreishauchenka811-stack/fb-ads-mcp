import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import fetch from "node-fetch";

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const META_TOKEN = process.env.META_TOKEN;
const BASE = "https://graph.facebook.com/v19.0";

// Account map (same as server.js)
const ACCOUNTS = {
  primary: process.env.META_ACCOUNT_ID,
  chizy:   process.env.ACCOUNT_ID_1 || process.env.META_ACCOUNT_ID,
  letniy:  process.env.ACCOUNT_ID_2 || process.env.META_ACCOUNT_ID,
  pp:      process.env.ACCOUNT_ID_3 || process.env.META_ACCOUNT_ID,
};

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

  const lines = [
    `📊 *${accKey.toUpperCase()}* | ${fmtDate(new Date())}`,
    `💰 Расход: *$${td.spend.toFixed(2)}* (вчера $${yd.spend.toFixed(2)})`,
    `🛒 Покупки: *${td.purchases}* (вчера ${yd.purchases})`,
    `📈 CPP: *${td.cpp ? `$${td.cpp}` : "нет"}*`,
    `🔄 ROAS: *${td.roas ? `${td.roas}x` : "нет"}*`,
    `👁 CTR: ${tIns.ctr ? `${parseFloat(tIns.ctr).toFixed(2)}%` : "0%"}`,
  ];
  return lines.join("\n");
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
    if (spend >= 4 && purchases === 0) alerts.push(`🔴 NET_KONVERSIY: ${a.name} ($${spend.toFixed(2)})`);
    if (cpp && cpp > 6) alerts.push(`🟡 VYSOKIY_CPP: ${a.name} — $${cpp.toFixed(2)}`);
    if (freq > 2.5) alerts.push(`🟠 CHASTOTA: ${a.name} — ${freq.toFixed(2)}`);
    if (spend > 2 && ctr < 0.5) alerts.push(`⚪ NIZKIY_CTR: ${a.name} — ${ctr.toFixed(2)}%`);
  }

  if (alerts.length === 0) return `✅ *${accKey.toUpperCase()}* — алертов нет`;
  return `⚠️ *${accKey.toUpperCase()}* — ${alerts.length} алертов:\n` + alerts.join("\n");
}

// -- Send helper ------------------------------------------------------------

function send(text) {
  return bot.sendMessage(CHAT_ID, text, { parse_mode: "Markdown" }).catch((e) => console.error("TG send error:", e.message));
}

// -- Morning report cron — 9:00 Kyiv = 06:00 UTC summer / 07:00 UTC winter
// Using 06:00 UTC (adjust if needed)
cron.schedule("0 6 * * *", async () => {
  console.log("[TG] Morning report");
  const activeAccounts = Object.keys(ACCOUNTS).filter((k) => ACCOUNTS[k]);
  const seen = new Set();
  const unique = activeAccounts.filter((k) => { if (seen.has(ACCOUNTS[k])) return false; seen.add(ACCOUNTS[k]); return true; });
  for (const key of unique) {
    try {
      const report = await buildDailyReport(key);
      await send(report);
    } catch (e) {
      await send(`❌ Ошибка отчёта ${key}: ${e.message}`);
    }
  }
});

// -- Alert check every 30 min (8:00 - 22:00 UTC)
cron.schedule("*/30 8-22 * * *", async () => {
  console.log("[TG] Alert check");
  const activeAccounts = Object.keys(ACCOUNTS).filter((k) => ACCOUNTS[k]);
  const seen = new Set();
  const unique = activeAccounts.filter((k) => { if (seen.has(ACCOUNTS[k])) return false; seen.add(ACCOUNTS[k]); return true; });
  for (const key of unique) {
    try {
      const report = await buildAlertsReport(key);
      if (report.startsWith("⚠️")) await send(report);
    } catch (e) {
      console.error(`[TG] Alert check error ${key}:`, e.message);
    }
  }
});

// -- Commands ---------------------------------------------------------------

bot.onText(/\/start/, (msg) => {
  send(`👋 FB Ads Manager v4.0.0\n\nКоманды:\n/report — сводка за сегодня\n/alerts — текущие алерты\n/status — быстрый статус\n\nТекстовые команды:\n• масштабируй [аккаунт] [id] [бюджет$]\n• выключи [кампания/адсет/объявление] [id]\n• включи [кампания/адсет/объявление] [id]`);
});

bot.onText(/\/report/, async () => {
  const activeAccounts = Object.keys(ACCOUNTS).filter((k) => ACCOUNTS[k]);
  const seen = new Set();
  const unique = activeAccounts.filter((k) => { if (seen.has(ACCOUNTS[k])) return false; seen.add(ACCOUNTS[k]); return true; });
  for (const key of unique) {
    try { await send(await buildDailyReport(key)); }
    catch (e) { await send(`❌ Ошибка ${key}: ${e.message}`); }
  }
});

bot.onText(/\/alerts/, async () => {
  const activeAccounts = Object.keys(ACCOUNTS).filter((k) => ACCOUNTS[k]);
  const seen = new Set();
  const unique = activeAccounts.filter((k) => { if (seen.has(ACCOUNTS[k])) return false; seen.add(ACCOUNTS[k]); return true; });
  for (const key of unique) {
    try { await send(await buildAlertsReport(key)); }
    catch (e) { await send(`❌ Ошибка ${key}: ${e.message}`); }
  }
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
  await send(lines.join("\n"));
});

// Text command: "масштабируй chizy 120000000000 15"
bot.on("message", async (msg) => {
  const text = (msg.text || "").toLowerCase();

  // Scale: масштабируй [account] [entity_id] [budget_usd]
  const scaleMatch = text.match(/масштабируй\s+(\w+)\s+(\d+)\s+([\d.]+)/);
  if (scaleMatch) {
    const [, accKey, entityId, budgetUsd] = scaleMatch;
    try {
      await mPost(`/${entityId}`, { daily_budget: Math.round(parseFloat(budgetUsd) * 100) });
      await send(`✅ Бюджет ${entityId} (${accKey}) → $${budgetUsd}/день`);
    } catch (e) { await send(`❌ Ошибка: ${e.message}`); }
    return;
  }

  // Pause: выключи [type] [id]  OR  выключи [id]
  const pauseMatch = text.match(/выключи\s+(?:(\w+)\s+)?(\d+)/);
  if (pauseMatch) {
    const entityId = pauseMatch[2];
    try {
      await mPost(`/${entityId}`, { status: "PAUSED" });
      await send(`⏸ ${entityId} → PAUSED`);
    } catch (e) { await send(`❌ Ошибка: ${e.message}`); }
    return;
  }

  // Enable: включи [type] [id]  OR  включи [id]
  const enableMatch = text.match(/включи\s+(?:(\w+)\s+)?(\d+)/);
  if (enableMatch) {
    const entityId = enableMatch[2];
    try {
      await mPost(`/${entityId}`, { status: "ACTIVE" });
      await send(`▶️ ${entityId} → ACTIVE`);
    } catch (e) { await send(`❌ Ошибка: ${e.message}`); }
    return;
  }
});

console.log("[TG] Telegram bot started");
