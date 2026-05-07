import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import fetch from "node-fetch";
import { z } from "zod";
import { randomUUID } from "crypto";

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

function registerTools(server) {
  // Можно добавить все инструменты позже. Пока базовый для теста
  server.tool("get_campaigns", "Получить кампании FB Ads", {
    days: z.number().optional().default(7)
  }, async ({ days }) => {
    const { since, until } = dateRange(days);
    const d = await metaGet(`/act_${META_ACCOUNT_ID}/campaigns`, {
      fields: `id,name,status,objective,daily_budget,insights.time_range({"since":"${since}","until":"${until}"}){spend,impressions,clicks,ctr,actions}`,
      limit: 50
    });
    return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
  });
}

const app = express();
app.use(express.json({ limit: "10mb" }));

app.post("/mcp", async (req, res) => {
  let transport, mcpServer;

  try {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableDnsRebindingProtection: false,
    });

    mcpServer = new McpServer({ name: "fb-ads-mcp", version: "1.2.0" });
    registerTools(mcpServer);

    await mcpServer.connect(transport);
    await transport.handlePostMessage(req, res);

  } catch (error) {
    console.error("MCP Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", platform: "render", time: new Date().toISOString() });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 FB Ads MCP running on port ${PORT}`);
});
