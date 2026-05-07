import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import fetch from "node-fetch";
import { z } from "zod";
import { randomUUID } from "crypto";

const META_TOKEN = process.env.META_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const PORT = process.env.PORT || 3000;
const BASE = "https://graph.facebook.com/v19.0";

// ── Meta API helpers ─────────────────────────────────────────────────────────
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
    since: start.toISOString().split("T")[0],
    until: end.toISOString().split("T")[0],
  };
}

// ===================== REGISTER TOOLS =====================
function registerTools(server) {
  // === get_campaigns ===
  server.tool(
    "get_campaigns",
    "Получить все кампании с метриками за период",
    { days: z.number().optional().default(7).describe("Период в днях") },
    async ({ days }) => {
      const { since, until } = dateRange(days);
      const d = await metaGet(`/act_${META_ACCOUNT_ID}/campaigns`, {
        fields: `id,name,status,objective,daily_budget,lifetime_budget,insights.time_range({"since":"${since}","until":"${until}"}){spend,impressions,clicks,ctr,cpc,reach,actions,cost_per_action_type}`,
        limit: 50,
      });

      const campaigns = (d.data || []).map((c) => {
        const ins = c.insights?.data?.[0];
        const purchases = ins?.actions?.find(a => a.action_type === "purchase")?.value || 0;
        const cpp = purchases > 0 ? (parseFloat(ins?.spend || 0) / purchases).toFixed(2) : null;
        return {
          id: c.id, name: c.name, status: c.status, objective: c.objective,
          daily_budget: c.daily_budget ? `$${(c.daily_budget / 100).toFixed(2)}` : null,
          spend: ins?.spend ? `$${parseFloat(ins.spend).toFixed(2)}` : "$0",
          impressions: ins?.impressions || 0,
          clicks: ins?.clicks || 0,
          ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
          cpc: ins?.cpc ? `$${parseFloat(ins.cpc).toFixed(2)}` : null,
          purchases, cpp: cpp ? `$${cpp}` : "нет конверсий"
        };
      });

      const totalSpend = campaigns.reduce((s, c) => s + parseFloat((c.spend || "$0").replace("$", "")), 0);
      const totalPurchases = campaigns.reduce((s, c) => s + parseInt(c.purchases), 0);
      const active = campaigns.filter(c => c.status === "ACTIVE").length;

      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify({ period: `${days} дней`, summary: { total_campaigns: campaigns.length, active, paused: campaigns.length - active, total_spend: `$${totalSpend.toFixed(2)}`, total_purchases: totalPurchases, avg_cpp: totalPurchases > 0 ? `$${(totalSpend / totalPurchases).toFixed(2)}` : "нет" }, campaigns }, null, 2) 
        }]
      };
    }
  );

  // Добавь сюда остальные инструменты (get_adsets, get_ads, toggle_*, update_budget и т.д.) по аналогии
  // Если нужно — скажи, я добавлю все сразу.
}

// ===================== MAIN =====================
const app = express();
app.use(express.json({ limit: "10mb" }));

app.post("/mcp", async (req, res) => {
  let transport = null;
  let mcpServer = null;

  try {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableDnsRebindingProtection: false,
    });

    mcpServer = new McpServer({ name: "fb-ads-mcp", version: "1.2.0" });
    registerTools(mcpServer);

    res.on("close", () => {
      mcpServer?.close().catch(() => {});
    });

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
  res.json({ 
    status: "ok", 
    transport: "streamable-http",
    account: META_ACCOUNT_ID ? "connected" : "no token" 
  });
});

app.listen(PORT, () => {
  console.log(`🚀 FB Ads MCP (Streamable HTTP) running on ${PORT}`);
  console.log(`🔗 MCP URL → https://fb-ads-mcp-3kj3-production-18b6.up.railway.app/mcp`);
});
