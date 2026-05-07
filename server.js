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
  return {
    time_range: JSON.stringify({
      since: start.toISOString().split("T")[0],
      until: end.toISOString().split("T")[0],
    }),
  };
}

const INSIGHTS_FIELDS = "spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions,cost_per_action_type,action_values";

const app = express();
app.use(express.json());
const transports = new Map();

app.get("/", (req, res) => res.send("FB Ads MCP v2.1 ✅"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/sse", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  const mcpServer = new McpServer({ name: "fb-ads-mcp", version: "2.1.0" });

  // === Быстрые и лёгкие инструменты ===
  mcpServer.tool("hello", "Проверка связи", {}, async () => ({
    content: [{ type: "text", text: "✅ FB Ads MCP v2.1.0 готов!" }]
  }));

  mcpServer.tool(
    "get_account_overview",
    "Общая сводка по кабинету",
    { days: z.number().min(1).max(30).default(7) },
    async ({ days }) => { /* оставил твой хороший код */ }
  );

  mcpServer.tool(
    "get_campaigns",
    "Список кампаний",
    { days: z.number().default(7), limit: z.number().default(30) },
    async ({ days, limit }) => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/campaigns`, {
        fields: "name,status,daily_budget,insights{spend,ctr,actions,cost_per_action_type}",
        limit,
        ...dateRange(days)
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  mcpServer.tool(
    "get_adsets",
    "Адсеты с флагами",
    { days: z.number().default(7) },
    async ({ days }) => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/adsets`, {
        fields: "name,status,daily_budget,campaign{name},insights{spend,ctr,purchases?no,actions}",
        limit: 80,
        ...dateRange(days)
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  mcpServer.tool(
    "analyze_creatives",
    "Анализ креативов (быстрая версия)",
    { days: z.number().default(7) },
    async ({ days }) => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/ads`, {
        fields: `name,creative{title,body},insights{${INSIGHTS_FIELDS}}`,
        limit: 80,
        ...dateRange(days)
      });
      // ... (можно оставить твою логику парсинга, но укоротить вывод)
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  mcpServer.tool("toggle_status", /* твой код */ );
  mcpServer.tool("scale_budget", /* твой код */ );
  mcpServer.tool("duplicate_adset", /* твой код */ );

  // Keepalive
  const keepalive = setInterval(() => res.write(": ping\n\n"), 25000);

  res.on("close", () => {
    clearInterval(keepalive);
    transports.delete(transport.sessionId);
    mcpServer.close().catch(() => {});
  });

  try {
    await mcpServer.connect(transport);
    console.log(`✅ Claude connected`);
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
  console.log(`🚀 FB Ads MCP v2.1.0 running on port ${PORT}`);
});
