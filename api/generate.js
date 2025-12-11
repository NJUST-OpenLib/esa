export default async function handler(req) {
  const url = new URL(req.url);
  const isDebug = url.searchParams.get('debug') === '1' || process.env.DEBUG === '1';
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers });
  }
  try {
    let prompt = '';
    if (req.method === 'GET') {
      prompt = (url.searchParams.get('prompt') || '').trim();
    } else {
      const body = await req.json().catch(() => ({}));
      prompt = (body.prompt || '').trim();
    }
    if (!prompt) {
      const r = { content: '请输入关键词' };
      return new Response(JSON.stringify(r), { status: 400, headers });
    }

    const key = process.env.XUNFEI_API_KEY || process.env.AI_SERVERLESS_API_KEY || '';
    if (!key) {
      const r = { content: '未配置API Key，请在Pages控制台设置环境变量' };
      return new Response(JSON.stringify(r), { status: 500, headers });
    }

    const started = Date.now();
    const resp = await fetch('https://maas-api.cn-huabei-1.xf-yun.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'general',
        messages: [{ role: 'user', content: `用${prompt}生成一句简短文案，不超过20字，无多余内容` }],
        temperature: 0.3,
        max_tokens: 60
      })
    });
    const ended = Date.now();
    const data = await resp.json().catch(() => ({}));
    const content = data?.choices?.[0]?.message?.content || data?.output?.text || '未生成有效内容';
    const meta = isDebug ? {
      ok: resp.ok,
      status: resp.status,
      latency_ms: ended - started,
      endpoint: 'chat/completions',
      input_len: prompt.length,
      raw_sample: typeof data === 'object' ? Object.keys(data).slice(0,5) : []
    } : undefined;
    const r = meta ? { content, meta } : { content };
    return new Response(JSON.stringify(r), { status: 200, headers });
  } catch (err) {
    const r = { content: '生成失败：' + (err && err.message ? err.message : String(err)) };
    return new Response(JSON.stringify(r), { status: 500, headers });
  }
}
