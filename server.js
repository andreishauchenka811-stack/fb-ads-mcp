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

  const mcpServer = new McpServer({ name: "fb-ads-mcp", version: "1.2.0" });

  // ← Здесь регистрируем все инструменты
  // get_campaigns, toggle_campaign и т.д. — добавлю полностью, если скажешь

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
