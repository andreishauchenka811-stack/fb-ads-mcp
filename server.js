import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import fetch from "node-fetch";
import { z } from "zod";

const META_TOKEN = process.env.META_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const PORT = process.env.PORT || 10000;
const BASE = "https://graph.facebook.com/v19.0";

// ── Meta API helpers ───────────────────────────────────────────────────────────
async function metaGet(path, params = {}) {
  const qs = new URLSearchParams({ access_token: META_TOKEN, ...params });
  const r = await fetch(`${BASE}${path}?${qs}`);
  const d = await r.json();
  if (d.error) throw new Error(`Meta API: ${d.error.message}`);
  return d;
}

async function metaPost(path, body = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: META_TOKEN, ...body }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Meta API: ${d.error.message}`);
  return d;
}

function fmtDate(d) {
  return d.toISOString().split("T")[0];
}

// days=1 = только сегодня, days=7 = последние 7 дней включая сегодня
function dateRange(days) {
  const until = new Date();
  const since = new Date(until);
  since.setDate(until.getDate() - (days - 1));
  return { time_range: JSON.stringify({ since: fmtDate(since), until: fmtDate(until) }) };
}

// Явно сегодня
function todayRange() {
  const t = fmtDate(new Date());
  return { time_range: JSON.stringify({ since: t, until: t }) };
}

// Явно вчера
function yesterdayRange() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = fmtDate(d);
  return { time_range: JSON.stringify({ since: y, until: y }) };
}

const INSIGHTS_FIELDS = [
  "spend", "impressions", "reach", "clicks",
  "ctr", "cpc", "cpm", "frequency",
  "actions", "cost_per_action_type", "action_values",
].join(",");

function parsePurchases(ins) {
  if (!ins) return { purchases: 0, cpp: null, revenue: "0", roas: null };
  const spend = parseFloat(ins.spend || 0);
  const purchases = parseInt(ins.actions?.find((a) => a.action_type === "purchase")?.value || 0);
  const revenue = parseFloat(ins.action_values?.find((a) => a.action_type === "purchase")?.value || 0);
  const cpp = purchases > 0 ? (spend / purchases).toFixed(2) : null;
  const roas = spend > 0 && revenue > 0 ? (revenue / spend).toFixed(2) : null;
  return { purchases, cpp, revenue: revenue.toFixed(2), roas };
}

// ── Регистрация всех тулов ─────────────────────────────────────────────────────
function registerTools(s) {

  s.tool("hello", "Проверка связи с сервером", {}, async () => ({
    content: [{ type: "text", text: "✅ FB Ads MCP v2.1.0 подключён!" }],
  }));

  s.tool(
    "get_account_overview",
    "Общая сводка по рекламному кабинету. date_preset: today, yesterday, last_7d, last_14d, last_30d",
    {
      days: z.number().min(1).max(90).default(14),
      date_preset: z.enum(["today", "yesterday", "last_7d", "last_14d", "last_30d", "custom"]).default("custom"),
    },
    async ({ days, date_preset }) => {
      const range = date_preset === "today" ? todayRange()
        : date_preset === "yesterday" ? yesterdayRange()
        : date_preset === "last_7d" ? dateRange(7)
        : date_preset === "last_14d" ? dateRange(14)
        : date_preset === "last_30d" ? dateRange(30)
        : dateRange(days);

      const label = date_preset !== "custom" ? date_preset : `${days} дней`;

      // Тянем сегодня и вчера параллельно для сравнения
      const [dataMain, dataToday, dataYest] = await Promise.all([
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...range }),
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...todayRange() }),
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...yesterdayRange() }),
      ]);

      const ins = dataMain.data?.[0] || {};
      const insToday = dataToday.data?.[0] || {};
      const insYest = dataYest.data?.[0] || {};
      const { purchases, cpp, revenue, roas } = parsePurchases(ins);
      const todayParsed = parsePurchases(insToday);
      const yesterdayParsed = parsePurchases(insYest);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            период: label,
            итого: {
              спенд: `$${parseFloat(ins.spend || 0).toFixed(2)}`,
              показы: ins.impressions || 0,
              клики: ins.clicks || 0,
              ctr: ins.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
              cpc: ins.cpc ? `$${parseFloat(ins.cpc).toFixed(2)}` : null,
              cpm: ins.cpm ? `$${parseFloat(ins.cpm).toFixed(2)}` : null,
              покупки: purchases,
              cpp: cpp ? `$${cpp}` : "нет конверсий",
              выручка: `$${revenue}`,
              roas: roas ? `${roas}x` : null,
            },
            сегодня: {
              спенд: `$${parseFloat(insToday.spend || 0).toFixed(2)}`,
              покупки: todayParsed.purchases,
              cpp: todayParsed.cpp ? `$${todayParsed.cpp}` : "нет конверсий",
              roas: todayParsed.roas ? `${todayParsed.roas}x` : null,
            },
            вчера: {
              спенд: `$${parseFloat(insYest.spend || 0).toFixed(2)}`,
              покупки: yesterdayParsed.purchases,
              cpp: yesterdayParsed.cpp ? `$${yesterdayParsed.cpp}` : "нет конверсий",
              roas: yesterdayParsed.roas ? `${yesterdayParsed.roas}x` : null,
            },
          }, null, 2),
        }],
      };
    }
  );

  s.tool(
    "get_campaigns",
    "Список кампаний с метриками",
    {
      days: z.number().min(1).max(90).default(14),
      status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL"),
      limit: z.number().min(10).max(200).default(50),
    },
    async ({ days, status, limit }) => {
      const params = {
        fields: `name,status,daily_budget,lifetime_budget,objective,insights{${INSIGHTS_FIELDS}}`,
        limit,
        ...dateRange(days),
      };
      if (status !== "ALL") {
        params.filtering = JSON.stringify([
          { field: "effective_status", operator: "IN", value: [status] },
        ]);
      }
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/campaigns`, params);
      const campaigns = (data.data || []).map((c) => {
        const ins = c.insights?.data?.[0];
        const { purchases, cpp, roas } = parsePurchases(ins);
        return {
          id: c.id,
          name: c.name,
          status: c.status,
          daily_budget: c.daily_budget ? `$${(c.daily_budget / 100).toFixed(2)}` : null,
          спенд: ins ? `$${parseFloat(ins.spend).toFixed(2)}` : "$0",
          покупки: purchases,
          cpp: cpp ? `$${cpp}` : "нет конверсий",
          roas: roas ? `${roas}x` : null,
          ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
          frequency: ins?.frequency ? parseFloat(ins.frequency).toFixed(2) : null,
        };
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ всего: campaigns.length, campaigns }, null, 2) }],
      };
    }
  );

  s.tool(
    "get_adsets",
    "Получить адсеты кампании или всего кабинета",
    {
      campaign_id: z.string().optional(),
      days: z.number().default(14),
      status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL"),
    },
    async ({ campaign_id, days, status }) => {
      const params = {
        fields: `name,status,daily_budget,campaign{name},insights{${INSIGHTS_FIELDS}}`,
        limit: 100,
        ...dateRange(days),
      };
      if (status !== "ALL") {
        params.filtering = JSON.stringify([
          { field: "effective_status", operator: "IN", value: [status] },
        ]);
      }
      const url = campaign_id ? `/${campaign_id}/adsets` : `/act_${META_ACCOUNT_ID}/adsets`;
      const data = await metaGet(url, params);
      const adsets = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        const flag = spend >= 4 && purchases === 0 ? "🔴 ВЫКЛЮЧИТЬ ($4+ без покупок)"
          : spend >= 2 && purchases === 0 ? "🟡 НАБЛЮДАТЬ"
          : "🟢 OK";
        return {
          id: a.id,
          name: a.name,
          status: a.status,
          campaign: a.campaign?.name,
          daily_budget: a.daily_budget ? `$${(a.daily_budget / 100).toFixed(2)}` : null,
          спенд: `$${spend.toFixed(2)}`,
          покупки: purchases,
          cpp: cpp ? `$${cpp}` : "нет конверсий",
          ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
          frequency: ins?.frequency ? parseFloat(ins.frequency).toFixed(2) : null,
          флаг: flag,
        };
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ всего: adsets.length, adsets }, null, 2) }],
      };
    }
  );

  s.tool(
    "get_ads",
    "Получить объявления с метриками для анализа креативов",
    {
      campaign_id: z.string().optional(),
      adset_id: z.string().optional(),
      days: z.number().default(7),
      status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL"),
    },
    async ({ campaign_id, adset_id, days, status }) => {
      const params = {
        fields: `name,status,creative{title,body,image_url,thumbnail_url},insights{${INSIGHTS_FIELDS}}`,
        limit: 100,
        ...dateRange(days),
      };
      if (status !== "ALL") {
        params.filtering = JSON.stringify([
          { field: "effective_status", operator: "IN", value: [status] },
        ]);
      }
      const url = adset_id ? `/${adset_id}/ads`
        : campaign_id ? `/${campaign_id}/ads`
        : `/act_${META_ACCOUNT_ID}/ads`;
      const data = await metaGet(url, params);
      const ads = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        const ctr = parseFloat(ins?.ctr || 0);
        const freq = parseFloat(ins?.frequency || 0);
        const flag = spend >= 4 && purchases === 0 ? "🔴 ВЫКЛЮЧИТЬ"
          : freq > 3 ? "⚠️ УСТАЛОСТЬ (freq > 3)"
          : ctr < 0.5 && spend > 3 ? "⚠️ НИЗКИЙ CTR"
          : purchases > 0 && cpp && parseFloat(cpp) < 5 ? "🟢 ПОБЕДИТЕЛЬ"
          : "🟡 НАБЛЮДАТЬ";
        return {
          id: a.id,
          name: a.name,
          status: a.status,
          creative_title: a.creative?.title,
          creative_body: a.creative?.body?.substring(0, 100),
          спенд: `$${spend.toFixed(2)}`,
          покупки: purchases,
          cpp: cpp ? `$${cpp}` : "нет",
          ctr: `${ctr.toFixed(2)}%`,
          frequency: freq.toFixed(2),
          флаг: flag,
        };
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ всего: ads.length, ads }, null, 2) }],
      };
    }
  );

  s.tool(
    "analyze_creatives",
    "Анализ креативов — поиск слабых и сильных",
    {
      days: z.number().default(7),
      min_spend_usd: z.number().default(3).describe("Мин. спенд в USD"),
    },
    async ({ days, min_spend_usd }) => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/ads`, {
        fields: `name,status,creative{title,body},insights{${INSIGHTS_FIELDS}}`,
        ...dateRange(days),
        limit: 100,
      });
      const ads = (data.data || [])
        .map((a) => {
          const ins = a.insights?.data?.[0];
          const spend = parseFloat(ins?.spend || 0);
          const { purchases, cpp, roas } = parsePurchases(ins);
          return {
            id: a.id, name: a.name, spend, purchases, cpp, roas,
            ctr: parseFloat(ins?.ctr || 0),
            frequency: parseFloat(ins?.frequency || 0),
            creative: a.creative?.body?.substring(0, 80),
          };
        })
        .filter((a) => a.spend >= min_spend_usd)
        .sort((a, b) => b.purchases - a.purchases || a.spend - b.spend);

      const winners = ads.filter((a) => a.purchases > 0 && a.cpp && parseFloat(a.cpp) <= 5);
      const losers = ads.filter((a) => a.spend >= 4 && a.purchases === 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            период_дней: days,
            победители: winners.map((a) => ({ ...a, cpp: a.cpp ? `$${a.cpp}` : null, рекомендация: "масштабировать" })),
            аутсайдеры: losers.map((a) => ({ ...a, рекомендация: "выключить" })),
            все_крео: ads,
          }, null, 2),
        }],
      };
    }
  );

  s.tool(
    "toggle_status",
    "Включить / выключить кампанию, адсет или объявление",
    {
      entity_type: z.enum(["campaign", "adset", "ad"]),
      entity_id: z.string(),
      status: z.enum(["ACTIVE", "PAUSED"]),
    },
    async ({ entity_type, entity_id, status }) => {
      await metaPost(`/${entity_id}`, { status });
      return { content: [{ type: "text", text: `✅ ${entity_type} ${entity_id} → ${status}` }] };
    }
  );

  s.tool(
    "scale_budget",
    "Изменить дневной или lifetime бюджет",
    {
      entity_type: z.enum(["campaign", "adset"]),
      entity_id: z.string(),
      budget: z.number().min(100).describe("Бюджет в копейках (500 = $5, 1500 = $15)"),
      is_lifetime: z.boolean().default(false),
    },
    async ({ entity_type, entity_id, budget, is_lifetime }) => {
      const body = is_lifetime ? { lifetime_budget: budget } : { daily_budget: budget };
      await metaPost(`/${entity_id}`, body);
      const usd = (budget / 100).toFixed(2);
      return {
        content: [{ type: "text", text: `✅ Бюджет ${entity_type} ${entity_id}: $${usd} (${is_lifetime ? "lifetime" : "daily"})` }],
      };
    }
  );

  s.tool(
    "duplicate_adset",
    "Дублировать адсет для масштабирования или смены гео",
    {
      adset_id: z.string(),
      new_budget_usd: z.number().optional().describe("Новый дневной бюджет в USD"),
      status_after: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async ({ adset_id, new_budget_usd, status_after }) => {
      const body = { deep_copy: true, status_option: status_after };
      if (new_budget_usd) body.daily_budget = Math.round(new_budget_usd * 100);
      const d = await metaPost(`/${adset_id}/copies`, body);
      return {
        content: [{ type: "text", text: `✅ Дублировано. Новый ID: ${d.copied_adset_id || JSON.stringify(d)}. Статус: ${status_after}` }],
      };
    }
  );
}

// ── Express ────────────────────────────────────────────────────────────────────
// ВАЖНО: НЕТ app.use(express.json()) — он поглощает стрим запроса,
// из-за чего transport.handlePostMessage() получает пустое тело и молча падает
const app = express();
const transports = new Map();

app.get("/", (req, res) => res.send("FB Ads MCP Server ✅ v2.1.0"));
app.get("/health", (req, res) =>
  res.json({ status: "ok", account: META_ACCOUNT_ID ? "connected" : "no token" })
);

app.get("/sse", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  const mcpServer = new McpServer({ name: "fb-ads-mcp", version: "2.1.0" });
  registerTools(mcpServer);

  res.on("close", () => {
    transports.delete(transport.sessionId);
    mcpServer.close().catch(() => {});
  });

  // connect() первым — транспорт берёт управление над res
  await mcpServer.connect(transport);
  console.log(`✅ Connected [${transport.sessionId}]`);

  // Keepalive только ПОСЛЕ connect — SSE-комментарии не влияют на MCP протокол
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 25000);
  res.on("close", () => clearInterval(keepalive));
});

// handlePostMessage сам читает raw body — express.json() здесь не нужен
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) return res.status(404).json({ error: "Session not found" });
  try {
    await transport.handlePostMessage(req, res);
  } catch (e) {
    console.error("Message error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 FB Ads MCP v2.1.0 on port ${PORT}`);
  console.log(`   Account: act_${META_ACCOUNT_ID}`);
});
