import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import fetch from "node-fetch";
import { z } from "zod";

const META_TOKEN = process.env.META_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const PORT = process.env.PORT || 10000;
const BASE = "https://graph.facebook.com/v19.0";

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

function dateRange(days) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - days);
  return { since: start.toISOString().split("T")[0], until: end.toISOString().split("T")[0] };
}

const app = express();
const transports = new Map();

// Главная страница + health
app.get("/", (req, res) => res.send("FB Ads MCP Server is running ✅"));
app.get("/health", (req, res) => res.json({ status: "ok", platform: "render" }));

app.get("/sse", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  // ==================== MCP SERVER С ИНСТРУМЕНТАМИ ====================
  const mcpServer = new McpServer({ 
    name: "fb-ads-mcp", 
    version: "1.4.0" 
  });

  // ====================== АНАЛИТИКА ======================
  mcpServer.tool(
    "get_account_overview",
    "Общая сводка по рекламному кабинету",
    { days: z.number().min(1).max(90).default(14) },
    async ({ days }) => {
      const range = dateRange(days);
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/insights`, {
        fields: "spend,impressions,reach,clicks,cpc,ctr,conversions,cost_per_conversion",
        ...range
      });
      return { content: [{ type: "text", text: "📈 Обзор кабинета:\n" + JSON.stringify(data, null, 2) }] };
    }
  );

  mcpServer.tool(
    "get_campaigns",
    "Список кампаний с метриками",
    {
      days: z.number().min(1).max(90).default(14),
      status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL"),
      limit: z.number().min(10).max(200).default(50)
    },
    async ({ days, status, limit }) => {
      const range = dateRange(days);
      let fields = "name,status,daily_budget,lifetime_budget,objective,insights{impressions,reach,spend,clicks,cpc,ctr,conversions,cost_per_conversion}";
      const params = { fields, limit, ...range };
      if (status !== "ALL") {
        params.filtering = JSON.stringify([{ field: "status", operator: "EQUAL", value: status }]);
      }
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/campaigns`, params);
      return { content: [{ type: "text", text: `📊 Найдено кампаний: ${data.data?.length || 0}\n\n` + JSON.stringify(data, null, 2) }] };
    }
  );

  mcpServer.tool(
    "get_adsets",
    "Получить адсеты",
    {
      campaign_id: z.string().optional(),
      days: z.number().default(14),
      status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL")
    },
    async ({ campaign_id, days, status }) => {
      const range = dateRange(days);
      const params = { 
        fields: "name,status,daily_budget,campaign{name},insights{impressions,spend,clicks,ctr,cpc,conversions}", 
        ...range, 
        limit: 100 
      };
      if (status !== "ALL") params.filtering = JSON.stringify([{field: "status", operator: "EQUAL", value: status}]);
      
      const url = campaign_id ? `/${campaign_id}/adsets` : `/act_${META_ACCOUNT_ID}/adsets`;
      const data = await metaGet(url, params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  mcpServer.tool(
    "analyze_creatives",
    "Анализ креативов — поиск слабых и сильных",
    { days: z.number().default(7), min_spend: z.number().default(300) },
    async ({ days, min_spend }) => {
      const range = dateRange(days);
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/ads`, {
        fields: "name,creative{body,title},insights{impressions,spend,clicks,ctr,cpc,conversions}",
        ...range,
        filtering: JSON.stringify([{field: "spend", operator: "GREATER_THAN", value: min_spend}])
      });
      return { content: [{ type: "text", text: `🔍 Анализ креативов (мин. спенд ${min_spend/100}$):\n\n` + JSON.stringify(data, null, 2) }] };
    }
  );

  // ====================== ДЕЙСТВИЯ ======================
  mcpServer.tool(
    "toggle_status",
    "Включить / выключить кампанию, адсет или рекламу",
    {
      entity_type: z.enum(["campaign", "adset", "ad"]),
      entity_id: z.string(),
      status: z.enum(["ACTIVE", "PAUSED"])
    },
    async ({ entity_type, entity_id, status }) => {
      await metaPost(`/${entity_id}`, { status });
      return { content: [{ type: "text", text: `✅ ${entity_type.toUpperCase()} ${entity_id} → ${status}` }] };
    }
  );

  mcpServer.tool(
    "scale_budget",
    "Изменить бюджет (daily или lifetime)",
    {
      entity_type: z.enum(["campaign", "adset"]),
      entity_id: z.string(),
      budget: z.number().min(100).describe("Бюджет в копейках (например 5000 = 50$)"),
      is_lifetime: z.boolean().default(false)
    },
    async ({ entity_type, entity_id, budget, is_lifetime }) => {
      const body = is_lifetime ? { lifetime_budget: budget } : { daily_budget: budget };
      await metaPost(`/${entity_id}`, body);
      return { content: [{ type: "text", text: `✅ Бюджет обновлён для ${entity_type} ${entity_id}` }] };
    }
  );

  mcpServer.tool(
    "hello",
    "Проверка связи с сервером",
    {},
    async () => ({ content: [{ type: "text", text: "✅ FB Ads MCP v1.4.0 подключён и готов к работе!" }] })
  );

  // ====================== ЗАВЕРШЕНИЕ ======================
  res.on("close", () => {
    transports.delete(transport.sessionId);
    mcpServer.close().catch(() => {});
  });

  try {
    await mcpServer.connect(transport);
    console.log(`✅ Claude connected via SSE`);
  } catch (e) {
    console.error(e);
  }
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) return res.status(404).json({ error: "Session not found" });
  try {
    await transport.handlePostMessage(req, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 FB Ads MCP running on Render → port ${PORT}`);
  console.log(`SSE URL: https://fb-ads-mcp-xxx.onrender.com/sse`);
});
