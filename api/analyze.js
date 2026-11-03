// Auditor UCP: lê o site informado (opcional) e pede ao modelo a estruturação.
//
// A ferramenta é pública e sem login, então esta rota precisa se defender
// sozinha. Até 02/11/2026 ela aceitava qualquer texto de qualquer tamanho e
// repassava à OpenRouter com a chave do projeto (virava um "ChatGPT grátis"
// para quem descobrisse o endereço), e buscava qualquer URL, inclusive
// endereços internos. Agora:
//   - só aceita o prompt que a própria página monta (cabeçalho fixo) e com
//     tamanho limitado;
//   - só busca http(s) público, sem seguir redirecionamento para rede
//     interna, e lê no máximo 1,5 MB;
//   - não devolve a mensagem de erro bruta da OpenRouter.
// A trava definitiva de custo é o limite de crédito da chave na OpenRouter
// (configurado no painel deles), não este arquivo.

const ORIGENS = ['https://ucp.vercel.app'];
const CABECALHO = 'Você é um motor de estruturação de dados para comércio agêntico (UCP).';
const MAX_PROMPT = 12000;
const MAX_HTML = 1_500_000;

function origemOk(req) {
  const o = req.headers['origin'] || '';
  if (!o) return true; // navegadores mandam Origin em POST; ausência = ferramenta/curl, segue para as outras travas
  if (ORIGENS.includes(o)) return true;
  if (/^https:\/\/ucp-[a-z0-9-]+\.vercel\.app$/.test(o)) return true; // previews da Vercel
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}

function hostInterno(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('::ffff:')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

function urlPublica(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (hostInterno(u.hostname)) return null;
  return u;
}

// Busca seguindo no máximo 3 redirecionamentos, validando cada destino.
async function buscaHtml(raw, signal) {
  let u = urlPublica(raw);
  for (let i = 0; u && i < 4; i++) {
    const r = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UCPBot/1.0)' },
      redirect: 'manual',
      signal,
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      u = urlPublica(new URL(r.headers.get('location'), u).toString());
      continue;
    }
    const tamanho = Number(r.headers.get('content-length') || 0);
    if (tamanho > MAX_HTML) throw new Error('página grande demais');
    const txt = await r.text();
    return txt.slice(0, MAX_HTML);
  }
  throw new Error('endereço não permitido');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!origemOk(req)) return res.status(403).json({ error: 'origem não permitida' });

  const { prompt, url } = req.body || {};
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' });
  if (prompt.length > MAX_PROMPT) return res.status(413).json({ error: 'entrada longa demais' });
  if (!prompt.includes(CABECALHO)) return res.status(400).json({ error: 'pedido não reconhecido' });

  let fullPrompt = prompt;

  if (url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const html = await buscaHtml(url, controller.signal);
      clearTimeout(timeout);

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
      'HTTP-Referer': 'https://ucp.vercel.app',
      'X-Title': 'UCP Auditor',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: fullPrompt }],
      max_tokens: 1600,
    }),
  });

  if (!llmRes.ok) {
    console.error('[analyze] OpenRouter', llmRes.status, (await llmRes.text()).slice(0, 300));
    return res.status(502).json({ error: 'O modelo não respondeu agora. Tente de novo.' });
  }

  const data = await llmRes.json();
  const text = data.choices?.[0]?.message?.content || '';
  res.json({ text });
};
