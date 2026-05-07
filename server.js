import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

const PORT = process.env.PORT || 3000;

const app = express();

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "MCP Server is alive" });
});

// Простой MCP сервер
const server = new McpServer({
  name: "fb-ads-mcp",
  version: "1.0.0"
});

server.tool(
  "test_connection",
  "Просто проверить, работает ли связь с Claude",
  {},
  async () => {
    return {
      content: [{ 
        type: "text", 
        text: "✅ Соединение с MCP сервером успешно! FB Ads инструменты готовы." 
      }]
    };
  }
);

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    await server.connect(transport);
    console.log("Claude connected successfully");
  } catch (err) {
    console.error(err);
  }
});

app.post("/messages", async (req, res) => {
  // Для минимальной версии просто отвечаем
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Minimal MCP Server running on port ${PORT}`);
  console.log(`🔗 SSE URL: http://localhost:${PORT}/sse`);
  console.log(`🔗 Railway URL: https://fb-ads-mcp-3kj3-production-18b6.up.railway.app/sse`);
});
