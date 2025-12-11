// 阿里云Pages边缘函数（安全版，无硬编码API Key）
export default async function handler(req, res) {
  // 极简跨域配置
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    // 解析前端传参
    const { prompt } = await req.json();
    if (!prompt) return res.status(400).json({ content: '请输入关键词' });

    // 从环境变量读取讯飞API Key（核心改造点）
    const XUNFEI_API_KEY = process.env.XUNFEI_API_KEY;
    if (!XUNFEI_API_KEY) {
      return res.status(500).json({ content: '未配置API Key，请在Pages控制台设置环境变量' });
    }

    // 调用讯飞星火API（使用环境变量中的密钥）
    const xunfeiRes = await fetch('https://maas-api.cn-huabei-1.xf-yun.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XUNFEI_API_KEY}` // 不再硬编码！
      },
      body: JSON.stringify({
        model: "general",
        messages: [{ role: 'user', content: `用${prompt}生成一句简短文案，不超过20字，无多余内容` }]
      })
    });

    const xunfeiData = await xunfeiRes.json();
    const content = xunfeiData.choices?.[0]?.message?.content || '未生成有效内容';
    
    res.status(200).json({ content });
  } catch (err) {
    res.status(500).json({ content: '生成失败：' + err.message });
  }
}