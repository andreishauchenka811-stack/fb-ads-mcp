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

const activeTransports = new Map();

// ── Meta API ─────────────────────────────────────────────────────────────
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

// ===================== TOOLS REGISTRATION =====================
function registerTools(server) {
  // Здесь можно оставить все инструменты как раньше. Для примера оставляю основные.

  server.tool("get_campaigns", "Получить все кампании с метриками", {
    days: z.number().optional().default(7).describe("Период в днях")
  }, async ({ days }) => {
    // ... (вставь сюда полный код инструмента из предыдущих версий)
    const { since, until } = dateRange(days);
    const d = await metaGet(`/act_${META_ACCOUNT_ID}/campaigns`, { /* fields */ });
    // ... верни результат
    return { content: [{ type: "text", text: "Campaigns data here (implement full logic)" }] };
  });

  // Добавь остальные инструменты (get_adsets, toggle, check_limits и т.д.)
}

// ===================== MAIN =====================
function createServer() {
  const server = new McpServer({ name: "fb-ads-mcp", version: "1.2.0" });
  registerTools(server);
  return server;
}

const app = express();
app.use(express.json({ limit: "50mb" }));

app.post("/mcp", async (req, res) => {
  let transport = null;
  let mcpServer = null;

  try {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableDnsRebindingProtection: false,
      maxRequestBodySize: 50 * 1024 * 1024,
    });

    mcpServer = createServer();

    transport.onsessioninitialized = (sessionId) => {
      activeTransports.set(sessionId, transport);
      console.log(`🟢 Session started: ${sessionId}`);
    };

    res.on("close", () => {
      if (transport?.sessionId) activeTransports.delete(transport.sessionId);
      mcpServer?.close().catch(() => {});
    });

    await mcpServer.connect(transport);
    await transport.handlePostMessage(req, res);

  } catch (error) {
    console.error("MCP Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    transport: "streamable-http",
    account: META_ACCOUNT_ID ? "connected" : "no token",
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 FB Ads MCP Streamable HTTP ready on port ${PORT}`);
  console.log(`🔗 Use this URL in Claude: https://fb-ads-mcp-3kj3-production-18b6.up.railway.app/mcp`);
});
