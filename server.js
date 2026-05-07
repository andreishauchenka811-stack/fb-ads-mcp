import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import fetch from "node-fetch";
import { z } from "zod";

const META_TOKEN = process.env.META_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const PORT = process.env.PORT || 10000;
const BASE = "https://graph.facebook.com/v19.0";

// ── Meta API helpers ───────────────────────────────────────────────────────────
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

// days=1 = только сегодня, days=7 = последние 7 дней включая сегодня
function dateRange(days) {
  const until = new Date();
  const since = new Date(until);
  since.setDate(until.getDate() - (days - 1));
  return { time_range: JSON.stringify({ since: fmtDate(since), until: fmtDate(until) }) };
}

// Явно сегодня
function todayRange() {
  const t = fmtDate(new Date());
  return { time_range: JSON.stringify({ since: t, until: t }) };
}

// Явно вчера
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
  "action_attribution_windows",
].join(",");

function parsePurchases(ins) {
  if (!ins) return { purchases: 0, cpp: null, revenue: "0", roas: null };
  const spend = parseFloat(ins.spend || 0);
  const purchases = parseInt(ins.actions?.find((a) => a.action_type === "purchase")?.value || 0);
  const revenue = parseFloat(ins.action_values?.find((a) => a.action_type === "purchase")?.value || 0);
  const cpp = purchases > 0 ? (spend / purchases).toFixed(2) : null;
  const roas = spend > 0 && revenue > 0 ? (revenue / spend).toFixed(2) : null;
  return { purchases, cpp, revenue: revenue.toFixed(2), roas };
}

// ── Регистрация всех тулов ─────────────────────────────────────────────────────
function registerTools(s) {

  s.tool("hello", "Проверка связи с сервером", {}, async () => ({
    content: [{ type: "text", text: "✅ FB Ads MCP v3.0.0 подключён!" }],
  }));

  s.tool(
    "get_account_overview",
    "Общая сводка по рекламному кабинету. date_preset: today, yesterday, last_7d, last_14d, last_30d",
    {
      days: z.number().min(1).max(90).default(14),
      date_preset: z.enum(["today", "yesterday", "last_7d", "last_14d", "last_30d", "custom"]).default("custom"),
    },
    async ({ days, date_preset }) => {
      const range = date_preset === "today" ? todayRange()
        : date_preset === "yesterday" ? yesterdayRange()
        : date_preset === "last_7d" ? dateRange(7)
        : date_preset === "last_14d" ? dateRange(14)
        : date_preset === "last_30d" ? dateRange(30)
        : dateRange(days);

      const label = date_preset !== "custom" ? date_preset : `${days} дней`;

      // Тянем сегодня и вчера параллельно для сравнения
      const [dataMain, dataToday, dataYest] = await Promise.all([
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...range }),
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...todayRange() }),
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...yesterdayRange() }),
      ]);

      const ins = dataMain.data?.[0] || {};
      const insToday = dataToday.data?.[0] || {};
      const insYest = dataYest.data?.[0] || {};
      const { purchases, cpp, revenue, roas } = parsePurchases(ins);
      const todayParsed = parsePurchases(insToday);
      const yesterdayParsed = parsePurchases(insYest);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            период: label,
            итого: {
              спенд: `$${parseFloat(ins.spend || 0).toFixed(2)}`,
              показы: ins.impressions || 0,
              клики: ins.clicks || 0,
              ctr: ins.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
              cpc: ins.cpc ? `$${parseFloat(ins.cpc).toFixed(2)}` : null,
              cpm: ins.cpm ? `$${parseFloat(ins.cpm).toFixed(2)}` : null,
              покупки: purchases,
              cpp: cpp ? `$${cpp}` : "нет конверсий",
              выручка: `$${revenue}`,
              roas: roas ? `${roas}x` : null,
            },
            сегодня: {
              спенд: `$${parseFloat(insToday.spend || 0).toFixed(2)}`,
              покупки: todayParsed.purchases,
              cpp: todayParsed.cpp ? `$${todayParsed.cpp}` : "нет конверсий",
              roas: todayParsed.roas ? `${todayParsed.roas}x` : null,
            },
            вчера: {
              спенд: `$${parseFloat(insYest.spend || 0).toFixed(2)}`,
              покупки: yesterdayParsed.purchases,
              cpp: yesterdayParsed.cpp ? `$${yesterdayParsed.cpp}` : "нет конверсий",
              roas: yesterdayParsed.roas ? `${yesterdayParsed.roas}x` : null,
            },
          }, null, 2),
        }],
      };
    }
  );

  s.tool(
    "get_campaigns",
    "Список кампаний с метриками",
    {
      days: z.number().min(1).max(90).default(14),
      status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL"),
      limit: z.number().min(10).max(200).default(50),
    },
    async ({ days, status, limit }) => {
      const params = {
        fields: `name,status,daily_budget,lifetime_budget,objective,insights{${INSIGHTS_FIELDS}}`,
        limit,
        ...dateRange(days),
      };
      if (status !== "ALL") {
        params.filtering = JSON.stringify([
          { field: "effective_status", operator: "IN", value: [status] },
        ]);
      }
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/campaigns`, params);
      const campaigns = (data.data || []).map((c) => {
        const ins = c.insights?.data?.[0];
        const { purchases, cpp, roas } = parsePurchases(ins);
        return {
          id: c.id,
          name: c.name,
          status: c.status,
          daily_budget: c.daily_budget ? `$${(c.daily_budget / 100).toFixed(2)}` : null,
          спенд: ins ? `$${parseFloat(ins.spend).toFixed(2)}` : "$0",
          покупки: purchases,
          cpp: cpp ? `$${cpp}` : "нет конверсий",
          roas: roas ? `${roas}x` : null,
          ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
          frequency: ins?.frequency ? parseFloat(ins.frequency).toFixed(2) : null,
        };
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ всего: campaigns.length, campaigns }, null, 2) }],
      };
    }
  );

  s.tool(
    "get_adsets",
    "Получить адсеты кампании или всего кабинета",
    {
      campaign_id: z.string().optional(),
      days: z.number().default(14),
      status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL"),
    },
    async ({ campaign_id, days, status }) => {
      const params = {
        fields: `name,status,daily_budget,campaign{name},insights{${INSIGHTS_FIELDS}}`,
        limit: 100,
        ...dateRange(days),
      };
      if (status !== "ALL") {
        params.filtering = JSON.stringify([
          { field: "effective_status", operator: "IN", value: [status] },
        ]);
      }
      const url = campaign_id ? `/${campaign_id}/adsets` : `/act_${META_ACCOUNT_ID}/adsets`;
      const data = await metaGet(url, params);
      const adsets = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        const flag = spend >= 4 && purchases === 0 ? "🔴 ВЫКЛЮЧИТЬ ($4+ без покупок)"
          : spend >= 2 && purchases === 0 ? "🟡 НАБЛЮДАТЬ"
          : "🟢 OK";
        return {
          id: a.id,
          name: a.name,
          status: a.status,
          campaign: a.campaign?.name,
          daily_budget: a.daily_budget ? `$${(a.daily_budget / 100).toFixed(2)}` : null,
          спенд: `$${spend.toFixed(2)}`,
          покупки: purchases,
          cpp: cpp ? `$${cpp}` : "нет конверсий",
          ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
          frequency: ins?.frequency ? parseFloat(ins.frequency).toFixed(2) : null,
          флаг: flag,
        };
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ всего: adsets.length, adsets }, null, 2) }],
      };
    }
  );

  s.tool(
    "get_ads",
    "Получить объявления с метриками для анализа креативов",
    {
      campaign_id: z.string().optional(),
      adset_id: z.string().optional(),
      days: z.number().default(7),
      status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL"),
    },
    async ({ campaign_id, adset_id, days, status }) => {
      const params = {
        fields: `name,status,creative{title,body,image_url,thumbnail_url},insights{${INSIGHTS_FIELDS}}`,
        limit: 100,
        ...dateRange(days),
      };
      if (status !== "ALL") {
        params.filtering = JSON.stringify([
          { field: "effective_status", operator: "IN", value: [status] },
        ]);
      }
      const url = adset_id ? `/${adset_id}/ads`
        : campaign_id ? `/${campaign_id}/ads`
        : `/act_${META_ACCOUNT_ID}/ads`;
      const data = await metaGet(url, params);
      const ads = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        const ctr = parseFloat(ins?.ctr || 0);
        const freq = parseFloat(ins?.frequency || 0);
        const flag = spend >= 4 && purchases === 0 ? "🔴 ВЫКЛЮЧИТЬ"
          : freq > 3 ? "⚠️ УСТАЛОСТЬ (freq > 3)"
          : ctr < 0.5 && spend > 3 ? "⚠️ НИЗКИЙ CTR"
          : purchases > 0 && cpp && parseFloat(cpp) < 5 ? "🟢 ПОБЕДИТЕЛЬ"
          : "🟡 НАБЛЮДАТЬ";
        return {
          id: a.id,
          name: a.name,
          status: a.status,
          creative_title: a.creative?.title,
          creative_body: a.creative?.body?.substring(0, 100),
          спенд: `$${spend.toFixed(2)}`,
          покупки: purchases,
          cpp: cpp ? `$${cpp}` : "нет",
          ctr: `${ctr.toFixed(2)}%`,
          frequency: freq.toFixed(2),
          флаг: flag,
        };
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ всего: ads.length, ads }, null, 2) }],
      };
    }
  );

  s.tool(
    "analyze_creatives",
    "Анализ креативов — поиск слабых и сильных",
    {
      days: z.number().default(7),
      min_spend_usd: z.number().default(3).describe("Мин. спенд в USD"),
    },
    async ({ days, min_spend_usd }) => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/ads`, {
        fields: `name,status,creative{title,body},insights{${INSIGHTS_FIELDS}}`,
        ...dateRange(days),
        limit: 100,
      });
      const ads = (data.data || [])
        .map((a) => {
          const ins = a.insights?.data?.[0];
          const spend = parseFloat(ins?.spend || 0);
          const { purchases, cpp, roas } = parsePurchases(ins);
          return {
            id: a.id, name: a.name, spend, purchases, cpp, roas,
            ctr: parseFloat(ins?.ctr || 0),
            frequency: parseFloat(ins?.frequency || 0),
            creative: a.creative?.body?.substring(0, 80),
          };
        })
        .filter((a) => a.spend >= min_spend_usd)
        .sort((a, b) => b.purchases - a.purchases || a.spend - b.spend);

      const winners = ads.filter((a) => a.purchases > 0 && a.cpp && parseFloat(a.cpp) <= 5);
      const losers = ads.filter((a) => a.spend >= 4 && a.purchases === 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            период_дней: days,
            победители: winners.map((a) => ({ ...a, cpp: a.cpp ? `$${a.cpp}` : null, рекомендация: "масштабировать" })),
            аутсайдеры: losers.map((a) => ({ ...a, рекомендация: "выключить" })),
            все_крео: ads,
          }, null, 2),
        }],
      };
    }
  );

  s.tool(
    "toggle_status",
    "Включить / выключить кампанию, адсет или объявление",
    {
      entity_type: z.enum(["campaign", "adset", "ad"]),
      entity_id: z.string(),
      status: z.enum(["ACTIVE", "PAUSED"]),
    },
    async ({ entity_type, entity_id, status }) => {
      await metaPost(`/${entity_id}`, { status });
      return { content: [{ type: "text", text: `✅ ${entity_type} ${entity_id} → ${status}` }] };
    }
  );

  s.tool(
    "scale_budget",
    "Изменить дневной или lifetime бюджет",
    {
      entity_type: z.enum(["campaign", "adset"]),
      entity_id: z.string(),
      budget: z.number().min(100).describe("Бюджет в копейках (500 = $5, 1500 = $15)"),
      is_lifetime: z.boolean().default(false),
    },
    async ({ entity_type, entity_id, budget, is_lifetime }) => {
      const body = is_lifetime ? { lifetime_budget: budget } : { daily_budget: budget };
      await metaPost(`/${entity_id}`, body);
      const usd = (budget / 100).toFixed(2);
      return {
        content: [{ type: "text", text: `✅ Бюджет ${entity_type} ${entity_id}: $${usd} (${is_lifetime ? "lifetime" : "daily"})` }],
      };
    }
  );

  s.tool(
    "duplicate_adset",
    "Дублировать адсет для масштабирования или смены гео",
    {
      adset_id: z.string(),
      new_budget_usd: z.number().optional().describe("Новый дневной бюджет в USD"),
      status_after: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async ({ adset_id, new_budget_usd, status_after }) => {
      const body = { deep_copy: true, status_option: status_after };
      if (new_budget_usd) body.daily_budget = Math.round(new_budget_usd * 100);
      const d = await metaPost(`/${adset_id}/copies`, body);
      return {
        content: [{ type: "text", text: `✅ Дублировано. Новый ID: ${d.copied_adset_id || JSON.stringify(d)}. Статус: ${status_after}` }],
      };
    }
  );

  // ── get_ads_today ──────────────────────────────────────────────────────────
  s.tool(
    "get_ads_today",
    "Объявления с метриками строго за сегодня",
    { status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL") },
    async ({ status }) => {
      const params = {
        fields: `name,status,creative{title,body},insights{${INSIGHTS_FIELDS}}`,
        limit: 100,
        ...todayRange(),
      };
      if (status !== "ALL") {
        params.filtering = JSON.stringify([{ field: "effective_status", operator: "IN", value: [status] }]);
      }
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/ads`, params);
      const ads = (data.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        const flag = spend >= 4 && purchases === 0 ? "🔴 ВЫКЛЮЧИТЬ"
          : purchases > 0 && cpp && parseFloat(cpp) < 5 ? "🟢 ПОБЕДИТЕЛЬ"
          : "🟡 НАБЛЮДАТЬ";
        return {
          id: a.id, name: a.name, status: a.status,
          creative: a.creative?.body?.substring(0, 80),
          спенд: `$${spend.toFixed(2)}`,
          покупки: purchases,
          cpp: cpp ? `$${cpp}` : "нет",
          ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%",
          флаг: flag,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify({ дата: fmtDate(new Date()), всего: ads.length, ads }, null, 2) }] };
    }
  );

  // ── get_campaign_stats ─────────────────────────────────────────────────────
  s.tool(
    "get_campaign_stats",
    "Детальная статистика по одной кампании за любой период",
    {
      campaign_id: z.string(),
      days: z.number().default(7),
    },
    async ({ campaign_id, days }) => {
      const [campaign, adsets] = await Promise.all([
        metaGet(`/${campaign_id}`, { fields: `name,status,daily_budget,lifetime_budget,objective,insights{${INSIGHTS_FIELDS}}`, ...dateRange(days) }),
        metaGet(`/${campaign_id}/adsets`, { fields: `name,status,daily_budget,insights{${INSIGHTS_FIELDS}}`, ...dateRange(days), limit: 50 }),
      ]);
      const ins = campaign.insights?.data?.[0];
      const { purchases, cpp, revenue, roas } = parsePurchases(ins);
      const adsetList = (adsets.data || []).map((a) => {
        const ai = a.insights?.data?.[0];
        const ap = parsePurchases(ai);
        return {
          id: a.id, name: a.name, status: a.status,
          daily_budget: a.daily_budget ? `$${(a.daily_budget / 100).toFixed(2)}` : null,
          спенд: `$${parseFloat(ai?.spend || 0).toFixed(2)}`,
          покупки: ap.purchases, cpp: ap.cpp ? `$${ap.cpp}` : "нет",
          ctr: ai?.ctr ? `${parseFloat(ai.ctr).toFixed(2)}%` : "0%",
        };
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            кампания: campaign.name, статус: campaign.status, период_дней: days,
            итого: { спенд: `$${parseFloat(ins?.spend || 0).toFixed(2)}`, покупки: purchases, cpp: cpp ? `$${cpp}` : "нет", roas: roas ? `${roas}x` : null, выручка: `$${revenue}` },
            адсеты: adsetList,
          }, null, 2),
        }],
      };
    }
  );

  // ── get_hourly_stats ───────────────────────────────────────────────────────
  s.tool(
    "get_hourly_stats",
    "Разбивка расхода и покупок по часам за сегодня или вчера",
    { day: z.enum(["today", "yesterday"]).default("today") },
    async ({ day }) => {
      const range = day === "today" ? todayRange() : yesterdayRange();
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/insights`, {
        fields: "spend,actions,impressions",
        time_increment: "1",
        breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone",
        ...range,
      });
      const hours = (data.data || []).map((h) => {
        const purchases = parseInt(h.actions?.find((a) => a.action_type === "purchase")?.value || 0);
        return { час: h.hourly_stats_aggregated_by_advertiser_time_zone, спенд: `$${parseFloat(h.spend || 0).toFixed(2)}`, покупки: purchases };
      }).sort((a, b) => a.час?.localeCompare(b.час));
      return { content: [{ type: "text", text: JSON.stringify({ день: day, разбивка_по_часам: hours }, null, 2) }] };
    }
  );

  // ── get_audience_insights ──────────────────────────────────────────────────
  s.tool(
    "get_audience_insights",
    "Кто реально покупает: возраст, пол, регион",
    {
      days: z.number().default(14),
      breakdown: z.enum(["age", "gender", "region", "age,gender"]).default("age,gender"),
    },
    async ({ days, breakdown }) => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/insights`, {
        fields: `spend,impressions,clicks,ctr,actions,cost_per_action_type`,
        breakdowns: breakdown,
        ...dateRange(days),
        limit: 100,
      });
      const rows = (data.data || []).map((r) => {
        const purchases = parseInt(r.actions?.find((a) => a.action_type === "purchase")?.value || 0);
        const spend = parseFloat(r.spend || 0);
        return {
          ...(r.age && { возраст: r.age }),
          ...(r.gender && { пол: r.gender }),
          ...(r.region && { регион: r.region }),
          спенд: `$${spend.toFixed(2)}`,
          покупки: purchases,
          cpp: purchases > 0 ? `$${(spend / purchases).toFixed(2)}` : "нет",
          ctr: r.ctr ? `${parseFloat(r.ctr).toFixed(2)}%` : "0%",
        };
      }).sort((a, b) => (b.покупки || 0) - (a.покупки || 0));
      return { content: [{ type: "text", text: JSON.stringify({ разбивка: breakdown, период_дней: days, аудитория: rows }, null, 2) }] };
    }
  );

  // ── get_frequency_alert ────────────────────────────────────────────────────
  s.tool(
    "get_frequency_alert",
    "Флаг адсетов где частота превышает порог — признак выгорания аудитории",
    {
      threshold: z.number().default(2.5).describe("Порог частоты"),
      days: z.number().default(7),
    },
    async ({ threshold, days }) => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/adsets`, {
        fields: `name,status,insights{frequency,spend,reach,impressions}`,
        ...dateRange(days), limit: 100,
        filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
      });
      const alerts = (data.data || [])
        .map((a) => {
          const ins = a.insights?.data?.[0];
          const freq = parseFloat(ins?.frequency || 0);
          return { id: a.id, name: a.name, frequency: freq, охват: ins?.reach || 0, спенд: `$${parseFloat(ins?.spend || 0).toFixed(2)}` };
        })
        .filter((a) => a.frequency >= threshold)
        .sort((a, b) => b.frequency - a.frequency);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            порог: threshold, период_дней: days,
            всего_с_проблемой: alerts.length,
            адсеты: alerts.map((a) => ({ ...a, рекомендация: a.frequency > 4 ? "🔴 срочно расширить аудиторию или выключить" : "⚠️ следить" })),
          }, null, 2),
        }],
      };
    }
  );

  // ── duplicate_ad ───────────────────────────────────────────────────────────
  s.tool(
    "duplicate_ad",
    "Дублировать объявление (для тестов нового крео)",
    {
      ad_id: z.string(),
      adset_id: z.string().optional().describe("Адсет назначения (если не указан — тот же)"),
      status_after: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async ({ ad_id, adset_id, status_after }) => {
      const body = { deep_copy: true, status_option: status_after };
      if (adset_id) body.adset_id = adset_id;
      const d = await metaPost(`/${ad_id}/copies`, body);
      return { content: [{ type: "text", text: `✅ Объявление продублировано. ID: ${d.copied_ad_id || JSON.stringify(d)}. Статус: ${status_after}` }] };
    }
  );

  // ── set_bid_cap ────────────────────────────────────────────────────────────
  s.tool(
    "set_bid_cap",
    "Поставить ограничение ставки на адсет",
    {
      adset_id: z.string(),
      bid_cap_usd: z.number().describe("Максимальная ставка в USD"),
    },
    async ({ adset_id, bid_cap_usd }) => {
      const bid_amount = Math.round(bid_cap_usd * 100);
      await metaPost(`/${adset_id}`, { bid_amount, bid_strategy: "LOWEST_COST_WITH_BID_CAP" });
      return { content: [{ type: "text", text: `✅ Bid cap адсета ${adset_id} установлен: $${bid_cap_usd}` }] };
    }
  );

  // ── get_budget_pacing ──────────────────────────────────────────────────────
  s.tool(
    "get_budget_pacing",
    "Сколько бюджета потрачено от дневного в % с учётом времени суток",
    {},
    async () => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/adsets`, {
        fields: `name,status,daily_budget,insights{spend}`,
        ...todayRange(), limit: 100,
        filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
      });
      const now = new Date();
      const dayPct = ((now.getHours() * 60 + now.getMinutes()) / 1440 * 100).toFixed(1);

      const pacing = (data.data || [])
        .filter((a) => a.daily_budget)
        .map((a) => {
          const budget = parseFloat(a.daily_budget) / 100;
          const spent = parseFloat(a.insights?.data?.[0]?.spend || 0);
          const spentPct = (spent / budget * 100).toFixed(1);
          const diff = parseFloat(spentPct) - parseFloat(dayPct);
          const status = diff < -20 ? "🐢 медленно" : diff > 20 ? "🔥 быстро (закончится раньше)" : "✅ норма";
          return { name: a.name, budget: `$${budget.toFixed(2)}`, потрачено: `$${spent.toFixed(2)}`, потрачено_пct: `${spentPct}%`, день_прошёл_pct: `${dayPct}%`, темп: status };
        });

      return { content: [{ type: "text", text: JSON.stringify({ время: now.toTimeString().slice(0, 5), день_прошёл: `${dayPct}%`, адсеты: pacing }, null, 2) }] };
    }
  );

  // ── get_alerts ─────────────────────────────────────────────────────────────
  s.tool(
    "get_alerts",
    "Сводка аномалий: рост CPP, падение CTR, нулевые покупки, высокая частота",
    {
      max_cpp: z.number().default(6).describe("Порог CPP для алерта"),
      min_ctr: z.number().default(0.5).describe("Минимальный CTR %"),
      max_frequency: z.number().default(3.0),
      spend_no_conv: z.number().default(4).describe("Спенд без конверсий для алерта"),
    },
    async ({ max_cpp, min_ctr, max_frequency, spend_no_conv }) => {
      const [adsetsData, adsData] = await Promise.all([
        metaGet(`/act_${META_ACCOUNT_ID}/adsets`, {
          fields: `name,status,insights{spend,ctr,frequency,actions}`,
          ...todayRange(), limit: 100,
          filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
        }),
        metaGet(`/act_${META_ACCOUNT_ID}/ads`, {
          fields: `name,status,insights{spend,ctr,actions}`,
          ...todayRange(), limit: 100,
          filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
        }),
      ]);

      const alerts = [];

      for (const a of adsetsData.data || []) {
        const ins = a.insights?.data?.[0];
        const spend = parseFloat(ins?.spend || 0);
        const ctr = parseFloat(ins?.ctr || 0);
        const freq = parseFloat(ins?.frequency || 0);
        const purchases = parseInt(ins?.actions?.find((x) => x.action_type === "purchase")?.value || 0);
        const cpp = purchases > 0 ? spend / purchases : null;
        if (spend >= spend_no_conv && purchases === 0) alerts.push({ тип: "🔴 НЕТ КОНВЕРСИЙ", объект: "адсет", name: a.name, детали: `$${spend.toFixed(2)} потрачено, 0 покупок` });
        if (cpp && cpp > max_cpp) alerts.push({ тип: "🔴 ВЫСОКИЙ CPP", объект: "адсет", name: a.name, детали: `CPP $${cpp.toFixed(2)} > порога $${max_cpp}` });
        if (spend > 2 && ctr < min_ctr) alerts.push({ тип: "⚠️ НИЗКИЙ CTR", объект: "адсет", name: a.name, детали: `CTR ${ctr.toFixed(2)}% < ${min_ctr}%` });
        if (freq > max_frequency) alerts.push({ тип: "⚠️ ВЫСОКАЯ ЧАСТОТА", объект: "адсет", name: a.name, детали: `Frequency ${freq.toFixed(2)} > ${max_frequency}` });
      }

      for (const a of adsData.data || []) {
        const ins = a.insights?.data?.[0];
        const spend = parseFloat(ins?.spend || 0);
        const purchases = parseInt(ins?.actions?.find((x) => x.action_type === "purchase")?.value || 0);
        if (spend >= spend_no_conv && purchases === 0) alerts.push({ тип: "🔴 НЕТ КОНВЕРСИЙ", объект: "объявление", name: a.name, детали: `$${spend.toFixed(2)} потрачено, 0 покупок — выключить` });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ время: new Date().toTimeString().slice(0, 5), всего_алертов: alerts.length, алерты: alerts }, null, 2),
        }],
      };
    }
  );

  // ── get_daily_summary ──────────────────────────────────────────────────────
  s.tool(
    "get_daily_summary",
    "Итог дня одной командой: расход / покупки / ROAS / лучший крео / что выключить",
    {},
    async () => {
      const [accToday, accYest, adsToday] = await Promise.all([
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...todayRange() }),
        metaGet(`/act_${META_ACCOUNT_ID}/insights`, { fields: INSIGHTS_FIELDS, level: "account", ...yesterdayRange() }),
        metaGet(`/act_${META_ACCOUNT_ID}/ads`, {
          fields: `name,status,creative{title,body},insights{${INSIGHTS_FIELDS}}`,
          ...todayRange(), limit: 100,
        }),
      ]);

      const today = parsePurchases(accToday.data?.[0]);
      const yest = parsePurchases(accYest.data?.[0]);
      const todayIns = accToday.data?.[0] || {};
      const yesterdayIns = accYest.data?.[0] || {};

      const ads = (adsToday.data || []).map((a) => {
        const ins = a.insights?.data?.[0];
        const { purchases, cpp } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        return { id: a.id, name: a.name, spend, purchases, cpp: cpp ? parseFloat(cpp) : null, ctr: parseFloat(ins?.ctr || 0) };
      });

      const winner = ads.filter((a) => a.purchases > 0).sort((a, b) => (a.cpp || 99) - (b.cpp || 99))[0];
      const toKill = ads.filter((a) => a.spend >= 4 && a.purchases === 0);

      const spendToday = parseFloat(todayIns.spend || 0);
      const spendYest = parseFloat(yesterdayIns.spend || 0);
      const purchDelta = today.purchases - yest.purchases;
      const spendDelta = spendToday - spendYest;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            дата: fmtDate(new Date()),
            сегодня: {
              спенд: `$${spendToday.toFixed(2)}`,
              покупки: today.purchases,
              cpp: today.cpp ? `$${today.cpp}` : "нет конверсий",
              roas: today.roas ? `${today.roas}x` : null,
              ctr: todayIns.ctr ? `${parseFloat(todayIns.ctr).toFixed(2)}%` : "0%",
            },
            vs_вчера: {
              покупки: `${purchDelta >= 0 ? "+" : ""}${purchDelta}`,
              спенд: `${spendDelta >= 0 ? "+" : ""}$${spendDelta.toFixed(2)}`,
            },
            лучший_крео: winner ? { name: winner.name, покупки: winner.purchases, cpp: `$${winner.cpp.toFixed(2)}` } : "нет конверсий сегодня",
            выключить: toKill.map((a) => ({ name: a.name, спенд: `$${a.spend.toFixed(2)}`, причина: "$4+ без покупок" })),
            итог: toKill.length > 0 ? `⚠️ ${toKill.length} объявлений нужно выключить` : "✅ Всё в порядке",
          }, null, 2),
        }],
      };
    }
  );

  // ── get_ab_test_results ────────────────────────────────────────────────────
  s.tool(
    "get_ab_test_results",
    "Сравнение двух крео или адсетов по ключевым метрикам",
    {
      id_a: z.string().describe("ID первого объявления или адсета"),
      id_b: z.string().describe("ID второго объявления или адсета"),
      type: z.enum(["ad", "adset"]).default("ad"),
      days: z.number().default(7),
    },
    async ({ id_a, id_b, type, days }) => {
      const fields = `name,status,insights{${INSIGHTS_FIELDS}}`;
      const [a, b] = await Promise.all([
        metaGet(`/${id_a}`, { fields, ...dateRange(days) }),
        metaGet(`/${id_b}`, { fields, ...dateRange(days) }),
      ]);
      const parse = (obj) => {
        const ins = obj.insights?.data?.[0];
        const { purchases, cpp, roas } = parsePurchases(ins);
        const spend = parseFloat(ins?.spend || 0);
        return { name: obj.name, спенд: `$${spend.toFixed(2)}`, покупки: purchases, cpp: cpp ? `$${cpp}` : "нет", roas: roas ? `${roas}x` : null, ctr: ins?.ctr ? `${parseFloat(ins.ctr).toFixed(2)}%` : "0%", cpc: ins?.cpc ? `$${parseFloat(ins.cpc).toFixed(2)}` : null, frequency: ins?.frequency ? parseFloat(ins.frequency).toFixed(2) : null, _spend: spend, _cpp: cpp ? parseFloat(cpp) : null, _purchases: purchases };
      };
      const ra = parse(a), rb = parse(b);
      const winner = ra._cpp && rb._cpp ? (ra._cpp < rb._cpp ? "A" : "B") : ra._purchases > rb._purchases ? "A" : rb._purchases > ra._purchases ? "B" : "нет данных";
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            период_дней: days,
            A: ra, B: rb,
            победитель: winner,
            рекомендация: winner !== "нет данных" ? `Масштабировать ${winner}, выключить ${winner === "A" ? "B" : "A"} если разница стабильна 3+ дня` : "Недостаточно данных — ждать минимум 3 дня",
          }, null, 2),
        }],
      };
    }
  );

  // ── get_winner_recommendation ──────────────────────────────────────────────
  s.tool(
    "get_winner_recommendation",
    "Автовывод победителя среди всех активных крео с рекомендацией по каждому",
    { days: z.number().default(7), min_spend_usd: z.number().default(3) },
    async ({ days, min_spend_usd }) => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}/ads`, {
        fields: `name,status,adset_id,creative{title,body},insights{${INSIGHTS_FIELDS}}`,
        ...dateRange(days), limit: 100,
      });
      const ads = (data.data || [])
        .map((a) => {
          const ins = a.insights?.data?.[0];
          const spend = parseFloat(ins?.spend || 0);
          const { purchases, cpp, roas } = parsePurchases(ins);
          const ctr = parseFloat(ins?.ctr || 0);
          const freq = parseFloat(ins?.frequency || 0);
          let action = "⏳ мало данных";
          if (spend >= min_spend_usd) {
            if (purchases === 0 && spend >= 4) action = "🔴 выключить";
            else if (cpp && parseFloat(cpp) <= 5 && purchases >= 2) action = "🟢 масштабировать";
            else if (ctr < 0.5 && spend > 5) action = "🟡 проблема с CTR — сменить крео";
            else if (freq > 3) action = "🟡 аудитория выгорает";
            else if (purchases > 0) action = "🟡 наблюдать ещё 1-2 дня";
          }
          return { name: a.name, спенд: `$${spend.toFixed(2)}`, покупки: purchases, cpp: cpp ? `$${cpp}` : "нет", ctr: `${ctr.toFixed(2)}%`, frequency: freq.toFixed(2), действие: action, _purchases: purchases, _cpp: cpp ? parseFloat(cpp) : 99, _spend: spend };
        })
        .filter((a) => a._spend >= min_spend_usd)
        .sort((a, b) => b._purchases - a._purchases || a._cpp - b._cpp);

      const winner = ads.find((a) => a._purchases >= 2 && a._cpp <= 5);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            период_дней: days,
            победитель: winner ? { name: winner.name, cpp: winner.cpp, покупки: winner.покупки } : "не определён — нужно больше данных",
            все_крео: ads,
          }, null, 2),
        }],
      };
    }
  );


  // ── create_campaign ────────────────────────────────────────────────────────
  s.tool(
    "create_campaign",
    "Создать кампанию с нуля",
    {
      name: z.string().describe("Название кампании"),
      objective: z.enum(["OUTCOME_SALES", "OUTCOME_LEADS", "OUTCOME_TRAFFIC", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT"]).default("OUTCOME_SALES"),
      daily_budget_usd: z.number().optional().describe("Дневной бюджет в USD (если задаётся на уровне кампании)"),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
      special_ad_categories: z.array(z.string()).default([]),
    },
    async ({ name, objective, daily_budget_usd, status, special_ad_categories }) => {
      const body = {
        name,
        objective,
        status,
        special_ad_categories,
      };
      if (daily_budget_usd) body.daily_budget = Math.round(daily_budget_usd * 100);
      const d = await metaPost(`/act_${META_ACCOUNT_ID}/campaigns`, body);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, campaign_id: d.id, name, objective, status }, null, 2) }] };
    }
  );

  // ── create_adset ───────────────────────────────────────────────────────────
  s.tool(
    "create_adset",
    "Создать новый адсет с полными настройками таргетинга",
    {
      name: z.string(),
      campaign_id: z.string(),
      daily_budget_usd: z.number().describe("Дневной бюджет в USD"),
      optimization_goal: z.enum(["OFFSITE_CONVERSIONS", "LINK_CLICKS", "REACH", "IMPRESSIONS", "LEAD_GENERATION"]).default("OFFSITE_CONVERSIONS"),
      billing_event: z.enum(["IMPRESSIONS", "LINK_CLICKS"]).default("IMPRESSIONS"),
      pixel_id: z.string().optional().describe("ID пикселя (если не указан — берётся из ENV)"),
      countries: z.array(z.string()).default(["UA"]).describe("Гео: ['UA'], ['US','CA'], ['WORLDWIDE'] для широкой"),
      languages: z.array(z.number()).default([]).describe("Языки: 32=украинский, 8=русский, 6=английский"),
      age_min: z.number().default(18),
      age_max: z.number().default(65),
      genders: z.array(z.number()).default([]).describe("1=мужской, 2=женский, [] = все"),
      excluded_connections: z.array(z.string()).default([]).describe("Исключить: page_id тех кто уже лайкнул страницу"),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
      start_time: z.string().optional().describe("ISO дата старта, например 2025-01-15T11:00:00+0200"),
      end_time: z.string().optional(),
    },
    async ({ name, campaign_id, daily_budget_usd, optimization_goal, billing_event, pixel_id, countries, languages, age_min, age_max, genders, excluded_connections, status, start_time, end_time }) => {
      const targeting = {
        age_min,
        age_max,
        geo_locations: countries.includes("WORLDWIDE")
          ? { location_types: ["home", "recent"] }
          : { countries },
      };
      if (languages.length) targeting.locales = languages;
      if (genders.length) targeting.genders = genders;
      if (excluded_connections.length) {
        targeting.excluded_connections = excluded_connections.map((id) => ({ id, type: "page" }));
      }

      const usedPixel = pixel_id || process.env.META_PIXEL_ID;
      const body = {
        name,
        campaign_id,
        daily_budget: Math.round(daily_budget_usd * 100),
        optimization_goal,
        billing_event,
        targeting,
        status,
        ...(usedPixel && {
          promoted_object: {
            pixel_id: usedPixel,
            custom_event_type: "PURCHASE",
          },
        }),
        ...(start_time && { start_time }),
        ...(end_time && { end_time }),
      };

      const d = await metaPost(`/act_${META_ACCOUNT_ID}/adsets`, body);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, adset_id: d.id, name, campaign_id, budget: `$${daily_budget_usd}`, гео: countries, статус: status }, null, 2),
        }],
      };
    }
  );

  // ── update_targeting ───────────────────────────────────────────────────────
  s.tool(
    "update_targeting",
    "Менять гео, возраст, пол, языки адсета на лету",
    {
      adset_id: z.string(),
      countries: z.array(z.string()).optional(),
      age_min: z.number().optional(),
      age_max: z.number().optional(),
      genders: z.array(z.number()).optional().describe("1=мужской, 2=женский, [] = все"),
      languages: z.array(z.number()).optional(),
    },
    async ({ adset_id, countries, age_min, age_max, genders, languages }) => {
      // Сначала получаем текущий таргетинг
      const current = await metaGet(`/${adset_id}`, { fields: "targeting" });
      const targeting = { ...current.targeting };

      if (countries) targeting.geo_locations = countries.includes("WORLDWIDE") ? { location_types: ["home", "recent"] } : { countries };
      if (age_min !== undefined) targeting.age_min = age_min;
      if (age_max !== undefined) targeting.age_max = age_max;
      if (genders !== undefined) targeting.genders = genders.length ? genders : undefined;
      if (languages !== undefined) targeting.locales = languages.length ? languages : undefined;

      await metaPost(`/${adset_id}`, { targeting });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, adset_id, обновлено: { countries, age_min, age_max, genders, languages } }, null, 2),
        }],
      };
    }
  );

  // ── upload_image ───────────────────────────────────────────────────────────
  s.tool(
    "upload_image",
    "Загрузить изображение по URL в библиотеку рекламного аккаунта",
    {
      image_url: z.string().describe("Публичный URL изображения"),
      name: z.string().optional().describe("Название файла"),
    },
    async ({ image_url, name }) => {
      const body = { url: image_url };
      if (name) body.name = name;
      const d = await metaPost(`/act_${META_ACCOUNT_ID}/adimages`, body);
      const imgData = d.images?.[Object.keys(d.images || {})[0]];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, hash: imgData?.hash, url: imgData?.url, permalink_url: imgData?.permalink_url }, null, 2),
        }],
      };
    }
  );

  // ── create_ad ──────────────────────────────────────────────────────────────
  s.tool(
    "create_ad",
    "Создать объявление с новым крео, текстом и заголовком",
    {
      name: z.string(),
      adset_id: z.string(),
      page_id: z.string().describe("Facebook Page ID"),
      primary_text: z.string().describe("Основной текст объявления"),
      headline: z.string().optional().describe("Заголовок"),
      description: z.string().optional().describe("Описание"),
      link_url: z.string().describe("Ссылка куда ведёт объявление"),
      image_hash: z.string().optional().describe("Хэш изображения из upload_image"),
      video_id: z.string().optional().describe("ID видео"),
      call_to_action: z.enum(["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "GET_OFFER", "BUY_NOW", "SUBSCRIBE"]).default("LEARN_MORE"),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    async ({ name, adset_id, page_id, primary_text, headline, description, link_url, image_hash, video_id, call_to_action, status }) => {
      // Сначала создаём creative
      const creativeBody = {
        name: `creative_${name}`,
        object_story_spec: {
          page_id,
          link_data: {
            message: primary_text,
            link: link_url,
            call_to_action: { type: call_to_action, value: { link: link_url } },
            ...(headline && { name: headline }),
            ...(description && { description }),
            ...(image_hash && { image_hash }),
            ...(video_id && { video_id }),
          },
        },
      };
      const creative = await metaPost(`/act_${META_ACCOUNT_ID}/adcreatives`, creativeBody);

      // Затем создаём объявление
      const ad = await metaPost(`/act_${META_ACCOUNT_ID}/ads`, {
        name,
        adset_id,
        creative: { creative_id: creative.id },
        status,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, ad_id: ad.id, creative_id: creative.id, name, статус: status }, null, 2),
        }],
      };
    }
  );

  // ── update_ad_creative ─────────────────────────────────────────────────────
  s.tool(
    "update_ad_creative",
    "Обновить текст или заголовок существующего объявления",
    {
      ad_id: z.string(),
      page_id: z.string(),
      primary_text: z.string().optional(),
      headline: z.string().optional(),
      link_url: z.string().optional(),
      image_hash: z.string().optional(),
      call_to_action: z.enum(["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "GET_OFFER", "BUY_NOW", "SUBSCRIBE"]).optional(),
    },
    async ({ ad_id, page_id, primary_text, headline, link_url, image_hash, call_to_action }) => {
      // Получаем текущий creative
      const adData = await metaGet(`/${ad_id}`, { fields: "creative{id,object_story_spec}" });
      const oldSpec = adData.creative?.object_story_spec?.link_data || {};

      const newSpec = {
        ...oldSpec,
        ...(primary_text && { message: primary_text }),
        ...(headline && { name: headline }),
        ...(link_url && { link: link_url }),
        ...(image_hash && { image_hash }),
        ...(call_to_action && { call_to_action: { type: call_to_action, value: { link: link_url || oldSpec.link } } }),
      };

      const creative = await metaPost(`/act_${META_ACCOUNT_ID}/adcreatives`, {
        name: `creative_updated_${Date.now()}`,
        object_story_spec: { page_id, link_data: newSpec },
      });

      await metaPost(`/${ad_id}`, { creative: { creative_id: creative.id } });
      return { content: [{ type: "text", text: `✅ Крео объявления ${ad_id} обновлено. Новый creative_id: ${creative.id}` }] };
    }
  );

  // ── get_placements_breakdown ───────────────────────────────────────────────
  s.tool(
    "get_placements_breakdown",
    "Разбивка по плейсментам: Feed / Reels / Stories / Audience Network",
    {
      days: z.number().default(7),
      campaign_id: z.string().optional(),
    },
    async ({ days, campaign_id }) => {
      const params = {
        fields: `spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type`,
        breakdowns: "publisher_platform,platform_position",
        ...dateRange(days),
        limit: 100,
      };
      const url = campaign_id ? `/${campaign_id}/insights` : `/act_${META_ACCOUNT_ID}/insights`;
      const data = await metaGet(url, params);

      const rows = (data.data || []).map((r) => {
        const purchases = parseInt(r.actions?.find((a) => a.action_type === "purchase")?.value || 0);
        const spend = parseFloat(r.spend || 0);
        return {
          платформа: r.publisher_platform,
          позиция: r.platform_position,
          спенд: `$${spend.toFixed(2)}`,
          покупки: purchases,
          cpp: purchases > 0 ? `$${(spend / purchases).toFixed(2)}` : "нет",
          ctr: r.ctr ? `${parseFloat(r.ctr).toFixed(2)}%` : "0%",
          cpc: r.cpc ? `$${parseFloat(r.cpc).toFixed(2)}` : null,
        };
      }).sort((a, b) => parseFloat(b.спенд.replace("$","")) - parseFloat(a.спенд.replace("$","")));

      return { content: [{ type: "text", text: JSON.stringify({ период_дней: days, плейсменты: rows }, null, 2) }] };
    }
  );

  // ── pause_all_emergency ────────────────────────────────────────────────────
  s.tool(
    "pause_all_emergency",
    "⛔ ЭКСТРЕННАЯ ОСТАНОВКА — поставить все активные кампании на паузу",
    { confirm: z.boolean().describe("Обязательно true для выполнения") },
    async ({ confirm }) => {
      if (!confirm) return { content: [{ type: "text", text: "⛔ Не выполнено. Передай confirm: true для подтверждения." }] };
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
      return { content: [{ type: "text", text: JSON.stringify({ ⛔: "ВСЕ КАМПАНИИ ОСТАНОВЛЕНЫ", остановлено: results.length, кампании: results }, null, 2) }] };
    }
  );

  // ── get_account_limits ─────────────────────────────────────────────────────
  s.tool(
    "get_account_limits",
    "Проверить лимиты аккаунта: спенд-лимит, остаток, статус",
    {},
    async () => {
      const data = await metaGet(`/act_${META_ACCOUNT_ID}`, {
        fields: "name,account_status,currency,spend_cap,amount_spent,balance,disable_reason,timezone_name",
      });
      const statusMap = { 1: "✅ ACTIVE", 2: "⛔ DISABLED", 3: "⚠️ UNSETTLED", 7: "🔒 PENDING_RISK_REVIEW", 9: "🚫 IN_GRACE_PERIOD", 101: "⛔ TEMP_DISABLED" };
      const spent = parseFloat(data.amount_spent || 0) / 100;
      const cap = data.spend_cap ? parseFloat(data.spend_cap) / 100 : null;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            аккаунт: data.name,
            статус: statusMap[data.account_status] || data.account_status,
            валюта: data.currency,
            потрачено_всего: `$${spent.toFixed(2)}`,
            spend_cap: cap ? `$${cap.toFixed(2)}` : "не установлен",
            остаток_до_лимита: cap ? `$${(cap - spent).toFixed(2)}` : "∞",
            баланс: data.balance ? `$${(parseFloat(data.balance) / 100).toFixed(2)}` : null,
            timezone: data.timezone_name,
          }, null, 2),
        }],
      };
    }
  );

}

// ── Express ────────────────────────────────────────────────────────────────────
// ВАЖНО: НЕТ app.use(express.json()) — он поглощает стрим запроса,
// из-за чего transport.handlePostMessage() получает пустое тело и молча падает
const app = express();
const transports = new Map();

app.get("/", (req, res) => res.send("FB Ads MCP Server ✅ v3.0.0"));
app.get("/health", (req, res) =>
  res.json({ status: "ok", account: META_ACCOUNT_ID ? "connected" : "no token" })
);

app.get("/sse", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  const mcpServer = new McpServer({ name: "fb-ads-mcp", version: "2.1.0" });
  registerTools(mcpServer);

  res.on("close", () => {
    transports.delete(transport.sessionId);
    mcpServer.close().catch(() => {});
  });

  // connect() первым — транспорт берёт управление над res
  await mcpServer.connect(transport);
  console.log(`✅ Connected [${transport.sessionId}]`);

  // Keepalive только ПОСЛЕ connect — SSE-комментарии не влияют на MCP протокол
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 25000);
  res.on("close", () => clearInterval(keepalive));
});

// handlePostMessage сам читает raw body — express.json() здесь не нужен
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
  console.log(`🚀 FB Ads MCP v3.0.0 on port ${PORT}`);
  console.log(`   Account: act_${META_ACCOUNT_ID}`);
});
