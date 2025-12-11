// 边缘本地化天气助手（阿里云 Pages Edge Function）
// 说明：
// 1) 在边缘解析用户 IP -> 通过高德 IP 定位获取城市
// 2) 转发调用和风天气（QWeather）公开天气 API 获取实时天气
// 3) 接入讯飞星火 MaaS API 生成个性化本地化提醒
// 4) 实现 1 小时内存缓存，降低 API 调用次数
// 5) 处理 CORS，支持跨域访问
//
// 讯飞星火 MaaS API 对接要点（与 OpenAI 风格兼容）：
// - 接口地址： https://maas-api.cn-huabei-1.xf-yun.com/v1/chat/completions （POST）
// - Header：
//   Authorization: Bearer ${AI_SERVERLESS_API_KEY}
//   Content-Type: application/json
// - Body 示例：
//   {
//     "model": "general",
//     "messages": [
//       {"role":"system","content":"请用简洁中文分点输出，总字数≤50，单条≤30"},
//       {"role":"user","content":"城市:杭州; 温度:28℃; 湿度:60%; 降水概率:40%; 风力:4级; 生成穿搭/出行建议"}
//     ],
//     "temperature": 0.3,
//     "max_tokens": 120
//   }
// - 返回：与 OpenAI Chat Completions 类似，取 choices[0].message.content
//
// 环境变量（需在阿里云 Pages 中配置）：
// - AI_SERVERLESS_API_KEY       讯飞星火 MaaS API 密钥（禁止硬编码）
// - AMAP_API_KEY                高德开放平台密钥（IP 定位）
// - QWEATHER_API_KEY            和风天气密钥（公开天气数据）

const CACHE_TTL_MS = 60 * 60 * 1000;
const cityCache = new Map();

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function ok(data, origin) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: corsHeaders(origin),
  });
}

function err(status, message, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: corsHeaders(origin),
  });
}

function getClientIp(req) {
  const h = req.headers;
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = h.get("x-real-ip");
  if (real) return real.trim();
  const cf = h.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = h.get("forwarded");
  if (fwd) {
    const m = /for=([^;]+)/.exec(fwd);
    if (m) return m[1].replace(/\[|\]|"/g, "");
  }
  return "";
}

async function amapIpLocate(ip, key) {
  const url = `https://restapi.amap.com/v3/ip?ip=${encodeURIComponent(ip)}&key=${key}`;
  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) throw new Error("AMap IP locate failed");
  const j = await r.json();
  if (j.status !== "1") throw new Error("AMap status != 1");
  return { city: j.city || j.province || "", adcode: j.adcode || "" };
}

async function qweatherCityLookup(cityName, key) {
  const url = `https://geoapi.qweather.com/v2/city/lookup?location=${encodeURIComponent(cityName)}&key=${key}`;
  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) throw new Error("QWeather city lookup failed");
  const j = await r.json();
  if (j.code !== "200" || !j.location || !j.location.length) throw new Error("QWeather city not found");
  const loc = j.location[0];
  return { id: loc.id, name: loc.name, lat: loc.lat, lon: loc.lon, adm2: loc.adm2, adm1: loc.adm1 };
}

async function qweatherNow(id, key) {
  const url = `https://devapi.qweather.com/v7/weather/now?location=${id}&key=${key}`;
  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) throw new Error("QWeather now failed");
  const j = await r.json();
  if (j.code !== "200" || !j.now) throw new Error("QWeather now invalid");
  const n = j.now;
  return { temp: Number(n.temp), humidity: Number(n.humidity), windScale: Number(n.windScale || n.windScale === 0 ? n.windScale : 0) };
}

async function qweatherHourly(id, key) {
  const url = `https://devapi.qweather.com/v7/weather/24h?location=${id}&key=${key}`;
  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) throw new Error("QWeather hourly failed");
  const j = await r.json();
  if (j.code !== "200" || !j.hourly || !j.hourly.length) throw new Error("QWeather hourly invalid");
  const h0 = j.hourly[0];
  const prob = h0.precipProb !== undefined ? Number(h0.precipProb) : (Number(h0.pop) || 0);
  return { precipProbability: Number.isFinite(prob) ? prob : 0 };
}

function fallbackAdvice(weather) {
  const tips = [];
  if (weather.temp < 5) tips.push("低温防寒，穿羽绒服+围巾");
  if (weather.temp > 30) tips.push("高温防暑，避正午外出防晒");
  if (weather.precipProbability > 60) tips.push("降水较大，通勤记得带伞");
  if (weather.windScale > 5) tips.push("风力偏大，注意防风与坠物");
  if (!tips.length) tips.push("天气平稳，合理安排出行");
  const trimmed = tips.map(t => t.length > 30 ? t.slice(0, 30) : t);
  const joined = trimmed.join("；");
  if (joined.length > 50) {
    // 尽量满足总字数≤50
    let out = [];
    let len = 0;
    for (const t of trimmed) {
      if (len + t.length + (out.length ? 1 : 0) <= 50) {
        out.push(t);
        len += t.length + (out.length ? 1 : 0);
      } else break;
    }
    return out;
  }
  return trimmed;
}

async function sparkAdvice(city, weather, apiKey) {
  const endpoint = "https://maas-api.cn-huabei-1.xf-yun.com/v1/chat/completions";
  const system = "请用简洁中文分点输出，总字数≤50，单条≤30；结合温度、降水概率、风力给穿搭与出行建议";
  const user = `城市:${city}; 温度:${weather.temp}℃; 湿度:${weather.humidity}%; 降水概率:${weather.precipProbability}%;
风力:${weather.windScale}级; 按规则生成本地化建议`;
  const body = {
    model: "general",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.3,
    max_tokens: 120
  };
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    timeout: 10000
  });
  if (!r.ok) throw new Error("Spark MaaS request failed");
  const j = await r.json();
  let content = "";
  if (j.choices && j.choices.length && j.choices[0].message && j.choices[0].message.content) {
    content = j.choices[0].message.content;
  } else if (j.output && j.output.text) {
    content = j.output.text;
  } else {
    throw new Error("Spark response format unknown");
  }
  const lines = content
    .split(/\n|；|;|。/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.length > 30 ? s.slice(0, 30) : s);
  const joined = lines.join("；");
  if (joined.length <= 50) return lines;
  const out = [];
  let len = 0;
  for (const t of lines) {
    if (len + t.length + (out.length ? 1 : 0) <= 50) {
      out.push(t);
      len += t.length + (out.length ? 1 : 0);
    } else break;
  }
  return out.length ? out : fallbackAdvice(weather);
}

export default async function (req) {
  const origin = req.headers.get("origin") || "*";
  const { searchParams } = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "GET") {
    return err(405, "Method Not Allowed", origin);
  }

  const amapKey = process.env.AMAP_API_KEY;
  const qKey = process.env.QWEATHER_API_KEY;
  const aiKey = process.env.AI_SERVERLESS_API_KEY;

  let inputCity = (searchParams.get("city") || "").trim();
  let resolvedCity = inputCity;
  let locationId = "";
  let locMeta = null;
  let fromCache = false;

  try {
    if (!resolvedCity) {
      const ip = getClientIp(req);
      if (!amapKey) throw new Error("Missing AMAP_API_KEY");
      const loc = await amapIpLocate(ip, amapKey);
      resolvedCity = loc.city || loc.province || "";
    }

    // 缓存命中
    const cacheHit = cityCache.get(resolvedCity);
    const nowTs = Date.now();
    if (cacheHit && (nowTs - cacheHit.ts) < CACHE_TTL_MS) {
      fromCache = true;
      return ok({ ...cacheHit.payload, cached: true }, origin);
    }

    if (!qKey) throw new Error("Missing QWEATHER_API_KEY");
    const found = await qweatherCityLookup(resolvedCity, qKey);
    locationId = found.id;
    locMeta = found;

    const now = await qweatherNow(locationId, qKey);
    let hourly = { precipProbability: 0 };
    try {
      hourly = await qweatherHourly(locationId, qKey);
    } catch (_) {}

    const weather = {
      temp: Number(now.temp),
      humidity: Number(now.humidity),
      precipProbability: Number(hourly.precipProbability),
      windScale: Number(now.windScale)
    };

    let advice = [];
    try {
      if (!aiKey) throw new Error("Missing AI_SERVERLESS_API_KEY");
      advice = await sparkAdvice(resolvedCity, weather, aiKey);
    } catch (_) {
      advice = fallbackAdvice(weather);
    }

    const payload = {
      city: resolvedCity,
      qweatherLocation: locMeta,
      weather,
      advice,
      source: "qweather",
      timestamp: new Date().toISOString(),
      cached: false
    };

    cityCache.set(resolvedCity, { ts: Date.now(), payload });
    return ok(payload, origin);
  } catch (e) {
    // 降级：返回默认天气提示
    const payload = {
      city: resolvedCity || "未知城市",
      weather: { temp: 20, humidity: 50, precipProbability: 20, windScale: 3 },
      advice: fallbackAdvice({ temp: 20, humidity: 50, precipProbability: 20, windScale: 3 }),
      source: "degraded",
      error: String(e && e.message ? e.message : e),
      timestamp: new Date().toISOString(),
      cached: fromCache
    };
    return ok(payload, origin);
  }
}

