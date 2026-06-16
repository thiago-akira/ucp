module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, url } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  let fullPrompt = prompt;

  if (url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UCPBot/1.0)' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const html = await r.text();

      const jsonLds = [];
      const jsonLdRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
      let m;
      while ((m = jsonLdRe.exec(html)) !== null) jsonLds.push(m[1].trim());

      const visibleText = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 5000);

      const parts = [];
      if (jsonLds.length) parts.push(`=== DADOS ESTRUTURADOS (JSON-LD) ===\n${jsonLds.join('\n').slice(0, 3000)}`);
      parts.push(`=== TEXTO DO SITE ===\n${visibleText}`);
      fullPrompt = fullPrompt + '\n\n' + parts.join('\n\n');
    } catch (e) {
      fullPrompt = fullPrompt + '\n\n[Não foi possível acessar o site. Analise com base nos dados disponíveis.]';
    }
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY não configurada' });

  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-6';

  const llmRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': req.headers['referer'] || req.headers['origin'] || 'https://ucp.vercel.app',
      'X-Title': 'UCP Auditor',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: fullPrompt }],
      max_tokens: 1600,
    }),
  });

  if (!llmRes.ok) {
    const err = await llmRes.text();
    return res.status(llmRes.status).json({ error: err });
  }

  const data = await llmRes.json();
  const text = data.choices?.[0]?.message?.content || '';
  res.json({ text });
};
