import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import fetch from "node-fetch";
import { Netmask } from "netmask";
import { z } from "zod";

const META_TOKEN = process.env.META_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const PORT = process.env.PORT || 3000;
const BASE = "https://graph.facebook.com/v19.0";

// ── Meta API helper ───────────────────────────────────────────────────────────
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
  const start = new Date();
  start.setDate(end.getDate() - days);
  return {
    since: start.toISOString().split("T")[0],
    until: end.toISOString().split("T")[0],
  };
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "fb-ads-mcp",
  version: "1.0.0",
});

// ── TOOL: get_campaigns ───────────────────────────────────────────────────────
server.tool(
  "get_campaigns",
  "Получить все кампании с метриками за указанный период",
  {
    days: z.number().optional().default(7).describe("Период в днях (1, 7, 14, 30)"),
  },
  async ({ days }) => {
    const { since, until } = dateRange(days);
    const d = await metaGet(`/act_${META_ACCOUNT_ID}/campaigns`, {
      fields: `id,name,status,objective,daily_budget,lifetime_budget,insights.time_range({"since":"${since}","until":"${until}"}){spend,impressions,clicks,ctr,cpc,reach,actions,cost_per_action_type}`,
      limit: 50,
    });

    const campaigns = (d.data || []).map((c) => {
      const ins = c.insights?.data?.[0];
      const purchases = ins?.actions?.find((a) => a.action_type === "purchase")?.value || 0;
      const cpp = purchases > 0 ? (parseFloat(ins?.spend || 0) / purchases).toFixed(2) : null;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        daily_budget: c.daily_budget ? `$${(c.daily_budget / 100).toFixed(2)}` : null,
        spend: ins?.spend ? `$${parseFloat(ins.spend).toFixed(2)}` : "$0",
        impressions: ins?.impressions || 0,
        clicks: ins?.clicks || 0,
        ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
        cpc: ins?.cpc ? `$${parseFloat(ins.cpc).toFixed(2)}` : null,
        purchases: purchases,
        cpp: cpp ? `$${cpp}` : "нет конверсий",
      };
    });

    const totalSpend = campaigns.reduce((s, c) => s + parseFloat(c.spend.replace("$", "")), 0);
    const totalPurchases = campaigns.reduce((s, c) => s + parseInt(c.purchases), 0);
    const active = campaigns.filter((c) => c.status === "ACTIVE").length;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            period: `${days} дней (${dateRange(days).since} — ${dateRange(days).until})`,
            summary: {
              total_campaigns: campaigns.length,
              active: active,
              paused: campaigns.length - active,
              total_spend: `$${totalSpend.toFixed(2)}`,
              total_purchases: totalPurchases,
              avg_cpp: totalPurchases > 0 ? `$${(totalSpend / totalPurchases).toFixed(2)}` : "нет конверсий",
            },
            campaigns,
          }, null, 2),
        },
      ],
    };
  }
);

// ── TOOL: get_adsets ──────────────────────────────────────────────────────────
server.tool(
  "get_adsets",
  "Получить адсеты конкретной кампании",
  {
    campaign_id: z.string().describe("ID кампании"),
    days: z.number().optional().default(7).describe("Период в днях"),
  },
  async ({ campaign_id, days }) => {
    const { since, until } = dateRange(days);
    const d = await metaGet(`/${campaign_id}/adsets`, {
      fields: `id,name,status,daily_budget,targeting,insights.time_range({"since":"${since}","until":"${until}"}){spend,impressions,clicks,ctr,cpc,actions}`,
    });

    const adsets = (d.data || []).map((a) => {
      const ins = a.insights?.data?.[0];
      const purchases = ins?.actions?.find((x) => x.action_type === "purchase")?.value || 0;
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        daily_budget: a.daily_budget ? `$${(a.daily_budget / 100).toFixed(2)}` : null,
        spend: ins?.spend ? `$${parseFloat(ins.spend).toFixed(2)}` : "$0",
        clicks: ins?.clicks || 0,
        ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
        cpc: ins?.cpc ? `$${parseFloat(ins.cpc).toFixed(2)}` : null,
        purchases,
      };
    });

    return {
      content: [{ type: "text", text: JSON.stringify({ campaign_id, adsets }, null, 2) }],
    };
  }
);

// ── TOOL: get_ads ─────────────────────────────────────────────────────────────
server.tool(
  "get_ads",
  "Получить объявления (крео) адсета или кампании",
  {
    adset_id: z.string().optional().describe("ID адсета"),
    campaign_id: z.string().optional().describe("ID кампании"),
    days: z.number().optional().default(7),
  },
  async ({ adset_id, campaign_id, days }) => {
    const parentId = adset_id || campaign_id;
    const endpoint = adset_id ? `/${adset_id}/ads` : `/${campaign_id}/ads`;
    const { since, until } = dateRange(days);
    const d = await metaGet(endpoint, {
      fields: `id,name,status,creative{title,body,video_id,image_url},insights.time_range({"since":"${since}","until":"${until}"}){spend,clicks,ctr,cpc,actions,impressions}`,
    });

    const ads = (d.data || []).map((a) => {
      const ins = a.insights?.data?.[0];
      const purchases = ins?.actions?.find((x) => x.action_type === "purchase")?.value || 0;
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        creative_title: a.creative?.title || null,
        spend: ins?.spend ? `$${parseFloat(ins.spend).toFixed(2)}` : "$0",
        clicks: ins?.clicks || 0,
        ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
        purchases,
      };
    });

    return {
      content: [{ type: "text", text: JSON.stringify({ ads }, null, 2) }],
    };
  }
);

// ── TOOL: toggle_campaign ─────────────────────────────────────────────────────
server.tool(
  "toggle_campaign",
  "Запустить или поставить на паузу кампанию",
  {
    campaign_id: z.string().describe("ID кампании"),
    status: z.enum(["ACTIVE", "PAUSED"]).describe("Новый статус"),
  },
  async ({ campaign_id, status }) => {
    const d = await metaPost(`/${campaign_id}`, { status });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ success: true, campaign_id, new_status: status, result: d }),
      }],
    };
  }
);

// ── TOOL: toggle_adset ────────────────────────────────────────────────────────
server.tool(
  "toggle_adset",
  "Запустить или поставить на паузу адсет",
  {
    adset_id: z.string().describe("ID адсета"),
    status: z.enum(["ACTIVE", "PAUSED"]).describe("Новый статус"),
  },
  async ({ adset_id, status }) => {
    const d = await metaPost(`/${adset_id}`, { status });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ success: true, adset_id, new_status: status, result: d }),
      }],
    };
  }
);

// ── TOOL: update_budget ───────────────────────────────────────────────────────
server.tool(
  "update_budget",
  "Изменить дневной бюджет кампании или адсета",
  {
    object_id: z.string().describe("ID кампании или адсета"),
    daily_budget_usd: z.number().describe("Новый дневной бюджет в USD"),
  },
  async ({ object_id, daily_budget_usd }) => {
    const daily_budget = Math.round(daily_budget_usd * 100); // cents
    const d = await metaPost(`/${object_id}`, { daily_budget });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ success: true, object_id, new_budget: `$${daily_budget_usd}`, result: d }),
      }],
    };
  }
);

// ── TOOL: duplicate_adset ─────────────────────────────────────────────────────
server.tool(
  "duplicate_adset",
  "Дублировать адсет (для масштабирования)",
  {
    adset_id: z.string().describe("ID адсета для дублирования"),
    new_budget_usd: z.number().optional().describe("Новый бюджет в USD (если не указан — как у оригинала)"),
  },
  async ({ adset_id, new_budget_usd }) => {
    const body = { deep_copy: true };
    if (new_budget_usd) body.daily_budget = Math.round(new_budget_usd * 100);
    const d = await metaPost(`/${adset_id}/copies`, body);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ success: true, original_adset_id: adset_id, new_adset: d }),
      }],
    };
  }
);

// ── TOOL: check_limits ────────────────────────────────────────────────────────
server.tool(
  "check_limits",
  "Проверить все кампании на нарушение лимитов и при необходимости паузнуть",
  {
    max_cpp: z.number().optional().default(20).describe("Макс. цена покупки $"),
    max_spend_no_conv: z.number().optional().default(10).describe("Макс. спенд без конверсий $"),
    min_ctr: z.number().optional().default(0.5).describe("Мин. CTR %"),
    auto_pause: z.boolean().optional().default(false).describe("Автоматически паузить нарушителей"),
  },
  async ({ max_cpp, max_spend_no_conv, min_ctr, auto_pause }) => {
    const { since, until } = dateRange(1); // за сегодня
    const d = await metaGet(`/act_${META_ACCOUNT_ID}/campaigns`, {
      fields: `id,name,status,insights.time_range({"since":"${since}","until":"${until}"}){spend,ctr,actions}`,
      limit: 50,
    });

    const violations = [];
    const paused = [];

    for (const c of d.data || []) {
      if (c.status !== "ACTIVE") continue;
      const ins = c.insights?.data?.[0];
      const spend = parseFloat(ins?.spend || 0);
      const ctr = parseFloat(ins?.ctr || 0);
      const purchases = ins?.actions?.find((a) => a.action_type === "purchase")?.value || 0;
      const cpp = purchases > 0 ? spend / purchases : null;

      const issues = [];
      if (spend >= max_spend_no_conv && purchases === 0)
        issues.push(`Спенд $${spend.toFixed(2)} без конверсий (лимит $${max_spend_no_conv})`);
      if (cpp && cpp > max_cpp)
        issues.push(`CPP $${cpp.toFixed(2)} > лимита $${max_cpp}`);
      if (spend > 2 && ctr < min_ctr)
        issues.push(`CTR ${ctr.toFixed(2)}% < мин ${min_ctr}%`);

      if (issues.length) {
        violations.push({ id: c.id, name: c.name, issues });
        if (auto_pause) {
          await metaPost(`/${c.id}`, { status: "PAUSED" });
          paused.push(c.name);
        }
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          checked_at: new Date().toISOString(),
          violations_found: violations.length,
          violations,
          auto_paused: paused,
        }, null, 2),
      }],
    };
  }
);

// ── TOOL: get_account_summary ─────────────────────────────────────────────────
server.tool(
  "get_account_summary",
  "Общая сводка по рекламному аккаунту за период",
  {
    days: z.number().optional().default(7),
  },
  async ({ days }) => {
    const { since, until } = dateRange(days);
    const d = await metaGet(`/act_${META_ACCOUNT_ID}/insights`, {
      fields: "spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type",
      time_range: JSON.stringify({ since, until }),
      level: "account",
    });

    const ins = d.data?.[0] || {};
    const purchases = ins.actions?.find((a) => a.action_type === "purchase")?.value || 0;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          period: `${days} дней`,
          spend: ins.spend ? `$${parseFloat(ins.spend).toFixed(2)}` : "$0",
          impressions: ins.impressions || 0,
          clicks: ins.clicks || 0,
          ctr: ins.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
          cpc: ins.cpc ? `$${parseFloat(ins.cpc).toFixed(2)}` : null,
          purchases,
          cpp: purchases > 0 ? `$${(parseFloat(ins.spend) / purchases).toFixed(2)}` : "нет конверсий",
        }, null, 2),
      }],
    };
  }
);

// ── Express + SSE transport ───────────────────────────────────────────────────
const app = express();
const transports = {};

// ── IP allowlist middleware ───────────────────────────────────────────────────
// Permits Anthropic's outbound IP range (160.79.104.0/21) and localhost.
const ALLOWED_RANGES = [
  new Netmask("160.79.104.0/21"), // Anthropic outbound IPs
];
const LOCALHOST_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function ipAllowlist(req, res, next) {
  // Express sets req.ip; honour X-Forwarded-For when behind a proxy.
  const raw = req.ip || req.socket.remoteAddress || "";
  // Strip IPv6-mapped IPv4 prefix so Netmask can parse it.
  const ip = raw.startsWith("::ffff:") ? raw.slice(7) : raw;

  if (LOCALHOST_IPS.has(raw) || LOCALHOST_IPS.has(ip)) {
    return next();
  }

  for (const block of ALLOWED_RANGES) {
    if (block.contains(ip)) {
      return next();
    }
  }

  console.warn(`[allowlist] Blocked request from ${ip}`);
  return res.status(403).json({ error: "Host not in allowlist" });
}

app.get("/sse", ipAllowlist, async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post("/messages", ipAllowlist, express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", account: META_ACCOUNT_ID ? "connected" : "no token" });
});

app.get("/", (req, res) => {
  res.json({
    service: "fb-ads-mcp",
    version: "1.0.0",
    status: "running",
    endpoints: {
      sse: "/sse",
      messages: "/messages",
      health: "/health",
    },
  });
});

app.listen(PORT, () => {
  console.log(`✅ FB Ads MCP server running on port ${PORT}`);
  console.log(`   Account: act_${META_ACCOUNT_ID}`);
  console.log(`   SSE endpoint: http://localhost:${PORT}/sse`);
});
