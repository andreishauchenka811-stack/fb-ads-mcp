import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import fetch from "node-fetch";
import { z } from "zod";

const META_TOKEN = process.env.META_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_PAGE_ID = process.env.META_PAGE_ID;
const PORT = process.env.PORT || 10000;
const BASE = "https://graph.facebook.com/v19.0";
const ATTRIBUTION = ["7d_click", "1d_view"];

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

function dateRange(days) {
  const until = new Date();
  const since = new Date(until);
  since.setDate(until.getDate() - (days - 1));
  return { time_range: JSON.stringify({ since: fmtDate(since), until: fmtDate(until) }) };
}

function todayRange() {
  const t = fmtDate(new Date());
  return { time_range: JSON.stringify({ since: t, until: t }) };
}

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

function insightsParams(range) {
  return {
    ...range,
    action_attribution_windows: JSON.stringify(ATTRIBUTION),
  };
}

function parsePurchases(ins) {
  if (!ins) return { purchases: 0, cpp: null, revenue: "0", roas: null };
  const spend = parseFloat(ins.spend || 0);
  const purchases = parseInt(ins.actions?.find((a) => a.action_type === "purchase")?.value || 0);
  const revenue = parseFloat(ins.action_values?.find((a) => a.action_type === "purchase")?.value || 0);
  const cpp = purchases > 0 ? (spend / purchases).toFixed(2) : null;
  const roas = spend > 0 && revenue > 0 ? (revenue / spend).toFixed(2) : null;
  return { purchases, cpp, revenue: revenue.toFixed(2), roas };
}

function adFlag(spend, purchases, ctr, freq) {
  if (spend >= 4 && purchases === 0) return "VYKLYUCHIT ($4+ bez pokupok)";
  if (freq > 3) return "USTALOST freq > 3";
  if (ctr < 0.5 && spend > 3) return "NIZKIY CTR";
  if (purchases > 0 && parseFloat(spend / purchases) < 5) return "POBEDITEL";
  return "NABLYUDAT";
}

function promotedObject(pixelId) {
  const pid = pixelId || META_PIXEL_ID;
  if (!pid) return {};
  return { promoted_object: { pixel_id: pid, custom_event_type: "PURCHASE" } };
}

function registerTools(s) {

  // HELLO
  s.tool("hello", "Proverka svyazi s serverom", {}, async () => ({
    content: [{ type: "text", text: "FB Ads MCP v3.1.0 podklyuchen!" }],
  }));

  // GET ACCOUNT OVERVIEW
  s.tool(
    "get_account_overview",
    "Obshchaya svodka po reklamnomu kabinetu s sravneniem segodnya/vchera",
    { days: z.number().min(1).max(90).default(14) },
    async ({ days }) => {
      const [main, today, yest] = await Promise.all([
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...insightsParams(dateRange(days)) }),
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...insightsParams(todayRange()) }),
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...insightsParams(yesterdayRange()) }),
      ]);
      const ins = main.data?.[0] || {};
      const { purchases, cpp, revenue, roas } = parsePurchases(ins);
      const t = parsePurchases(today.data?.[0]);
      const y = parsePurchases(yest.data?.[0]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period_days: days,
            itogo: {
              spend: `$${parseFloat(ins.spend || 0).toFixed(2)}`,
              impressions: ins.impressions || 0,
              clicks: ins.clicks || 0,
              ctr: ins.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
              cpc: ins.cpc ? `$${parseFloat(ins.cpc).toFixed(2)}` : null,
              cpm: ins.cpm ? `$${parseFloat(ins.cpm).toFixed(2)}` : null,
              purchases, cpp: cpp ? `$${cpp}` : "net konversiy",
              revenue: `$${revenue}`, roas: roas ? `${roas}x` : null,
            },
            segodnya: { spend: `$${parseFloat(today.data?.[0]?.spend || 0).toFixed(2)}`, purchases: t.purchases, cpp: t.cpp ? `$${t.cpp}` : "net", roas: t.roas ? `${t.roas}x` : null },
            vchera: { spend: `$${parseFloat(yest.data?.[0]?.spend || 0).toFixed(2)}`, purchases: y.purchases, cpp: y.cpp ? `$${y.cpp}` : "net", roas: y.roas ? `${y.roas}x` : null },
          }, null, 2),
        }],
      };
    }
  );

  // GET CAMPAIGNS
  s.tool(
    "get_campaigns",
    "Spisok kampaniy s metrikami",
    {
      days: z.number().min(1).max(90).default(14),
      status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL"),
      limit: z.number().min(10).max(200).default(50),
    },
    async ({ days, status, limit }) => {
      const params = {
        fields: `name,status,daily_budget,lifetime_budget,objective,insights{${INSIGHTS_FIELDS}}`,
        limit,
        ...insightsParams(dateRange(days)),
      };
      if (status !== "ALL") params.filtering = JSON.stringify([{ field: "effective_status", operator: "IN", value: [status] }]);
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/campaigns`, params);
      const campaigns = (data.data || []).map((c) => {
        const ins = c.insights?.data?.[0];
        const { purchases, cpp, roas } = parsePurchases(ins);
        return {
          id: c.id, name: c.name, status: c.status,
          daily_budget: c.daily_budget ? `$${(c.daily_budget / 100).toFixed(2)}` : null,
          spend: ins ? `$${parseFloat(ins.spend).toFixed(2)}` : "$0",
          purchases, cpp: cpp ? `$${cpp}` : "net", roas: roas ? `${roas}x` : null,
          ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
          frequency: ins?.frequency ? parseFloat(ins.frequency).toFixed(2) : null,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify({ vsego: campaigns.length, campaigns }, null, 2) }] };
    }
  );

  // GET ADSETS
  s.tool(
    "get_adsets",
    "Poluchit adsety kampanii ili vsego kabineta",
    {
      campaign_id: z.string().optional(),
      days: z.number().default(14),
      status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL"),
    },
    async ({ campaign_id, days, status }) => {
      const params = {
        fields: `name,status,daily_budget,campaign{name},insights{${INSIGHTS_FIELDS}}`,
        limit: 100,
        ...insightsParams(dateRange(days)),
      };
      if (status !== "ALL") params.filtering = JSON.stringify([{ field: "effective_status", operator: "IN", value: [status] }]);
      const url = campaign_id ? `/${campaign_id}/adsets` : `/act_${META_ACCOUNT_ID}/adsets`;
      const data = await metaGet(url, params);
      const adsets = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        const flag = spend >= 4 && purchases === 0 ? "VYKLYUCHIT" : spend >= 2 && purchases === 0 ? "NABLYUDAT" : "OK";
        return {
          id: a.id, name: a.name, status: a.status,
          campaign: a.campaign?.name,
          daily_budget: a.daily_budget ? `$${(a.daily_budget / 100).toFixed(2)}` : null,
          spend: `$${spend.toFixed(2)}`, purchases, cpp: cpp ? `$${cpp}` : "net",
          ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
          frequency: ins?.frequency ? parseFloat(ins.frequency).toFixed(2) : null,
          flag,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify({ vsego: adsets.length, adsets }, null, 2) }] };
    }
  );

  // GET ADS
  s.tool(
    "get_ads",
    "Spisok obyavleniy so statusom i metrikami",
    {
      campaign_id: z.string().optional(),
      adset_id: z.string().optional(),
      days: z.number().default(7),
      status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL"),
    },
    async ({ campaign_id, adset_id, days, status }) => {
      const params = {
        fields: `name,status,creative{title,body,image_url},insights{${INSIGHTS_FIELDS}}`,
        limit: 100,
        ...insightsParams(dateRange(days)),
      };
      if (status !== "ALL") params.filtering = JSON.stringify([{ field: "effective_status", operator: "IN", value: [status] }]);
      const url = adset_id ? `/${adset_id}/ads` : campaign_id ? `/${campaign_id}/ads` : `/act_${META_ACCOUNT_ID}/ads`;
      const data = await metaGet(url, params);
      const ads = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        const ctr = parseFloat(ins?.ctr || 0);
        const freq = parseFloat(ins?.frequency || 0);
        return {
          id: a.id, name: a.name, status: a.status,
          creative_title: a.creative?.title,
          creative_body: a.creative?.body?.substring(0, 100),
          spend: `$${spend.toFixed(2)}`, purchases, cpp: cpp ? `$${cpp}` : "net",
          ctr: `${ctr.toFixed(2)}%`, frequency: freq.toFixed(2),
          flag: adFlag(spend, purchases, ctr, freq),
        };
      });
      return { content: [{ type: "text", text: JSON.stringify({ vsego: ads.length, ads }, null, 2) }] };
    }
  );

  // GET ADS TODAY
  s.tool(
    "get_ads_today",
    "Obyavleniya s metrikami strogo za segodnya",
    { status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL") },
    async ({ status }) => {
      const params = {
        fields: `name,status,creative{title,body},insights{${INSIGHTS_FIELDS}}`,
        limit: 100,
        ...insightsParams(todayRange()),
      };
      if (status !== "ALL") params.filtering = JSON.stringify([{ field: "effective_status", operator: "IN", value: [status] }]);
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/ads`, params);
      const ads = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        return {
          id: a.id, name: a.name, status: a.status,
          creative: a.creative?.body?.substring(0, 80),
          spend: `$${spend.toFixed(2)}`, purchases, cpp: cpp ? `$${cpp}` : "net",
          ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
          flag: adFlag(spend, purchases, parseFloat(ins?.ctr || 0), parseFloat(ins?.frequency || 0)),
        };
      });
      return { content: [{ type: "text", text: JSON.stringify({ date: fmtDate(new Date()), vsego: ads.length, ads }, null, 2) }] };
    }
  );

  // GET CAMPAIGN STATS
  s.tool(
    "get_campaign_stats",
    "Detalnaya statistika po odnoy kampanii za lyuboy period",
    { campaign_id: z.string(), days: z.number().default(7) },
    async ({ campaign_id, days }) => {
      const [campaign, adsets] = await Promise.all([
        metaGet(`/${campaign_id}`, { fields: `name,status,daily_budget,objective,insights{${INSIGHTS_FIELDS}}`, ...insightsParams(dateRange(days)) }),
        metaGet(`/${campaign_id}/adsets`, { fields: `name,status,daily_budget,insights{${INSIGHTS_FIELDS}}`, ...insightsParams(dateRange(days)), limit: 50 }),
      ]);
      const ins = campaign.insights?.data?.[0];
      const { purchases, cpp, revenue, roas } = parsePurchases(ins);
      const adsetList = (adsets.data || []).map((a) => {
        const ai = a.insights?.data?.[0];
        const ap = parsePurchases(ai);
        return {
          id: a.id, name: a.name, status: a.status,
          daily_budget: a.daily_budget ? `$${(a.daily_budget / 100).toFixed(2)}` : null,
          spend: `$${parseFloat(ai?.spend || 0).toFixed(2)}`,
          purchases: ap.purchases, cpp: ap.cpp ? `$${ap.cpp}` : "net",
          ctr: ai?.ctr ? `${parseFloat(ai.ctr).toFixed(2)}%` : "0%",
        };
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            campaign: campaign.name, status: campaign.status, days,
            itogo: { spend: `$${parseFloat(ins?.spend || 0).toFixed(2)}`, purchases, cpp: cpp ? `$${cpp}` : "net", roas: roas ? `${roas}x` : null, revenue: `$${revenue}` },
            adsets: adsetList,
          }, null, 2),
        }],
      };
    }
  );

  // GET HOURLY STATS
  s.tool(
    "get_hourly_stats",
    "Razбivka rashoda i pokupok po chasam za segodnya ili vchera",
    { day: z.enum(["today", "yesterday"]).default("today") },
    async ({ day }) => {
      const range = day === "today" ? todayRange() : yesterdayRange();
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/insights`, {
        fields: "spend,actions,impressions",
        time_increment: "1",
        breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone",
        ...range,
      });
      const hours = (data.data || []).map((h) => ({
        hour: h.hourly_stats_aggregated_by_advertiser_time_zone,
        spend: `$${parseFloat(h.spend || 0).toFixed(2)}`,
        purchases: parseInt(h.actions?.find((a) => a.action_type === "purchase")?.value || 0),
      })).sort((a, b) => (a.hour || "").localeCompare(b.hour || ""));
      return { content: [{ type: "text", text: JSON.stringify({ day, hours }, null, 2) }] };
    }
  );

  // GET AUDIENCE INSIGHTS
  s.tool(
    "get_audience_insights",
    "Kto realno pokupaet: vozrast, pol, region",
    {
      days: z.number().default(14),
      breakdown: z.enum(["age", "gender", "region", "age,gender"]).default("age,gender"),
    },
    async ({ days, breakdown }) => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/insights`, {
        fields: `spend,impressions,clicks,ctr,actions,cost_per_action_type`,
        breakdowns: breakdown,
        ...insightsParams(dateRange(days)),
        limit: 100,
      });
      const rows = (data.data || []).map((r) => {
        const purchases = parseInt(r.actions?.find((a) => a.action_type === "purchase")?.value || 0);
        const spend = parseFloat(r.spend || 0);
        return {
          ...(r.age && { age: r.age }),
          ...(r.gender && { gender: r.gender }),
          ...(r.region && { region: r.region }),
          spend: `$${spend.toFixed(2)}`, purchases,
          cpp: purchases > 0 ? `$${(spend / purchases).toFixed(2)}` : "net",
          ctr: r.ctr ? `${parseFloat(r.ctr).toFixed(2)}%` : "0%",
        };
      }).sort((a, b) => (b.purchases || 0) - (a.purchases || 0));
      return { content: [{ type: "text", text: JSON.stringify({ breakdown, days, audience: rows }, null, 2) }] };
    }
  );

  // GET PLACEMENTS BREAKDOWN
  s.tool(
    "get_placements_breakdown",
    "Razbivka po pleysmentam: Feed / Reels / Stories / Audience Network",
    { days: z.number().default(7), campaign_id: z.string().optional() },
    async ({ days, campaign_id }) => {
      const url = campaign_id ? `/${campaign_id}/insights` : `/act_${META_ACCOUNT_ID}/insights`;
      const data = await metaGet(url, {
        fields: `spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type`,
        breakdowns: "publisher_platform,platform_position",
        ...insightsParams(dateRange(days)),
        limit: 100,
      });
      const rows = (data.data || []).map((r) => {
        const purchases = parseInt(r.actions?.find((a) => a.action_type === "purchase")?.value || 0);
        const spend = parseFloat(r.spend || 0);
        return {
          platform: r.publisher_platform, position: r.platform_position,
          spend: `$${spend.toFixed(2)}`, purchases,
          cpp: purchases > 0 ? `$${(spend / purchases).toFixed(2)}` : "net",
          ctr: r.ctr ? `${parseFloat(r.ctr).toFixed(2)}%` : "0%",
        };
      }).sort((a, b) => parseFloat(b.spend.replace("$", "")) - parseFloat(a.spend.replace("$", "")));
      return { content: [{ type: "text", text: JSON.stringify({ days, placements: rows }, null, 2) }] };
    }
  );

  // GET FREQUENCY ALERT
  s.tool(
    "get_frequency_alert",
    "Flag adsetov gde chastota prevyshaet porog",
    { threshold: z.number().default(2.5), days: z.number().default(7) },
    async ({ threshold, days }) => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/adsets`, {
        fields: `name,status,insights{frequency,spend,reach}`,
        ...insightsParams(dateRange(days)), limit: 100,
        filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
      });
      const alerts = (data.data || [])
        .map((a) => {
          const ins = a.insights?.data?.[0];
          return { id: a.id, name: a.name, frequency: parseFloat(ins?.frequency || 0), reach: ins?.reach || 0, spend: `$${parseFloat(ins?.spend || 0).toFixed(2)}` };
        })
        .filter((a) => a.frequency >= threshold)
        .sort((a, b) => b.frequency - a.frequency);
      return { content: [{ type: "text", text: JSON.stringify({ threshold, days, count: alerts.length, adsets: alerts }, null, 2) }] };
    }
  );

  // GET BUDGET PACING
  s.tool(
    "get_budget_pacing",
    "Skolko byudzheta potracheno ot dnevnogo v % s uchetom vremeni sutok",
    {},
    async () => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/adsets`, {
        fields: `name,status,daily_budget,insights{spend}`,
        ...insightsParams(todayRange()), limit: 100,
        filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
      });
      const now = new Date();
      const dayPct = ((now.getHours() * 60 + now.getMinutes()) / 1440 * 100).toFixed(1);
      const pacing = (data.data || []).filter((a) => a.daily_budget).map((a) => {
        const budget = parseFloat(a.daily_budget) / 100;
        const spent = parseFloat(a.insights?.data?.[0]?.spend || 0);
        const spentPct = (spent / budget * 100).toFixed(1);
        const diff = parseFloat(spentPct) - parseFloat(dayPct);
        const pace = diff < -20 ? "MEDLENNO" : diff > 20 ? "BYSTRO (zakonchitsya ranshe)" : "NORMA";
        return { name: a.name, budget: `$${budget.toFixed(2)}`, spent: `$${spent.toFixed(2)}`, spent_pct: `${spentPct}%`, day_passed_pct: `${dayPct}%`, pace };
      });
      return { content: [{ type: "text", text: JSON.stringify({ time: now.toTimeString().slice(0, 5), day_passed: `${dayPct}%`, adsets: pacing }, null, 2) }] };
    }
  );

  // GET ALERTS
  s.tool(
    "get_alerts",
    "Svodka anomaliy: rost CPP, padenie CTR, nulevye pokupki, vysokaya chastota",
    {
      max_cpp: z.number().default(6),
      min_ctr: z.number().default(0.5),
      max_frequency: z.number().default(3.0),
      spend_no_conv: z.number().default(4),
    },
    async ({ max_cpp, min_ctr, max_frequency, spend_no_conv }) => {
      const [adsetsData, adsData] = await Promise.all([
        metaGet(`/act_${META_ACCOUNT_ID}/adsets`, { fields: `name,status,insights{spend,ctr,frequency,actions}`, ...insightsParams(todayRange()), limit: 100, filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]) }),
        metaGet(`/act_${META_ACCOUNT_ID}/ads`, { fields: `name,status,insights{spend,ctr,actions}`, ...insightsParams(todayRange()), limit: 100, filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]) }),
      ]);
      const alerts = [];
      for (const a of adsetsData.data || []) {
        const ins = a.insights?.data?.[0];
        const spend = parseFloat(ins?.spend || 0);
        const ctr = parseFloat(ins?.ctr || 0);
        const freq = parseFloat(ins?.frequency || 0);
        const purchases = parseInt(ins?.actions?.find((x) => x.action_type === "purchase")?.value || 0);
        const cpp = purchases > 0 ? spend / purchases : null;
        if (spend >= spend_no_conv && purchases === 0) alerts.push({ type: "NET_KONVERSIY", object: "adset", name: a.name, details: `$${spend.toFixed(2)} potracheno, 0 pokupok` });
        if (cpp && cpp > max_cpp) alerts.push({ type: "VYSOKIY_CPP", object: "adset", name: a.name, details: `CPP $${cpp.toFixed(2)} > $${max_cpp}` });
        if (spend > 2 && ctr < min_ctr) alerts.push({ type: "NIZKIY_CTR", object: "adset", name: a.name, details: `CTR ${ctr.toFixed(2)}% < ${min_ctr}%` });
        if (freq > max_frequency) alerts.push({ type: "VYSOKAYA_CHASTOTA", object: "adset", name: a.name, details: `Frequency ${freq.toFixed(2)} > ${max_frequency}` });
      }
      for (const a of adsData.data || []) {
        const ins = a.insights?.data?.[0];
        const spend = parseFloat(ins?.spend || 0);
        const purchases = parseInt(ins?.actions?.find((x) => x.action_type === "purchase")?.value || 0);
        if (spend >= spend_no_conv && purchases === 0) alerts.push({ type: "NET_KONVERSIY", object: "ad", name: a.name, details: `$${spend.toFixed(2)} bez pokupok - vyklyuchit` });
      }
      return { content: [{ type: "text", text: JSON.stringify({ time: new Date().toTimeString().slice(0, 5), total_alerts: alerts.length, alerts }, null, 2) }] };
    }
  );

  // GET DAILY SUMMARY
  s.tool(
    "get_daily_summary",
    "Itog dnya: rashod / pokupki / ROAS / luchshiy kreo / chto vyklyuchit",
    {},
    async () => {
      const [accToday, accYest, adsToday] = await Promise.all([
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...insightsParams(todayRange()) }),
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...insightsParams(yesterdayRange()) }),
        metaGet(`/act_${META_ACCOUNT_ID}/ads`, { fields: `name,status,creative{title,body},insights{${INSIGHTS_FIELDS}}`, ...insightsParams(todayRange()), limit: 100 }),
      ]);
      const today = parsePurchases(accToday.data?.[0]);
      const yest = parsePurchases(accYest.data?.[0]);
      const tIns = accToday.data?.[0] || {};
      const yIns = accYest.data?.[0] || {};
      const ads = (adsToday.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        return { name: a.name, spend, purchases, cpp: cpp ? parseFloat(cpp) : null };
      });
      const winner = ads.filter((a) => a.purchases > 0).sort((a, b) => (a.cpp || 99) - (b.cpp || 99))[0];
      const toKill = ads.filter((a) => a.spend >= 4 && a.purchases === 0);
      const spendToday = parseFloat(tIns.spend || 0);
      const spendYest = parseFloat(yIns.spend || 0);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            date: fmtDate(new Date()),
            segodnya: { spend: `$${spendToday.toFixed(2)}`, purchases: today.purchases, cpp: today.cpp ? `$${today.cpp}` : "net", roas: today.roas ? `${today.roas}x` : null, ctr: tIns.ctr ? `${parseFloat(tIns.ctr).toFixed(2)}%` : "0%" },
            vs_vchera: { purchases: `${today.purchases - yest.purchases >= 0 ? "+" : ""}${today.purchases - yest.purchases}`, spend: `${spendToday - spendYest >= 0 ? "+" : ""}$${(spendToday - spendYest).toFixed(2)}` },
            luchshiy_kreo: winner ? { name: winner.name, purchases: winner.purchases, cpp: `$${winner.cpp.toFixed(2)}` } : "net konversiy segodnya",
            vyklyuchit: toKill.map((a) => ({ name: a.name, spend: `$${a.spend.toFixed(2)}`, reason: "$4+ bez pokupok" })),
            itog: toKill.length > 0 ? `${toKill.length} obyavleniy nuzhno vyklyuchit` : "Vse v poryadke",
          }, null, 2),
        }],
      };
    }
  );

  // TOGGLE STATUS
  s.tool(
    "toggle_status",
    "Vklyuchit / vyklyuchit kampaniyu, adset ili obyavlenie",
    {
      entity_type: z.enum(["campaign", "adset", "ad"]),
      entity_id: z.string(),
      status: z.enum(["ACTIVE", "PAUSED"]),
    },
    async ({ entity_type, entity_id, status }) => {
      await metaPost(`/${entity_id}`, { status });
      return { content: [{ type: "text", text: `OK: ${entity_type} ${entity_id} -> ${status}` }] };
    }
  );

  // SCALE BUDGET
  s.tool(
    "scale_budget",
    "Izmenit dnevnoy ili lifetime byudzhet",
    {
      entity_type: z.enum(["campaign", "adset"]),
      entity_id: z.string(),
      budget: z.number().min(100).describe("Byudzhet v kopeykakh (500 = $5, 1500 = $15)"),
      is_lifetime: z.boolean().default(false),
    },
    async ({ entity_type, entity_id, budget, is_lifetime }) => {
      const body = is_lifetime ? { lifetime_budget: budget } : { daily_budget: budget };
      await metaPost(`/${entity_id}`, body);
      return { content: [{ type: "text", text: `OK: ${entity_type} ${entity_id} budget -> $${(budget / 100).toFixed(2)} (${is_lifetime ? "lifetime" : "daily"})` }] };
    }
  );

  // CREATE CAMPAIGN
  s.tool(
    "create_campaign",
    "Sozdat kampaniyu s nulya",
    {
      name: z.string(),
      objective: z.enum(["OUTCOME_SALES", "OUTCOME_LEADS", "OUTCOME_TRAFFIC", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT"]).default("OUTCOME_SALES"),
      daily_budget_usd: z.number().optional(),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async ({ name, objective, daily_budget_usd, status }) => {
      const body = { name, objective, status, special_ad_categories: [] };
      if (daily_budget_usd) body.daily_budget = Math.round(daily_budget_usd * 100);
      const d = await metaPost(`/act_${META_ACCOUNT_ID}/campaigns`, body);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, campaign_id: d.id, name, objective, status }, null, 2) }] };
    }
  );

  // CREATE ADSET
  s.tool(
    "create_adset",
    "Sozdat novyy adset s polnymi nastroyki targetinga",
    {
      name: z.string(),
      campaign_id: z.string(),
      daily_budget_usd: z.number(),
      optimization_goal: z.enum(["OFFSITE_CONVERSIONS", "LINK_CLICKS", "REACH", "IMPRESSIONS"]).default("OFFSITE_CONVERSIONS"),
      pixel_id: z.string().optional(),
      countries: z.array(z.string()).default(["UA"]),
      excluded_countries: z.array(z.string()).default([]),
      languages: z.array(z.number()).default([]),
      age_min: z.number().default(18),
      age_max: z.number().default(65),
      genders: z.array(z.number()).default([]),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
      start_time: z.string().optional(),
    },
    async ({ name, campaign_id, daily_budget_usd, optimization_goal, pixel_id, countries, excluded_countries, languages, age_min, age_max, genders, status, start_time }) => {
      const geo_locations = countries.includes("WORLDWIDE")
        ? { location_types: ["home", "recent"] }
        : { countries };
      if (excluded_countries.length) geo_locations.excluded_countries = excluded_countries;

      const targeting = { age_min, age_max, geo_locations };
      if (languages.length) targeting.locales = languages;
      if (genders.length) targeting.genders = genders;

      const body = {
        name, campaign_id, status,
        daily_budget: Math.round(daily_budget_usd * 100),
        optimization_goal,
        billing_event: "IMPRESSIONS",
        targeting,
        ...promotedObject(pixel_id),
        ...(start_time && { start_time }),
      };
      const d = await metaPost(`/act_${META_ACCOUNT_ID}/adsets`, body);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, adset_id: d.id, name, campaign_id, budget: `$${daily_budget_usd}`, countries, status }, null, 2) }] };
    }
  );

  // DUPLICATE ADSET
  s.tool(
    "duplicate_adset",
    "Dublirovat adset dlya masshtabirovaniya ili smeny geo",
    {
      adset_id: z.string(),
      new_name: z.string().optional(),
      new_budget_usd: z.number().optional(),
      new_countries: z.array(z.string()).optional(),
      new_languages: z.array(z.number()).optional(),
      status_after: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async ({ adset_id, new_name, new_budget_usd, new_countries, new_languages, status_after }) => {
      const body = { deep_copy: true, status_option: status_after };
      if (new_budget_usd) body.daily_budget = Math.round(new_budget_usd * 100);

      const d = await metaPost(`/${adset_id}/copies`, body);
      const newId = d.copied_adset_id;

      // Apply geo/language/name changes if needed
      if (newId && (new_countries || new_languages || new_name)) {
        const current = await metaGet(`/${newId}`, { fields: "targeting,name" });
        const updates = {};
        if (new_name) updates.name = new_name;
        if (new_countries || new_languages) {
          const targeting = { ...current.targeting };
          if (new_countries) targeting.geo_locations = new_countries.includes("WORLDWIDE") ? { location_types: ["home", "recent"] } : { countries: new_countries };
          if (new_languages) targeting.locales = new_languages.length ? new_languages : undefined;
          updates.targeting = targeting;
        }
        await metaPost(`/${newId}`, updates);
      }

      return { content: [{ type: "text", text: JSON.stringify({ success: true, new_adset_id: newId, status: status_after, changes: { new_name, new_budget_usd, new_countries, new_languages } }, null, 2) }] };
    }
  );

  // UPDATE TARGETING
  s.tool(
    "update_targeting",
    "Menyat geo, vozrast, pol, yazyki adseta na letu",
    {
      adset_id: z.string(),
      countries: z.array(z.string()).optional(),
      excluded_countries: z.array(z.string()).optional(),
      age_min: z.number().optional(),
      age_max: z.number().optional(),
      genders: z.array(z.number()).optional(),
      languages: z.array(z.number()).optional(),
    },
    async ({ adset_id, countries, excluded_countries, age_min, age_max, genders, languages }) => {
      const current = await metaGet(`/${adset_id}`, { fields: "targeting" });
      const targeting = { ...current.targeting };
      if (countries) {
        targeting.geo_locations = countries.includes("WORLDWIDE") ? { location_types: ["home", "recent"] } : { countries };
        if (excluded_countries?.length) targeting.geo_locations.excluded_countries = excluded_countries;
      }
      if (age_min !== undefined) targeting.age_min = age_min;
      if (age_max !== undefined) targeting.age_max = age_max;
      if (genders !== undefined) targeting.genders = genders.length ? genders : undefined;
      if (languages !== undefined) targeting.locales = languages.length ? languages : undefined;
      await metaPost(`/${adset_id}`, { targeting });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, adset_id, updated: { countries, excluded_countries, age_min, age_max, genders, languages } }, null, 2) }] };
    }
  );

  // UPLOAD IMAGE
  s.tool(
    "upload_image",
    "Zagruzit izobrazhenie po URL v biblioteku reklamnogo akkaunta",
    {
      image_url: z.string(),
      name: z.string().optional(),
    },
    async ({ image_url, name }) => {
      const body = { url: image_url };
      if (name) body.name = name;
      const d = await metaPost(`/act_${META_ACCOUNT_ID}/adimages`, body);
      const imgData = d.images?.[Object.keys(d.images || {})[0]];
      return { content: [{ type: "text", text: JSON.stringify({ success: true, hash: imgData?.hash, url: imgData?.url }, null, 2) }] };
    }
  );

  // CREATE AD
  s.tool(
    "create_ad",
    "Sozdat obyavlenie s novym kreo, tekstom i zagolovkom",
    {
      name: z.string(),
      adset_id: z.string(),
      page_id: z.string().optional().describe("Facebook Page ID (esli ne ukazan - iz ENV)"),
      primary_text: z.string(),
      headline: z.string().optional(),
      description: z.string().optional(),
      link_url: z.string(),
      image_hash: z.string().optional(),
      video_id: z.string().optional(),
      call_to_action: z.enum(["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "GET_OFFER", "BUY_NOW", "SUBSCRIBE"]).default("LEARN_MORE"),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async ({ name, adset_id, page_id, primary_text, headline, description, link_url, image_hash, video_id, call_to_action, status }) => {
      const pid = page_id || META_PAGE_ID;
      const link_data = {
        message: primary_text,
        link: link_url,
        call_to_action: { type: call_to_action, value: { link: link_url } },
        ...(headline && { name: headline }),
        ...(description && { description }),
        ...(image_hash && { image_hash }),
        ...(video_id && { video_id }),
      };
      const creative = await metaPost(`/act_${META_ACCOUNT_ID}/adcreatives`, {
        name: `creative_${name}_${Date.now()}`,
        object_story_spec: { page_id: pid, link_data },
      });
      const ad = await metaPost(`/act_${META_ACCOUNT_ID}/ads`, {
        name, adset_id, creative: { creative_id: creative.id }, status,
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, ad_id: ad.id, creative_id: creative.id, name, status }, null, 2) }] };
    }
  );

  // DUPLICATE AD
  s.tool(
    "duplicate_ad",
    "Dublirovat obyavlenie dlya testov",
    {
      ad_id: z.string(),
      adset_id: z.string().optional(),
      status_after: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async ({ ad_id, adset_id, status_after }) => {
      const body = { deep_copy: true, status_option: status_after };
      if (adset_id) body.adset_id = adset_id;
      const d = await metaPost(`/${ad_id}/copies`, body);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, new_ad_id: d.copied_ad_id, status: status_after }, null, 2) }] };
    }
  );

  // SET BID CAP
  s.tool(
    "set_bid_cap",
    "Postavit ogranichenie stavki na adset",
    {
      adset_id: z.string(),
      bid_cap_usd: z.number(),
    },
    async ({ adset_id, bid_cap_usd }) => {
      await metaPost(`/${adset_id}`, { bid_amount: Math.round(bid_cap_usd * 100), bid_strategy: "LOWEST_COST_WITH_BID_CAP" });
      return { content: [{ type: "text", text: `OK: bid cap adset ${adset_id} = $${bid_cap_usd}` }] };
    }
  );

  // GET AB TEST RESULTS
  s.tool(
    "get_ab_test_results",
    "Sravnenie dvukh kreo ili adsetov po klyuchevym metrikam",
    {
      id_a: z.string(),
      id_b: z.string(),
      type: z.enum(["ad", "adset"]).default("ad"),
      days: z.number().default(7),
    },
    async ({ id_a, id_b, days }) => {
      const fields = `name,status,insights{${INSIGHTS_FIELDS}}`;
      const params = insightsParams(dateRange(days));
      const [a, b] = await Promise.all([
        metaGet(`/${id_a}`, { fields, ...params }),
        metaGet(`/${id_b}`, { fields, ...params }),
      ]);
      const parse = (obj) => {
        const ins = obj.insights?.data?.[0];
        const { purchases, cpp, roas } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        return { name: obj.name, spend: `$${spend.toFixed(2)}`, purchases, cpp: cpp ? `$${cpp}` : "net", roas: roas ? `${roas}x` : null, ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%", _cpp: cpp ? parseFloat(cpp) : null, _purchases: purchases };
      };
      const ra = parse(a), rb = parse(b);
      const winner = ra._cpp && rb._cpp ? (ra._cpp < rb._cpp ? "A" : "B") : ra._purchases > rb._purchases ? "A" : rb._purchases > ra._purchases ? "B" : "net dannyh";
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ days, A: ra, B: rb, winner, recommendation: winner !== "net dannyh" ? `Masshtabirovat ${winner}, vyklyuchit ${winner === "A" ? "B" : "A"} esli raznica stabilna 3+ dnya` : "Nedostatochno dannyh - zhdat minimum 3 dnya" }, null, 2),
        }],
      };
    }
  );

  // GET WINNER RECOMMENDATION
  s.tool(
    "get_winner_recommendation",
    "Avtovyvod pobeditelya sredi vsekh aktivnykh kreo",
    { days: z.number().default(7), min_spend_usd: z.number().default(3) },
    async ({ days, min_spend_usd }) => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/ads`, {
        fields: `name,status,insights{${INSIGHTS_FIELDS}}`,
        ...insightsParams(dateRange(days)), limit: 100,
      });
      const ads = (data.data || [])
        .map((a) => {
          const ins = a.insights?.data?.[0];
          const spend = parseFloat(ins?.spend || 0);
          const { purchases, cpp, roas } = parsePurchases(ins);
          const ctr = parseFloat(ins?.ctr || 0);
          const freq = parseFloat(ins?.frequency || 0);
          let action = "malo dannyh";
          if (spend >= min_spend_usd) {
            if (purchases === 0 && spend >= 4) action = "VYKLYUCHIT";
            else if (cpp && parseFloat(cpp) <= 5 && purchases >= 2) action = "MASSHTABIROVAT";
            else if (ctr < 0.5 && spend > 5) action = "problema s CTR";
            else if (freq > 3) action = "auditoriya vygoraet";
            else if (purchases > 0) action = "nablyudat 1-2 dnya";
          }
          return { name: a.name, spend: `$${spend.toFixed(2)}`, purchases, cpp: cpp ? `$${cpp}` : "net", ctr: `${ctr.toFixed(2)}%`, frequency: freq.toFixed(2), action, _purchases: purchases, _cpp: cpp ? parseFloat(cpp) : 99, _spend: spend };
        })
        .filter((a) => a._spend >= min_spend_usd)
        .sort((a, b) => b._purchases - a._purchases || a._cpp - b._cpp);

      const winner = ads.find((a) => a._purchases >= 2 && a._cpp <= 5);
      return { content: [{ type: "text", text: JSON.stringify({ days, winner: winner ? { name: winner.name, cpp: winner.cpp, purchases: winner.purchases } : "ne opredelen", all_ads: ads }, null, 2) }] };
    }
  );

  // GET ACCOUNT LIMITS
  s.tool(
    "get_account_limits",
    "Proverit limity akkaunta: spend-limit, ostatok, status",
    {},
    async () => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}`, {
        fields: "name,account_status,currency,spend_cap,amount_spent,balance,disable_reason,timezone_name",
      });
      const statusMap = { 1: "ACTIVE", 2: "DISABLED", 3: "UNSETTLED", 7: "PENDING_RISK_REVIEW", 9: "IN_GRACE_PERIOD", 101: "TEMP_DISABLED" };
      const spent = parseFloat(data.amount_spent || 0) / 100;
      const cap = data.spend_cap ? parseFloat(data.spend_cap) / 100 : null;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            account: data.name,
            status: statusMap[data.account_status] || data.account_status,
            currency: data.currency,
            spent_total: `$${spent.toFixed(2)}`,
            spend_cap: cap ? `$${cap.toFixed(2)}` : "ne ustanovlen",
            remaining: cap ? `$${(cap - spent).toFixed(2)}` : "unlimited",
            balance: data.balance ? `$${(parseFloat(data.balance) / 100).toFixed(2)}` : null,
            timezone: data.timezone_name,
          }, null, 2),
        }],
      };
    }
  );

  // PAUSE ALL EMERGENCY
  s.tool(
    "pause_all_emergency",
    "EKSTRENNAYA OSTANOVKA - postavit vse aktivnye kampanii na pauzu",
    { confirm: z.boolean().describe("Obyazatelno true dlya vypolneniya") },
    async ({ confirm }) => {
      if (!confirm) return { content: [{ type: "text", text: "Ne vypolneno. Pereday confirm: true dlya podtverzhdeniya." }] };
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/campaigns`, {
        fields: "id,name,status",
        filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
        limit: 100,
      });
      const results = [];
      for (const c of data.data || []) {
        await metaPost(`/${c.id}`, { status: "PAUSED" });
        results.push(c.name);
      }
      return { content: [{ type: "text", text: JSON.stringify({ status: "VSE KAMPANII OSTANOVLENY", count: results.length, campaigns: results }, null, 2) }] };
    }
  );
}

// EXPRESS
const app = express();
const transports = new Map();

app.get("/", (req, res) => res.send("FB Ads MCP Server v3.1.0"));
app.get("/health", (req, res) => res.json({ status: "ok", account: META_ACCOUNT_ID ? "connected" : "no token" }));

app.get("/sse", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  const mcpServer = new McpServer({ name: "fb-ads-mcp", version: "3.1.0" });
  registerTools(mcpServer);

  res.on("close", () => {
    transports.delete(transport.sessionId);
    mcpServer.close().catch(() => {});
  });

  await mcpServer.connect(transport);
  console.log(`Connected [${transport.sessionId}]`);

  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 25000);
  res.on("close", () => clearInterval(keepalive));
});

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
  console.log(`FB Ads MCP v3.1.0 on port ${PORT}`);
  console.log(`Account: act_${META_ACCOUNT_ID}`);
});
