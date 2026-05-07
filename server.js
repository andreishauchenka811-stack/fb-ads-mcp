import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import fetch from "node-fetch";
import { z } from "zod";

const META_TOKEN = process.env.META_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const PORT = process.env.PORT || 10000;
const BASE = "https://graph.facebook.com/v19.0";

// ── Meta API helpers ──────────────────────────────────────────────────────────
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

// FIX: dateRange возвращает time_range как JSON-строку (правильный формат для Insights API)
function dateRange(days) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - days);
  return {
    time_range: JSON.stringify({
      since: start.toISOString().split("T")[0],
      until: end.toISOString().split("T")[0],
    }),
  };
}

// Поля для инсайтов с покупками (ключевые для SKILLNEST)
const INSIGHTS_FIELDS = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "frequency",
  "actions",               // содержит purchase count
  "cost_per_action_type",  // содержит CPP
  "action_values",         // выручка (для ROAS)
].join(",");

// Хелпер: вытащить покупки и CPP из инсайтов (только сырые данные FB)
function parsePurchases(ins) {
  if (!ins) return { purchases: 0, cpp: null, revenue: 0, roas: null };
  const spend = parseFloat(ins.spend || 0);
  const purchases = parseInt(
    ins.actions?.find((a) => a.action_type === "purchase")?.value || 0
  );
  const revenue = parseFloat(
    ins.action_values?.find((a) => a.action_type === "purchase")?.value || 0
  );
  const cpp = purchases > 0 ? (spend / purchases).toFixed(2) : null;
  const roas = spend > 0 ? (revenue / spend).toFixed(2) : null;
  return { purchases, cpp, revenue: revenue.toFixed(2), roas };
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json()); // FIX: без этого /messages не парсит body — критический баг

const transports = new Map();

app.get("/", (req, res) => res.send("FB Ads MCP Server ✅"));
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

  const mcpServer = new McpServer({ name: "fb-ads-mcp", version: "2.0.0" });

  // ── TOOL: hello ─────────────────────────────────────────────────────────────
  mcpServer.tool("hello", "Проверка связи", {}, async () => ({
    content: [{ type: "text", text: "✅ FB Ads MCP v2.0.0 подключён!" }],
  }));

  // ── TOOL: get_account_overview ───────────────────────────────────────────────
  mcpServer.tool(
    "get_account_overview",
    "Общая сводка по рекламному кабинету",
    { days: z.number().min(1).max(90).default(14) },
    async ({ days }) => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/insights`, {
        fields: INSIGHTS_FIELDS,
        level: "account",
        ...dateRange(days), // FIX: правильный time_range
      });
      const ins = data.data?.[0] || {};
      const { purchases, cpp, revenue, roas } = parsePurchases(ins);
      const summary = {
        период_дней: days,
        спенд: `$${parseFloat(ins.spend || 0).toFixed(2)}`,
        показы: ins.impressions || 0,
        охват: ins.reach || 0,
        клики: ins.clicks || 0,
        ctr: ins.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
        cpc: ins.cpc ? `$${parseFloat(ins.cpc).toFixed(2)}` : null,
        cpm: ins.cpm ? `$${parseFloat(ins.cpm).toFixed(2)}` : null,
        покупки: purchases,
        cpp: cpp ? `$${cpp}` : "нет конверсий",
        выручка: `$${revenue}`,
        roas: roas ? `${roas}x` : null,
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── TOOL: get_campaigns ──────────────────────────────────────────────────────
  mcpServer.tool(
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
        const { purchases, cpp, revenue, roas } = parsePurchases(ins);
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

  // ── TOOL: get_adsets ────────────────────────────────────────────────────────
  mcpServer.tool(
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
      const url = campaign_id
        ? `/${campaign_id}/adsets`
        : `/act_${META_ACCOUNT_ID}/adsets`;
      const data = await metaGet(url, params);

      const adsets = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        // FIX: правило $4-5 без покупок — помечаем автоматически
        const flag = spend >= 4 && purchases === 0 ? "🔴 ВЫКЛЮЧИТЬ ($4+ без покупок)" :
                     spend >= 2 && purchases === 0 ? "🟡 НАБЛЮДАТЬ" : "🟢 OK";
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

  // ── TOOL: get_ads (креативы) ─────────────────────────────────────────────────
  mcpServer.tool(
    "get_ads",
    "Получить объявления с метриками — для анализа креативов",
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
      const url = adset_id
        ? `/${adset_id}/ads`
        : campaign_id
        ? `/${campaign_id}/ads`
        : `/act_${META_ACCOUNT_ID}/ads`;
      const data = await metaGet(url, params);

      const ads = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        const ctr = parseFloat(ins?.ctr || 0);
        // Флаг усталости крео
        const freq = parseFloat(ins?.frequency || 0);
        const flag = spend >= 4 && purchases === 0 ? "🔴 ВЫКЛЮЧИТЬ" :
                     freq > 3 ? "⚠️ УСТАЛОСТЬ (freq > 3)" :
                     ctr < 0.5 && spend > 3 ? "⚠️ НИЗКИЙ CTR" :
                     purchases > 0 && cpp && parseFloat(cpp) < 5 ? "🟢 ПОБЕДИТЕЛЬ" : "🟡 НАБЛЮДАТЬ";
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

  // ── TOOL: analyze_creatives ──────────────────────────────────────────────────
  mcpServer.tool(
    "analyze_creatives",
    "Анализ креативов — поиск слабых и сильных",
    {
      days: z.number().default(7),
      min_spend_usd: z.number().default(3).describe("Мин. спенд в USD для анализа"), // FIX: было min_spend в копейках — непонятно
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
          return { id: a.id, name: a.name, spend, purchases, cpp, roas,
                   ctr: parseFloat(ins?.ctr || 0), frequency: parseFloat(ins?.frequency || 0),
                   creative: a.creative?.body?.substring(0, 80) };
        })
        .filter((a) => a.spend >= min_spend_usd) // FIX: фильтруем по USD
        .sort((a, b) => {
          // Сортировка: победители наверх (по покупкам)
          if (b.purchases !== a.purchases) return b.purchases - a.purchases;
          return a.spend - b.spend;
        });

      const winners = ads.filter((a) => a.purchases > 0 && a.cpp && parseFloat(a.cpp) <= 5);
      const losers = ads.filter((a) => a.spend >= 4 && a.purchases === 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            период_дней: days,
            победители: winners.map((a) => ({ ...a, cpp: `$${a.cpp}`, рекомендация: "масштабировать" })),
            аутсайдеры: losers.map((a) => ({ ...a, рекомендация: "выключить" })),
            все_крео: ads,
          }, null, 2),
        }],
      };
    }
  );

  // ── TOOL: toggle_status ──────────────────────────────────────────────────────
  mcpServer.tool(
    "toggle_status",
    "Включить / выключить кампанию, адсет или объявление",
    {
      entity_type: z.enum(["campaign", "adset", "ad"]),
      entity_id: z.string(),
      status: z.enum(["ACTIVE", "PAUSED"]),
    },
    async ({ entity_type, entity_id, status }) => {
      await metaPost(`/${entity_id}`, { status });
      return {
        content: [{ type: "text", text: `✅ ${entity_type} ${entity_id} → ${status}` }],
      };
    }
  );

  // ── TOOL: scale_budget ───────────────────────────────────────────────────────
  mcpServer.tool(
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
      const type = is_lifetime ? "lifetime" : "daily";
      return {
        content: [{ type: "text", text: `✅ Бюджет ${entity_type} ${entity_id}: $${usd}/день (${type})` }],
      };
    }
  );

  // ── TOOL: duplicate_adset ─────────────────────────────────────────────────────
  mcpServer.tool(
    "duplicate_adset",
    "Дублировать адсет (для масштабирования или смены гео)",
    {
      adset_id: z.string(),
      new_budget_usd: z.number().optional().describe("Новый дневной бюджет в USD"),
      status_after: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async ({ adset_id, new_budget_usd, status_after }) => {
      const body = {
        deep_copy: true,
        status_option: status_after === "ACTIVE" ? "ACTIVE" : "PAUSED",
      };
      if (new_budget_usd) body.daily_budget = Math.round(new_budget_usd * 100);
      const d = await metaPost(`/${adset_id}/copies`, body);
      return {
        content: [{
          type: "text",
          text: `✅ Адсет продублирован. Новый ID: ${d.copied_adset_id || JSON.stringify(d)}. Статус: ${status_after}`,
        }],
      };
    }
  );

  // ── Connect ──────────────────────────────────────────────────────────────────
  res.on("close", () => {
    transports.delete(transport.sessionId);
    mcpServer.close().catch(() => {});
  });

  try {
    await mcpServer.connect(transport);
    console.log(`✅ Claude connected [session: ${transport.sessionId}]`);
  } catch (e) {
    console.error("SSE connect error:", e);
  }
});

// FIX: express.json() уже подключён глобально выше — body парсится корректно
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
  console.log(`🚀 FB Ads MCP v2.0.0 on port ${PORT}`);
  console.log(`   Account: act_${META_ACCOUNT_ID}`);
});
