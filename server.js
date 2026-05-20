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

// -- Multi-account ----------------------------------------------------------
const ACCT = {
  "1": process.env.ACCOUNT_ID_1, chizy: process.env.ACCOUNT_ID_1,
  "2": process.env.ACCOUNT_ID_2, letniy: process.env.ACCOUNT_ID_2,
  "3": process.env.ACCOUNT_ID_3, pp: process.env.ACCOUNT_ID_3,
};
const PIX = {
  "1": process.env.PIXEL_ID_1, chizy: process.env.PIXEL_ID_1,
  "2": process.env.PIXEL_ID_2, letniy: process.env.PIXEL_ID_2,
  "3": process.env.PIXEL_ID_3, pp: process.env.PIXEL_ID_3,
};
const PAGE = {
  "1": process.env.PAGE_ID_1, chizy: process.env.PAGE_ID_1,
  "2": process.env.PAGE_ID_2, letniy: process.env.PAGE_ID_2,
  "3": process.env.PAGE_ID_3, pp: process.env.PAGE_ID_3,
};

const resolveAcct = (a) => (a && ACCT[a.toLowerCase()]) || META_ACCOUNT_ID;
const resolvePix  = (a) => (a && PIX[a.toLowerCase()])  || META_PIXEL_ID;
const resolvePg   = (a) => (a && PAGE[a.toLowerCase()])  || META_PAGE_ID;

const ACCT_PARAM = z.string().optional().describe("1=chizy, 2=letniy, 3=pp, default=primary");

// In-memory scheduler
const scheduledTimers = new Map();

// -- Helpers ----------------------------------------------------------------

async function metaGet(path, params = {}) {
  const qs = new URLSearchParams({ access_token: META_TOKEN, ...params });
  const r = await fetch(`${BASE}${path}?${qs}`);
  const d = await r.json();
  if (d.error) {
    console.error("FB API Error [GET]", path, JSON.stringify(d.error));
    const e = d.error;
    throw new Error(`FB API ${e.code}/${e.error_subcode || 0}: ${e.message}${e.error_user_msg ? " | " + e.error_user_msg : ""} (fbtrace_id: ${e.fbtrace_id})`);
  }
  return d;
}

async function metaPost(path, body = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: META_TOKEN, ...body }),
  });
  const d = await r.json();
  if (d.error) {
    console.error("FB API Error [POST]", path, JSON.stringify(d.error));
    console.error("FB API Request body:", JSON.stringify({ ...body, access_token: "***" }));
    const e = d.error;
    throw new Error(`FB API ${e.code}/${e.error_subcode || 0}: ${e.message}${e.error_user_msg ? " | " + e.error_user_msg : ""} (fbtrace_id: ${e.fbtrace_id})`);
  }
  return d;
}

function fmtDate(d) { return d.toISOString().split("T")[0]; }

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
  const d = new Date(); d.setDate(d.getDate() - 1);
  const y = fmtDate(d);
  return { time_range: JSON.stringify({ since: y, until: y }) };
}

const ATTRIBUTION_WINDOWS = JSON.stringify(["7d_click", "1d_view"]);
const INSIGHTS_FIELDS = [
  "spend","impressions","reach","clicks",
  "ctr","cpc","cpm","frequency",
  "actions","cost_per_action_type","action_values",
].join(",");

function withAttribution(rangeObj) {
  return { ...rangeObj, action_attribution_windows: ATTRIBUTION_WINDOWS };
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
  if (spend >= 4 && purchases === 0) return "VYKLYUCHIT";
  if (freq > 3) return "USTALOST_freq>3";
  if (ctr < 0.5 && spend > 3) return "NIZKIY_CTR";
  if (purchases > 0 && spend > 0 && (spend / purchases) < 5) return "POBEDITEL";
  return "NABLYUDAT";
}

function promotedObject(pixelId) {
  if (!pixelId) return {};
  return { promoted_object: { pixel_id: pixelId, custom_event_type: "PURCHASE" } };
}

function rangeByPreset(date_preset, days) {
  if (date_preset === "today") return todayRange();
  if (date_preset === "yesterday") return yesterdayRange();
  return dateRange(days);
}

// -- Tools ------------------------------------------------------------------

function registerTools(s) {

  s.tool("hello", "Proverka svyazi s serverom", {}, async () => ({
    content: [{ type: "text", text: "FB Ads MCP v4.0.0 — multi-account OK" }],
  }));

  // GET ACCOUNT LIMITS
  s.tool("get_account_limits", "Proverit limity akkaunta: spend-limit, ostatok, status",
    { account: ACCT_PARAM },
    async ({ account }) => {
      const accId = resolveAcct(account);
      const data = await metaGet(`/act_${accId}`, {
        fields: "name,account_status,currency,spend_cap,amount_spent,balance,disable_reason,timezone_name",
      });
      const statusMap = { 1:"ACTIVE",2:"DISABLED",3:"UNSETTLED",7:"PENDING_RISK_REVIEW",101:"TEMP_DISABLED" };
      const spent = parseFloat(data.amount_spent || 0) / 100;
      const cap = data.spend_cap ? parseFloat(data.spend_cap) / 100 : null;
      return { content: [{ type: "text", text: JSON.stringify({
        account_key: account || "primary", account: data.name,
        status: statusMap[data.account_status] || String(data.account_status),
        currency: data.currency,
        spent_total: `$${spent.toFixed(2)}`,
        spend_cap: cap ? `$${cap.toFixed(2)}` : "ne ustanovlen",
        remaining: cap ? `$${(cap - spent).toFixed(2)}` : "unlimited",
        balance: data.balance ? `$${(parseFloat(data.balance) / 100).toFixed(2)}` : null,
        timezone: data.timezone_name,
      }, null, 2) }] };
    }
  );

  // GET ACCOUNT OVERVIEW
  s.tool("get_account_overview", "Obshchaya svodka po reklamnomu kabinetu s sravneniem segodnya/vchera",
    { days: z.number().min(1).max(90).default(7), account: ACCT_PARAM },
    async ({ days, account }) => {
      const accId = resolveAcct(account);
      const [main, today, yest] = await Promise.all([
        metaGet(`/act_${accId}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...withAttribution(dateRange(days)) }),
        metaGet(`/act_${accId}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...withAttribution(todayRange()) }),
        metaGet(`/act_${accId}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...withAttribution(yesterdayRange()) }),
      ]);
      const ins = main.data?.[0] || {};
      const { purchases, cpp, revenue, roas } = parsePurchases(ins);
      const t = parsePurchases(today.data?.[0]);
      const y = parsePurchases(yest.data?.[0]);
      const tIns = today.data?.[0] || {};
      const yIns = yest.data?.[0] || {};
      return { content: [{ type: "text", text: JSON.stringify({
        account_key: account || "primary", period_days: days,
        itogo: { spend:`$${parseFloat(ins.spend||0).toFixed(2)}`, impressions:ins.impressions||0, clicks:ins.clicks||0, ctr:ins.ctr?`${parseFloat(ins.ctr).toFixed(2)}%`:"0%", cpc:ins.cpc?`$${parseFloat(ins.cpc).toFixed(2)}`:null, cpm:ins.cpm?`$${parseFloat(ins.cpm).toFixed(2)}`:null, purchases, cpp:cpp?`$${cpp}`:"net", revenue:`$${revenue}`, roas:roas?`${roas}x`:null },
        segodnya: { spend:`$${parseFloat(tIns.spend||0).toFixed(2)}`, purchases:t.purchases, cpp:t.cpp?`$${t.cpp}`:"net", roas:t.roas?`${t.roas}x`:null, ctr:tIns.ctr?`${parseFloat(tIns.ctr).toFixed(2)}%`:"0%" },
        vchera: { spend:`$${parseFloat(yIns.spend||0).toFixed(2)}`, purchases:y.purchases, cpp:y.cpp?`$${y.cpp}`:"net", roas:y.roas?`${y.roas}x`:null },
      }, null, 2) }] };
    }
  );

  // GET CROSS ACCOUNT SUMMARY
  s.tool("get_cross_account_summary", "Svodka po vsem nastroiennym akkauntam odnovremenno",
    { days: z.number().min(1).max(90).default(7), date_preset: z.enum(["today","yesterday","custom"]).default("custom") },
    async ({ days, date_preset }) => {
      const range = rangeByPreset(date_preset, days);
      const allAccounts = [
        { key: "primary", id: META_ACCOUNT_ID },
        ...(process.env.ACCOUNT_ID_1 ? [{ key: "chizy",  id: process.env.ACCOUNT_ID_1 }] : []),
        ...(process.env.ACCOUNT_ID_2 ? [{ key: "letniy", id: process.env.ACCOUNT_ID_2 }] : []),
        ...(process.env.ACCOUNT_ID_3 ? [{ key: "pp",     id: process.env.ACCOUNT_ID_3 }] : []),
      ];
      const seen = new Set();
      const unique = allAccounts.filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });

      const results = await Promise.allSettled(unique.map(async (acc) => {
        const [overview, info] = await Promise.all([
          metaGet(`/act_${acc.id}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...withAttribution(range) }),
          metaGet(`/act_${acc.id}`, { fields: "name,account_status,currency" }),
        ]);
        const ins = overview.data?.[0];
        const { purchases, cpp, roas, revenue } = parsePurchases(ins);
        return { key: acc.key, name: info.name, spend:`$${parseFloat(ins?.spend||0).toFixed(2)}`, purchases, cpp:cpp?`$${cpp}`:"net", roas:roas?`${roas}x`:null, revenue:`$${revenue}`, ctr:ins?.ctr?`${parseFloat(ins.ctr).toFixed(2)}%`:"0%" };
      }));

      const accounts = results.map((r, i) => r.status === "fulfilled" ? r.value : { key: unique[i].key, error: r.reason?.message });
      const totalSpend = accounts.reduce((s, a) => s + parseFloat((a.spend||"$0").replace("$","")), 0);
      const totalPurchases = accounts.reduce((s, a) => s + (a.purchases||0), 0);

      return { content: [{ type: "text", text: JSON.stringify({
        period: date_preset !== "custom" ? date_preset : `${days}d`,
        accounts,
        total: { spend:`$${totalSpend.toFixed(2)}`, purchases:totalPurchases, cpp:totalPurchases>0?`$${(totalSpend/totalPurchases).toFixed(2)}`:"net" },
      }, null, 2) }] };
    }
  );

  // GET CAMPAIGNS
  s.tool("get_campaigns", "Spisok kampaniy s metrikami",
    { days:z.number().min(1).max(90).default(7), date_preset:z.enum(["today","yesterday","custom"]).default("custom"), status:z.enum(["ACTIVE","PAUSED","ALL"]).default("ALL"), limit:z.number().min(10).max(200).default(50), account:ACCT_PARAM },
    async ({ days, date_preset, status, limit, account }) => {
      const accId = resolveAcct(account);
      const range = rangeByPreset(date_preset, days);
      const params = { fields:`name,status,daily_budget,lifetime_budget,objective,insights{${INSIGHTS_FIELDS}}`, limit, ...withAttribution(range) };
      if (status !== "ALL") params.filtering = JSON.stringify([{ field:"effective_status", operator:"IN", value:[status] }]);
      const data = await metaGet(`/act_${accId}/campaigns`, params);
      const campaigns = (data.data || []).map((c) => {
        const ins = c.insights?.data?.[0];
        const { purchases, cpp, roas } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        return { id:c.id, name:c.name, status:c.status, daily_budget:c.daily_budget?`$${(c.daily_budget/100).toFixed(2)}`:null, spend:`$${spend.toFixed(2)}`, purchases, cpp:cpp?`$${cpp}`:"net", roas:roas?`${roas}x`:null, ctr:ins?.ctr?`${parseFloat(ins.ctr).toFixed(2)}%`:"0%", frequency:ins?.frequency?parseFloat(ins.frequency).toFixed(2):null, no_data:!ins };
      });
      return { content: [{ type:"text", text:JSON.stringify({ account_key:account||"primary", period:date_preset!=="custom"?date_preset:`${days}d`, vsego:campaigns.length, campaigns }, null, 2) }] };
    }
  );

  // GET ADSETS
  s.tool("get_adsets", "Poluchit adsety kampanii ili vsego kabineta",
    { campaign_id:z.string().optional(), days:z.number().default(7), date_preset:z.enum(["today","yesterday","custom"]).default("custom"), status:z.enum(["ACTIVE","PAUSED","ALL"]).default("ALL"), account:ACCT_PARAM },
    async ({ campaign_id, days, date_preset, status, account }) => {
      const accId = resolveAcct(account);
      const range = rangeByPreset(date_preset, days);
      const params = { fields:`name,status,daily_budget,campaign{name},insights{${INSIGHTS_FIELDS}}`, limit:100, ...withAttribution(range) };
      if (status !== "ALL") params.filtering = JSON.stringify([{ field:"effective_status", operator:"IN", value:[status] }]);
      const url = campaign_id ? `/${campaign_id}/adsets` : `/act_${accId}/adsets`;
      const data = await metaGet(url, params);
      const adsets = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        const flag = spend >= 4 && purchases === 0 ? "VYKLYUCHIT" : spend >= 2 && purchases === 0 ? "NABLYUDAT" : "OK";
        return { id:a.id, name:a.name, status:a.status, campaign:a.campaign?.name, daily_budget:a.daily_budget?`$${(a.daily_budget/100).toFixed(2)}`:null, spend:`$${spend.toFixed(2)}`, purchases, cpp:cpp?`$${cpp}`:"net", ctr:ins?.ctr?`${parseFloat(ins.ctr).toFixed(2)}%`:"0%", frequency:ins?.frequency?parseFloat(ins.frequency).toFixed(2):null, flag };
      });
      return { content: [{ type:"text", text:JSON.stringify({ vsego:adsets.length, adsets }, null, 2) }] };
    }
  );

  // GET ADS
  s.tool("get_ads", "Spisok obyavleniy so statusom i metrikami",
    { campaign_id:z.string().optional(), adset_id:z.string().optional(), days:z.number().default(7), date_preset:z.enum(["today","yesterday","custom"]).default("custom"), status:z.enum(["ACTIVE","PAUSED","ALL"]).default("ALL"), account:ACCT_PARAM },
    async ({ campaign_id, adset_id, days, date_preset, status, account }) => {
      const accId = resolveAcct(account);
      const range = rangeByPreset(date_preset, days);
      const params = { fields:`name,status,campaign{name},adset{name},creative{title,body,image_url},insights{${INSIGHTS_FIELDS}}`, limit:100, ...withAttribution(range) };
      if (status !== "ALL") params.filtering = JSON.stringify([{ field:"effective_status", operator:"IN", value:[status] }]);
      const url = adset_id ? `/${adset_id}/ads` : campaign_id ? `/${campaign_id}/ads` : `/act_${accId}/ads`;
      const data = await metaGet(url, params);
      const ads = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend||0), ctr = parseFloat(ins?.ctr||0), freq = parseFloat(ins?.frequency||0);
        return { id:a.id, name:a.name, status:a.status, campaign_name:a.campaign?.name, adset_name:a.adset?.name, creative_title:a.creative?.title, creative_body:a.creative?.body?.substring(0,100), spend:`$${spend.toFixed(2)}`, purchases, cpp:cpp?`$${cpp}`:"net", ctr:`${ctr.toFixed(2)}%`, frequency:freq.toFixed(2), flag:adFlag(spend,purchases,ctr,freq) };
      });
      return { content: [{ type:"text", text:JSON.stringify({ vsego:ads.length, ads }, null, 2) }] };
    }
  );

  // GET ADS TODAY
  s.tool("get_ads_today", "Obyavleniya s metrikami strogo za segodnya",
    { status:z.enum(["ACTIVE","PAUSED","ALL"]).default("ACTIVE"), account:ACCT_PARAM },
    async ({ status, account }) => {
      const accId = resolveAcct(account);
      const params = { fields:`name,status,campaign{name},adset{name},creative{title,body},insights{${INSIGHTS_FIELDS}}`, limit:100, ...withAttribution(todayRange()) };
      if (status !== "ALL") params.filtering = JSON.stringify([{ field:"effective_status", operator:"IN", value:[status] }]);
      const data = await metaGet(`/act_${accId}/ads`, params);
      const ads = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend||0), ctr = parseFloat(ins?.ctr||0), freq = parseFloat(ins?.frequency||0);
        return { id:a.id, name:a.name, status:a.status, campaign_name:a.campaign?.name, adset_name:a.adset?.name, creative:a.creative?.body?.substring(0,100), spend:`$${spend.toFixed(2)}`, purchases, cpp:cpp?`$${cpp}`:"net", ctr:`${ctr.toFixed(2)}%`, frequency:freq.toFixed(2), flag:adFlag(spend,purchases,ctr,freq) };
      });
      return { content: [{ type:"text", text:JSON.stringify({ date:fmtDate(new Date()), account_key:account||"primary", vsego:ads.length, ads }, null, 2) }] };
    }
  );

  // GET CAMPAIGN STATS
  s.tool("get_campaign_stats", "Detalnaya statistika po odnoy kampanii za lyuboy period",
    { campaign_id:z.string(), days:z.number().default(7), date_preset:z.enum(["today","yesterday","custom"]).default("custom") },
    async ({ campaign_id, days, date_preset }) => {
      const range = rangeByPreset(date_preset, days);
      const [campaign, adsets, ads] = await Promise.all([
        metaGet(`/${campaign_id}`, { fields:`name,status,daily_budget,objective,insights{${INSIGHTS_FIELDS}}`, ...withAttribution(range) }),
        metaGet(`/${campaign_id}/adsets`, { fields:`name,status,daily_budget,insights{${INSIGHTS_FIELDS}}`, ...withAttribution(range), limit:50 }),
        metaGet(`/${campaign_id}/ads`, { fields:`name,status,insights{${INSIGHTS_FIELDS}}`, ...withAttribution(range), limit:100 }),
      ]);
      const ins = campaign.insights?.data?.[0];
      const { purchases, cpp, revenue, roas } = parsePurchases(ins);
      return { content: [{ type:"text", text:JSON.stringify({
        campaign:campaign.name, status:campaign.status, period:date_preset!=="custom"?date_preset:`${days}d`,
        itogo:{ spend:`$${parseFloat(ins?.spend||0).toFixed(2)}`, purchases, cpp:cpp?`$${cpp}`:"net", roas:roas?`${roas}x`:null, revenue:`$${revenue}` },
        adsets:(adsets.data||[]).map((a)=>{ const ai=a.insights?.data?.[0]; const ap=parsePurchases(ai); return { id:a.id, name:a.name, status:a.status, budget:a.daily_budget?`$${(a.daily_budget/100).toFixed(2)}`:null, spend:`$${parseFloat(ai?.spend||0).toFixed(2)}`, purchases:ap.purchases, cpp:ap.cpp?`$${ap.cpp}`:"net", ctr:ai?.ctr?`${parseFloat(ai.ctr).toFixed(2)}%`:"0%" }; }),
        ads:(ads.data||[]).map((a)=>{ const ai=a.insights?.data?.[0]; const ap=parsePurchases(ai); const spend=parseFloat(ai?.spend||0); return { id:a.id, name:a.name, status:a.status, spend:`$${spend.toFixed(2)}`, purchases:ap.purchases, cpp:ap.cpp?`$${ap.cpp}`:"net", flag:adFlag(spend,ap.purchases,parseFloat(ai?.ctr||0),parseFloat(ai?.frequency||0)) }; }),
      }, null, 2) }] };
    }
  );

  // GET HOURLY STATS
  s.tool("get_hourly_stats", "Razбivka rashoda i pokupok po chasam za segodnya ili vchera",
    { day:z.enum(["today","yesterday"]).default("today"), campaign_id:z.string().optional(), account:ACCT_PARAM },
    async ({ day, campaign_id, account }) => {
      const accId = resolveAcct(account);
      const range = day === "today" ? todayRange() : yesterdayRange();
      const url = campaign_id ? `/${campaign_id}/insights` : `/act_${accId}/insights`;
      const data = await metaGet(url, { fields:"spend,actions,impressions,clicks", time_increment:"1", breakdowns:"hourly_stats_aggregated_by_advertiser_time_zone", ...range });
      const hours = (data.data||[]).map((h) => ({ hour:h.hourly_stats_aggregated_by_advertiser_time_zone, spend:`$${parseFloat(h.spend||0).toFixed(2)}`, purchases:parseInt(h.actions?.find((a)=>a.action_type==="purchase")?.value||0), clicks:h.clicks||0 })).sort((a,b)=>(a.hour||"").localeCompare(b.hour||""));
      return { content: [{ type:"text", text:JSON.stringify({ day, campaign_id:campaign_id||"all", hours }, null, 2) }] };
    }
  );

  // GET AUDIENCE INSIGHTS
  s.tool("get_audience_insights", "Kto realno pokupaet: vozrast, pol, region",
    { days:z.number().default(14), breakdown:z.enum(["age","gender","region","age,gender"]).default("age,gender"), account:ACCT_PARAM },
    async ({ days, breakdown, account }) => {
      const accId = resolveAcct(account);
      const data = await metaGet(`/act_${accId}/insights`, { fields:`spend,impressions,clicks,ctr,actions,cost_per_action_type`, breakdowns:breakdown, ...withAttribution(dateRange(days)), limit:100 });
      const rows = (data.data||[]).map((r) => {
        const purchases = parseInt(r.actions?.find((a)=>a.action_type==="purchase")?.value||0);
        const spend = parseFloat(r.spend||0);
        return { ...(r.age&&{age:r.age}), ...(r.gender&&{gender:r.gender}), ...(r.region&&{region:r.region}), spend:`$${spend.toFixed(2)}`, purchases, cpp:purchases>0?`$${(spend/purchases).toFixed(2)}`:"net", ctr:r.ctr?`${parseFloat(r.ctr).toFixed(2)}%`:"0%" };
      }).sort((a,b)=>(b.purchases||0)-(a.purchases||0));
      return { content: [{ type:"text", text:JSON.stringify({ breakdown, days, audience:rows }, null, 2) }] };
    }
  );

  // GET PLACEMENTS BREAKDOWN
  s.tool("get_placements_breakdown", "Razbivka po pleysmentam: Feed / Reels / Stories",
    { days:z.number().default(7), campaign_id:z.string().optional(), account:ACCT_PARAM },
    async ({ days, campaign_id, account }) => {
      const accId = resolveAcct(account);
      const url = campaign_id ? `/${campaign_id}/insights` : `/act_${accId}/insights`;
      const data = await metaGet(url, { fields:`spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type`, breakdowns:"publisher_platform,platform_position", ...withAttribution(dateRange(days)), limit:100 });
      const rows = (data.data||[]).map((r) => { const purchases=parseInt(r.actions?.find((a)=>a.action_type==="purchase")?.value||0); const spend=parseFloat(r.spend||0); return { platform:r.publisher_platform, position:r.platform_position, spend:`$${spend.toFixed(2)}`, purchases, cpp:purchases>0?`$${(spend/purchases).toFixed(2)}`:"net", ctr:r.ctr?`${parseFloat(r.ctr).toFixed(2)}%`:"0%" }; }).sort((a,b)=>parseFloat(b.spend.replace("$",""))-parseFloat(a.spend.replace("$","")));
      return { content: [{ type:"text", text:JSON.stringify({ days, placements:rows }, null, 2) }] };
    }
  );

  // GET FREQUENCY ALERT
  s.tool("get_frequency_alert", "Flag adsetov gde chastota prevyshaet porog",
    { threshold:z.number().default(2.5), days:z.number().default(7), account:ACCT_PARAM },
    async ({ threshold, days, account }) => {
      const accId = resolveAcct(account);
      const data = await metaGet(`/act_${accId}/adsets`, { fields:`name,status,insights{frequency,spend,reach}`, ...withAttribution(dateRange(days)), limit:100, filtering:JSON.stringify([{field:"effective_status",operator:"IN",value:["ACTIVE"]}]) });
      const alerts = (data.data||[]).map((a)=>{ const ins=a.insights?.data?.[0]; return { id:a.id, name:a.name, frequency:parseFloat(ins?.frequency||0), reach:ins?.reach||0, spend:`$${parseFloat(ins?.spend||0).toFixed(2)}` }; }).filter((a)=>a.frequency>=threshold).sort((a,b)=>b.frequency-a.frequency);
      return { content: [{ type:"text", text:JSON.stringify({ threshold, days, count:alerts.length, adsets:alerts }, null, 2) }] };
    }
  );

  // GET BUDGET PACING
  s.tool("get_budget_pacing", "Skolko byudzheta potracheno ot dnevnogo v % s uchetom vremeni sutok",
    { account:ACCT_PARAM },
    async ({ account }) => {
      const accId = resolveAcct(account);
      const [campaignsData, adsetsData] = await Promise.all([
        metaGet(`/act_${accId}/campaigns`, { fields:`name,status,daily_budget,insights{spend}`, ...withAttribution(todayRange()), limit:100, filtering:JSON.stringify([{field:"effective_status",operator:"IN",value:["ACTIVE"]}]) }),
        metaGet(`/act_${accId}/adsets`, { fields:`name,status,daily_budget,campaign{name},insights{spend}`, ...withAttribution(todayRange()), limit:100, filtering:JSON.stringify([{field:"effective_status",operator:"IN",value:["ACTIVE"]}]) }),
      ]);
      const now = new Date();
      const dayPct = ((now.getHours()*60+now.getMinutes())/1440*100).toFixed(1);
      const calcPace = (budget_cents, ins) => {
        if (!budget_cents) return null;
        const budget = parseFloat(budget_cents)/100;
        const spent = parseFloat(ins?.data?.[0]?.spend||0);
        const spentPct = (spent/budget*100).toFixed(1);
        const diff = parseFloat(spentPct)-parseFloat(dayPct);
        return { budget:`$${budget.toFixed(2)}`, spent:`$${spent.toFixed(2)}`, spent_pct:`${spentPct}%`, pace:diff<-20?"MEDLENNO":diff>20?"BYSTRO":"NORMA" };
      };
      const campaigns = (campaignsData.data||[]).map((c)=>({ name:c.name, ...calcPace(c.daily_budget,c.insights) })).filter((c)=>c.budget);
      const adsets = (adsetsData.data||[]).map((a)=>({ name:a.name, campaign:a.campaign?.name, ...calcPace(a.daily_budget,a.insights) })).filter((a)=>a.budget);
      return { content: [{ type:"text", text:JSON.stringify({ time:now.toTimeString().slice(0,5), day_passed:`${dayPct}%`, campaigns, adsets }, null, 2) }] };
    }
  );

  // GET ALERTS
  s.tool("get_alerts", "Svodka anomaliy: rost CPP, padenie CTR, nulevye pokupki, vysokaya chastota",
    { max_cpp:z.number().default(6), min_ctr:z.number().default(0.5), max_frequency:z.number().default(3.0), spend_no_conv:z.number().default(4), account:ACCT_PARAM },
    async ({ max_cpp, min_ctr, max_frequency, spend_no_conv, account }) => {
      const accId = resolveAcct(account);
      const [adsetsData, adsData] = await Promise.all([
        metaGet(`/act_${accId}/adsets`, { fields:`name,status,insights{spend,ctr,frequency,actions}`, ...withAttribution(todayRange()), limit:100, filtering:JSON.stringify([{field:"effective_status",operator:"IN",value:["ACTIVE"]}]) }),
        metaGet(`/act_${accId}/ads`, { fields:`name,status,campaign{name},insights{spend,ctr,actions}`, ...withAttribution(todayRange()), limit:100, filtering:JSON.stringify([{field:"effective_status",operator:"IN",value:["ACTIVE"]}]) }),
      ]);
      const alerts = [];
      for (const a of adsetsData.data||[]) {
        const ins = a.insights?.data?.[0];
        const spend=parseFloat(ins?.spend||0), ctr=parseFloat(ins?.ctr||0), freq=parseFloat(ins?.frequency||0);
        const purchases=parseInt(ins?.actions?.find((x)=>x.action_type==="purchase")?.value||0);
        const cpp = purchases>0 ? spend/purchases : null;
        if (spend>=spend_no_conv&&purchases===0) alerts.push({ type:"NET_KONVERSIY",object:"adset",name:a.name,details:`$${spend.toFixed(2)} bez pokupok` });
        if (cpp&&cpp>max_cpp) alerts.push({ type:"VYSOKIY_CPP",object:"adset",name:a.name,details:`CPP $${cpp.toFixed(2)} > $${max_cpp}` });
        if (spend>2&&ctr<min_ctr) alerts.push({ type:"NIZKIY_CTR",object:"adset",name:a.name,details:`CTR ${ctr.toFixed(2)}% < ${min_ctr}%` });
        if (freq>max_frequency) alerts.push({ type:"VYSOKAYA_CHASTOTA",object:"adset",name:a.name,details:`freq ${freq.toFixed(2)} > ${max_frequency}` });
      }
      for (const a of adsData.data||[]) {
        const ins=a.insights?.data?.[0];
        const spend=parseFloat(ins?.spend||0), purchases=parseInt(ins?.actions?.find((x)=>x.action_type==="purchase")?.value||0);
        if (spend>=spend_no_conv&&purchases===0) alerts.push({ type:"NET_KONVERSIY",object:"ad",name:a.name,campaign:a.campaign?.name,details:`$${spend.toFixed(2)} bez pokupok` });
      }
      return { content: [{ type:"text", text:JSON.stringify({ time:new Date().toTimeString().slice(0,5), total:alerts.length, alerts }, null, 2) }] };
    }
  );

  // GET DAILY SUMMARY
  s.tool("get_daily_summary", "Itog dnya: rashod / pokupki / ROAS / luchshiy kreo / chto vyklyuchit",
    { account:ACCT_PARAM },
    async ({ account }) => {
      const accId = resolveAcct(account);
      const [accToday, accYest, campaignsToday, adsToday] = await Promise.all([
        metaGet(`/act_${accId}/insights`, { fields:INSIGHTS_FIELDS, level:"account", ...withAttribution(todayRange()) }),
        metaGet(`/act_${accId}/insights`, { fields:INSIGHTS_FIELDS, level:"account", ...withAttribution(yesterdayRange()) }),
        metaGet(`/act_${accId}/campaigns`, { fields:`name,status,insights{${INSIGHTS_FIELDS}}`, ...withAttribution(todayRange()), limit:50, filtering:JSON.stringify([{field:"effective_status",operator:"IN",value:["ACTIVE"]}]) }),
        metaGet(`/act_${accId}/ads`, { fields:`name,status,campaign{name},creative{body},insights{${INSIGHTS_FIELDS}}`, ...withAttribution(todayRange()), limit:100 }),
      ]);
      const today=parsePurchases(accToday.data?.[0]), yest=parsePurchases(accYest.data?.[0]);
      const tIns=accToday.data?.[0]||{}, yIns=accYest.data?.[0]||{};
      const campaigns=(campaignsToday.data||[]).map((c)=>{ const ins=c.insights?.data?.[0]; const {purchases,cpp,roas}=parsePurchases(ins); return { name:c.name, spend:`$${parseFloat(ins?.spend||0).toFixed(2)}`, purchases, cpp:cpp?`$${cpp}`:"net", roas:roas?`${roas}x`:null }; });
      const ads=(adsToday.data||[]).map((a)=>{ const ins=a.insights?.data?.[0]; const {purchases,cpp}=parsePurchases(ins); const spend=parseFloat(ins?.spend||0); return { name:a.name, campaign:a.campaign?.name, spend, purchases, cpp:cpp?parseFloat(cpp):null }; });
      const winner=ads.filter((a)=>a.purchases>0).sort((a,b)=>(a.cpp||99)-(b.cpp||99))[0];
      const toKill=ads.filter((a)=>a.spend>=4&&a.purchases===0);
      const spendT=parseFloat(tIns.spend||0), spendY=parseFloat(yIns.spend||0);
      return { content: [{ type:"text", text:JSON.stringify({
        date:fmtDate(new Date()), account_key:account||"primary",
        segodnya:{ spend:`$${spendT.toFixed(2)}`, purchases:today.purchases, cpp:today.cpp?`$${today.cpp}`:"net", roas:today.roas?`${today.roas}x`:null, ctr:tIns.ctr?`${parseFloat(tIns.ctr).toFixed(2)}%`:"0%" },
        vs_vchera:{ purchases:`${today.purchases-yest.purchases>=0?"+":""}${today.purchases-yest.purchases}`, spend:`${spendT-spendY>=0?"+":""}$${(spendT-spendY).toFixed(2)}` },
        po_kampaniyam:campaigns,
        luchshiy_kreo:winner?{ name:winner.name, campaign:winner.campaign, purchases:winner.purchases, cpp:`$${winner.cpp.toFixed(2)}` }:"net konversiy segodnya",
        vyklyuchit:toKill.map((a)=>({ name:a.name, campaign:a.campaign, spend:`$${a.spend.toFixed(2)}`, reason:"$4+ bez pokupok" })),
        itog:toKill.length>0?`${toKill.length} obyavleniy nuzhno vyklyuchit`:"Vse v poryadke",
      }, null, 2) }] };
    }
  );

  // GET CREATIVE FATIGUE
  s.tool("get_creative_fatigue", "Detektor vygoraniya kreo: sravnenie CTR segodnya vs 7 dney",
    { min_spend_usd:z.number().default(2), ctr_drop_threshold:z.number().default(30).describe("% padeniya CTR dlya flaga VYGORAET"), account:ACCT_PARAM },
    async ({ min_spend_usd, ctr_drop_threshold, account }) => {
      const accId = resolveAcct(account);
      const [todayData, weekData] = await Promise.all([
        metaGet(`/act_${accId}/ads`, { fields:`name,status,campaign{name},insights{spend,ctr,frequency,impressions}`, ...withAttribution(todayRange()), limit:100, filtering:JSON.stringify([{field:"effective_status",operator:"IN",value:["ACTIVE"]}]) }),
        metaGet(`/act_${accId}/ads`, { fields:`name,status,insights{spend,ctr,impressions}`, ...withAttribution(dateRange(7)), limit:100 }),
      ]);
      const weekMap = {};
      for (const a of weekData.data||[]) { const ins=a.insights?.data?.[0]; if (ins) weekMap[a.id]={ ctr:parseFloat(ins.ctr||0) }; }
      const result = (todayData.data||[]).map((a) => {
        const ins=a.insights?.data?.[0]; const spend=parseFloat(ins?.spend||0); const ctrToday=parseFloat(ins?.ctr||0);
        const week=weekMap[a.id]||{ ctr:0 };
        const drop=week.ctr>0?((week.ctr-ctrToday)/week.ctr*100):0;
        const fatigue=drop>=ctr_drop_threshold&&spend>=min_spend_usd;
        return { id:a.id, name:a.name, campaign:a.campaign?.name, ctr_today:`${ctrToday.toFixed(2)}%`, ctr_7d_avg:`${week.ctr.toFixed(2)}%`, drop_pct:`${drop.toFixed(1)}%`, frequency:parseFloat(ins?.frequency||0).toFixed(2), spend_today:`$${spend.toFixed(2)}`, status:fatigue?"VYGORAET":drop>15?"NABLYUDAT":"OK", _spend:spend, _drop:drop };
      }).filter((a)=>a._spend>=min_spend_usd).sort((a,b)=>b._drop-a._drop);
      const burning=result.filter((a)=>a.status==="VYGORAET");
      return { content: [{ type:"text", text:JSON.stringify({ total_analyzed:result.length, vygorayut:burning.length, ads:result.map(({_spend,_drop,...rest})=>rest) }, null, 2) }] };
    }
  );

  // TOGGLE STATUS
  s.tool("toggle_status", "Vklyuchit / vyklyuchit kampaniyu, adset ili obyavlenie",
    { entity_type:z.enum(["campaign","adset","ad"]), entity_id:z.string(), status:z.enum(["ACTIVE","PAUSED"]) },
    async ({ entity_type, entity_id, status }) => {
      await metaPost(`/${entity_id}`, { status });
      return { content: [{ type:"text", text:`OK: ${entity_type} ${entity_id} -> ${status}` }] };
    }
  );

  // SCALE BUDGET
  s.tool("scale_budget", "Izmenit dnevnoy ili lifetime byudzhet",
    { entity_type:z.enum(["campaign","adset"]), entity_id:z.string(), budget:z.number().min(100).describe("Byudzhet v kopeykakh (500=$5)"), is_lifetime:z.boolean().default(false) },
    async ({ entity_type, entity_id, budget, is_lifetime }) => {
      const body = is_lifetime ? { lifetime_budget:budget } : { daily_budget:budget };
      await metaPost(`/${entity_id}`, body);
      return { content: [{ type:"text", text:`OK: ${entity_type} ${entity_id} budget -> $${(budget/100).toFixed(2)} (${is_lifetime?"lifetime":"daily"})` }] };
    }
  );

  // SET BID CAP
  s.tool("set_bid_cap", "Postavit ogranichenie stavki na adset",
    { adset_id:z.string(), bid_cap_usd:z.number() },
    async ({ adset_id, bid_cap_usd }) => {
      await metaPost(`/${adset_id}`, { bid_amount:Math.round(bid_cap_usd*100), bid_strategy:"LOWEST_COST_WITH_BID_CAP" });
      return { content: [{ type:"text", text:`OK: bid cap ${adset_id} = $${bid_cap_usd}` }] };
    }
  );

  // SCHEDULED ACTION
  s.tool("scheduled_action", "Zaplanirovat vklyuchenie/vyklyuchenie v opredelennoe vremya (UTC). 9:00 Kiyev = 06:00 UTC letom",
    { entity_type:z.enum(["campaign","adset","ad"]), entity_id:z.string(), status:z.enum(["ACTIVE","PAUSED"]), time_utc:z.string().describe("HH:MM po UTC, napr 06:00") },
    async ({ entity_type, entity_id, status, time_utc }) => {
      const [hh, mm] = time_utc.split(":").map(Number);
      const now = new Date();
      const target = new Date();
      target.setUTCHours(hh, mm, 0, 0);
      if (target <= now) target.setUTCDate(target.getUTCDate()+1);
      const delay = target - now;
      const key = `${entity_id}_${status}`;
      if (scheduledTimers.has(key)) clearTimeout(scheduledTimers.get(key));
      const timer = setTimeout(async () => {
        try { await metaPost(`/${entity_id}`, { status }); scheduledTimers.delete(key); console.log(`[scheduled] ${entity_type} ${entity_id} -> ${status}`); }
        catch (e) { console.error(`[scheduled] error: ${e.message}`); }
      }, delay);
      scheduledTimers.set(key, timer);
      return { content: [{ type:"text", text:JSON.stringify({ success:true, entity_type, entity_id, status, scheduled_utc:target.toUTCString(), in_minutes:Math.round(delay/60000), note:"Odnorazovo. Sbros pri perezapuske servera." }, null, 2) }] };
    }
  );

  // CREATE CAMPAIGN
  s.tool("create_campaign", "Sozdat kampaniyu s nulya",
    { name:z.string(), objective:z.enum(["OUTCOME_SALES","OUTCOME_LEADS","OUTCOME_TRAFFIC","OUTCOME_AWARENESS","OUTCOME_ENGAGEMENT"]).default("OUTCOME_SALES"), daily_budget_usd:z.number().optional(), status:z.enum(["ACTIVE","PAUSED"]).default("PAUSED"), account:ACCT_PARAM },
    async ({ name, objective, daily_budget_usd, status, account }) => {
      const accId = resolveAcct(account);
      const body = { name, objective, status, special_ad_categories:[] };
      if (daily_budget_usd) body.daily_budget = Math.round(daily_budget_usd*100);
      const d = await metaPost(`/act_${accId}/campaigns`, body);
      return { content: [{ type:"text", text:JSON.stringify({ success:true, campaign_id:d.id, name, objective, status, account_key:account||"primary" }, null, 2) }] };
    }
  );

  // CREATE ADSET
  s.tool("create_adset", "Sozdat novyy adset s polnymi nastroyki targetinga",
    {
      name:z.string(), campaign_id:z.string(), daily_budget_usd:z.number(),
      optimization_goal:z.enum(["OFFSITE_CONVERSIONS","LINK_CLICKS","REACH","IMPRESSIONS"]).default("OFFSITE_CONVERSIONS"),
      pixel_id:z.string().optional(),
      countries:z.array(z.string()).default(["UA"]),
      excluded_countries:z.array(z.string()).default([]),
      languages:z.array(z.number()).default([]).describe("32=ukr, 8=rus, 6=eng"),
      age_min:z.number().default(18), age_max:z.number().default(65),
      genders:z.array(z.number()).default([]).describe("1=male, 2=female, []=all"),
      status:z.enum(["ACTIVE","PAUSED"]).default("PAUSED"),
      start_time:z.string().optional().describe("ISO datetime: 2025-01-15T11:00:00+0200"),
      account:ACCT_PARAM,
    },
    async ({ name, campaign_id, daily_budget_usd, optimization_goal, pixel_id, countries, excluded_countries, languages, age_min, age_max, genders, status, start_time, account }) => {
      const accId = resolveAcct(account);
      const pid = pixel_id || resolvePix(account);
      const geo_locations = countries.includes("WORLDWIDE") ? { location_types:["home","recent"] } : { countries };
      if (excluded_countries.length) geo_locations.excluded_countries = excluded_countries;
      const targeting = { age_min, age_max, geo_locations };
      if (languages.length) targeting.locales = languages;
      if (genders.length) targeting.genders = genders;
      const body = { name, campaign_id, status, daily_budget:Math.round(daily_budget_usd*100), optimization_goal, billing_event:"IMPRESSIONS", targeting, ...promotedObject(pid), ...(start_time&&{start_time}) };
      console.log("[create_adset] Request:", JSON.stringify({ account: accId, pixel: pid, ...body }));
      let d;
      try {
        d = await metaPost(`/act_${accId}/adsets`, body);
      } catch(e) {
        console.error("[create_adset] FAILED. Body sent:", JSON.stringify(body));
        throw e;
      }
      return { content: [{ type:"text", text:JSON.stringify({ success:true, adset_id:d.id, name, campaign_id, budget:`$${daily_budget_usd}`, countries, status }, null, 2) }] };
    }
  );

  // DUPLICATE ADSET
  s.tool("duplicate_adset", "Dublirovat adset dlya masshtabirovaniya ili smeny geo",
    { adset_id:z.string(), new_name:z.string().optional(), new_budget_usd:z.number().optional(), new_countries:z.array(z.string()).optional(), new_languages:z.array(z.number()).optional(), pixel_id:z.string().optional().describe("Pereopredelet piksel. Esli ne ukazat — budet skopirovan iz originala"), status_after:z.enum(["ACTIVE","PAUSED"]).default("PAUSED"), account:ACCT_PARAM },
    async ({ adset_id, new_name, new_budget_usd, new_countries, new_languages, pixel_id, status_after, account }) => {
      const copyBody = { deep_copy:true, status_option:status_after };
      if (new_budget_usd) copyBody.daily_budget = Math.round(new_budget_usd*100);
      const d = await metaPost(`/${adset_id}/copies`, copyBody);
      const newId = d.copied_adset_id;
      if (newId && (new_countries||new_languages||new_name||pixel_id)) {
        const current = await metaGet(`/${newId}`, { fields:"targeting,name" });
        const updates = {};
        if (new_name) updates.name = new_name;
        if (new_countries||new_languages) {
          const targeting = { ...current.targeting };
          if (new_countries) targeting.geo_locations = new_countries.includes("WORLDWIDE") ? { location_types:["home","recent"] } : { countries:new_countries };
          if (new_languages!==undefined) targeting.locales = new_languages.length ? new_languages : undefined;
          updates.targeting = targeting;
        }
        const pid = pixel_id || resolvePix(account);
        if (pid) Object.assign(updates, promotedObject(pid));
        await metaPost(`/${newId}`, updates);
      }
      return { content: [{ type:"text", text:JSON.stringify({ success:true, new_adset_id:newId, status:status_after }, null, 2) }] };
    }
  );

  // UPDATE TARGETING
  s.tool("update_targeting", "Menyat geo, vozrast, pol, yazyki adseta na letu",
    { adset_id:z.string(), countries:z.array(z.string()).optional(), excluded_countries:z.array(z.string()).optional(), age_min:z.number().optional(), age_max:z.number().optional(), genders:z.array(z.number()).optional(), languages:z.array(z.number()).optional() },
    async ({ adset_id, countries, excluded_countries, age_min, age_max, genders, languages }) => {
      const current = await metaGet(`/${adset_id}`, { fields:"targeting" });
      const targeting = { ...current.targeting };
      if (countries) { targeting.geo_locations = countries.includes("WORLDWIDE") ? { location_types:["home","recent"] } : { countries }; if (excluded_countries?.length) targeting.geo_locations.excluded_countries = excluded_countries; }
      if (age_min!==undefined) targeting.age_min = age_min;
      if (age_max!==undefined) targeting.age_max = age_max;
      if (genders!==undefined) targeting.genders = genders.length ? genders : undefined;
      if (languages!==undefined) targeting.locales = languages.length ? languages : undefined;
      await metaPost(`/${adset_id}`, { targeting });
      return { content: [{ type:"text", text:JSON.stringify({ success:true, adset_id, updated:{ countries, excluded_countries, age_min, age_max, genders, languages } }, null, 2) }] };
    }
  );

  // UPLOAD IMAGE
  s.tool("upload_image", "Zagruzit izobrazhenie po URL v biblioteku reklamnogo akkaunta",
    { image_url:z.string(), name:z.string().optional(), account:ACCT_PARAM },
    async ({ image_url, name, account }) => {
      const accId = resolveAcct(account);
      const body = { url:image_url };
      if (name) body.name = name;
      const d = await metaPost(`/act_${accId}/adimages`, body);
      const imgData = d.images?.[Object.keys(d.images||{})[0]];
      return { content: [{ type:"text", text:JSON.stringify({ success:true, hash:imgData?.hash, url:imgData?.url }, null, 2) }] };
    }
  );

  // UPLOAD VIDEO
  s.tool("upload_video", "Zagruzit video po publichnomu URL v biblioteku reklamnogo akkaunta",
    { video_url:z.string().describe("Publichnyy URL mp4 fayly"), title:z.string().optional(), account:ACCT_PARAM },
    async ({ video_url, title, account }) => {
      const accId = resolveAcct(account);
      const body = { file_url:video_url };
      if (title) body.title = title;
      const d = await metaPost(`/act_${accId}/advideos`, body);
      return { content: [{ type:"text", text:JSON.stringify({ success:true, video_id:d.id, title:title||"bez nazvaniya" }, null, 2) }] };
    }
  );

  // CREATE AD
  s.tool("create_ad", "Sozdat obyavlenie s novym kreo, tekstom i zagolovkom",
    { name:z.string(), adset_id:z.string(), page_id:z.string().optional(), primary_text:z.string(), headline:z.string().optional(), description:z.string().optional(), link_url:z.string(), image_hash:z.string().optional(), video_id:z.string().optional(), call_to_action:z.enum(["LEARN_MORE","SHOP_NOW","SIGN_UP","GET_OFFER","BUY_NOW","SUBSCRIBE"]).default("LEARN_MORE"), status:z.enum(["ACTIVE","PAUSED"]).default("PAUSED"), account:ACCT_PARAM },
    async ({ name, adset_id, page_id, primary_text, headline, description, link_url, image_hash, video_id, call_to_action, status, account }) => {
      const accId = resolveAcct(account);
      const pid = page_id || resolvePg(account);
      const link_data = { message:primary_text, link:link_url, call_to_action:{ type:call_to_action, value:{ link:link_url } }, ...(headline&&{name:headline}), ...(description&&{description}), ...(image_hash&&{image_hash}), ...(video_id&&{video_id}) };
      const creative = await metaPost(`/act_${accId}/adcreatives`, { name:`creative_${name}_${Date.now()}`, object_story_spec:{ page_id:pid, link_data } });
      const ad = await metaPost(`/act_${accId}/ads`, { name, adset_id, creative:{ creative_id:creative.id }, status });
      return { content: [{ type:"text", text:JSON.stringify({ success:true, ad_id:ad.id, creative_id:creative.id, name, status }, null, 2) }] };
    }
  );

  // DUPLICATE AD
  s.tool("duplicate_ad", "Dublirovat obyavlenie dlya testov",
    { ad_id:z.string(), adset_id:z.string().optional(), status_after:z.enum(["ACTIVE","PAUSED"]).default("PAUSED") },
    async ({ ad_id, adset_id, status_after }) => {
      const body = { deep_copy:true, status_option:status_after };
      if (adset_id) body.adset_id = adset_id;
      const d = await metaPost(`/${ad_id}/copies`, body);
      return { content: [{ type:"text", text:JSON.stringify({ success:true, new_ad_id:d.copied_ad_id, status:status_after }, null, 2) }] };
    }
  );

  // GET AB TEST RESULTS
  s.tool("get_ab_test_results", "Sravnenie dvukh kreo ili adsetov po klyuchevym metrikam",
    { id_a:z.string(), id_b:z.string(), type:z.enum(["ad","adset"]).default("ad"), days:z.number().default(7) },
    async ({ id_a, id_b, days }) => {
      const fields = `name,status,insights{${INSIGHTS_FIELDS}}`;
      const params = withAttribution(dateRange(days));
      const [objA, objB] = await Promise.all([metaGet(`/${id_a}`, { fields, ...params }), metaGet(`/${id_b}`, { fields, ...params })]);
      const parse = (obj) => { const ins=obj.insights?.data?.[0]; const {purchases,cpp,roas}=parsePurchases(ins); const spend=parseFloat(ins?.spend||0); return { name:obj.name, spend:`$${spend.toFixed(2)}`, purchases, cpp:cpp?`$${cpp}`:"net", roas:roas?`${roas}x`:null, ctr:ins?.ctr?`${parseFloat(ins.ctr).toFixed(2)}%`:"0%", _cpp:cpp?parseFloat(cpp):null, _purchases:purchases }; };
      const pA=parse(objA), pB=parse(objB);
      const winner = pA._cpp&&pB._cpp ? (pA._cpp<pB._cpp?"A":"B") : pA._purchases>pB._purchases?"A":pB._purchases>pA._purchases?"B":"net dannyh";
      return { content: [{ type:"text", text:JSON.stringify({ days, A:pA, B:pB, winner, recommendation:winner!=="net dannyh"?`Masshtabirovat ${winner}, vyklyuchit ${winner==="A"?"B":"A"} esli stabilno 3+ dnya`:"Nedostatochno dannyh" }, null, 2) }] };
    }
  );

  // GET WINNER RECOMMENDATION
  s.tool("get_winner_recommendation", "Avtovyvod pobeditelya sredi vsekh aktivnykh kreo",
    { days:z.number().default(7), min_spend_usd:z.number().default(3), account:ACCT_PARAM },
    async ({ days, min_spend_usd, account }) => {
      const accId = resolveAcct(account);
      const data = await metaGet(`/act_${accId}/ads`, { fields:`name,status,campaign{name},insights{${INSIGHTS_FIELDS}}`, ...withAttribution(dateRange(days)), limit:100, filtering:JSON.stringify([{field:"effective_status",operator:"IN",value:["ACTIVE"]}]) });
      const ads = (data.data||[]).map((a) => {
        const ins=a.insights?.data?.[0]; const spend=parseFloat(ins?.spend||0); const {purchases,cpp,roas}=parsePurchases(ins); const ctr=parseFloat(ins?.ctr||0); const freq=parseFloat(ins?.frequency||0);
        let action="malo dannyh";
        if (spend>=min_spend_usd) { if (purchases===0&&spend>=4) action="VYKLYUCHIT"; else if (cpp&&parseFloat(cpp)<=5&&purchases>=2) action="MASSHTABIROVAT"; else if (ctr<0.5&&spend>5) action="problema s CTR"; else if (freq>3) action="auditoriya vygoraet"; else if (purchases>0) action="nablyudat 1-2 dnya"; }
        return { name:a.name, campaign:a.campaign?.name, spend:`$${spend.toFixed(2)}`, purchases, cpp:cpp?`$${cpp}`:"net", roas:roas?`${roas}x`:null, ctr:`${ctr.toFixed(2)}%`, freq:freq.toFixed(2), action, _p:purchases, _cpp:cpp?parseFloat(cpp):99, _s:spend };
      }).filter((a)=>a._s>=min_spend_usd).sort((a,b)=>b._p-a._p||a._cpp-b._cpp);
      const winner = ads.find((a)=>a._p>=2&&a._cpp<=5);
      return { content: [{ type:"text", text:JSON.stringify({ days, min_spend:`$${min_spend_usd}`, winner:winner?{ name:winner.name, campaign:winner.campaign, cpp:winner.cpp, purchases:winner.purchases }:"ne opredelen", all_active_ads:ads }, null, 2) }] };
    }
  );

  // PAUSE ALL EMERGENCY
  s.tool("pause_all_emergency", "EKSTRENNAYA OSTANOVKA - postavit vse aktivnye kampanii na pauzu",
    { confirm:z.boolean(), account:ACCT_PARAM },
    async ({ confirm, account }) => {
      if (!confirm) return { content:[{ type:"text", text:"Ne vypolneno. Pereday confirm: true" }] };
      const accId = resolveAcct(account);
      const data = await metaGet(`/act_${accId}/campaigns`, { fields:"id,name", filtering:JSON.stringify([{field:"effective_status",operator:"IN",value:["ACTIVE"]}]), limit:100 });
      const results = [];
      for (const c of data.data||[]) { await metaPost(`/${c.id}`, { status:"PAUSED" }); results.push(c.name); }
      return { content: [{ type:"text", text:JSON.stringify({ status:"VSE_OSTANOVLENY", account_key:account||"primary", count:results.length, campaigns:results }, null, 2) }] };
    }
  );
}

// -- Express ----------------------------------------------------------------
const app = express();
const transports = new Map();

app.get("/", (req, res) => res.send("FB Ads MCP v4.0.0 — multi-account"));
app.get("/health", (req, res) => res.json({ status:"ok", version:"4.0.0", account:META_ACCOUNT_ID?"set":"missing", multiAccount:{ "1":!!process.env.ACCOUNT_ID_1, "2":!!process.env.ACCOUNT_ID_2, "3":!!process.env.ACCOUNT_ID_3 } }));

app.get("/sse", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  const mcpServer = new McpServer({ name:"fb-ads-mcp", version:"4.0.0" });
  registerTools(mcpServer);
  res.on("close", () => { transports.delete(transport.sessionId); mcpServer.close().catch(()=>{}); });
  await mcpServer.connect(transport);
  console.log(`Connected [${transport.sessionId}]`);
  const keepalive = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 25000);
  res.on("close", () => clearInterval(keepalive));
});

app.post("/messages", async (req, res) => {
  const transport = transports.get(req.query.sessionId);
  if (!transport) return res.status(404).json({ error:"Session not found" });
  try { await transport.handlePostMessage(req, res); }
  catch (e) { res.status(500).json({ error:e.message }); }
});

if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  import("./telegram.js").catch((e) => console.error("Telegram init error:", e.message));
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`FB Ads MCP v4.0.0 port ${PORT} account act_${META_ACCOUNT_ID}`);
});
