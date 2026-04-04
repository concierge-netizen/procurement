// netlify/functions/lookup-product.js
// Two-pass lookup: 1) price + title, 2) dedicated image search
// Images proxied server-side — no CORS issues in browser

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

  let url, domain, urlHint;
  try {
    const body = JSON.parse(event.body);
    url = body.url;
    if (!url) throw new Error('Missing url');
    domain = new URL(url).hostname.replace('www.', '');
    urlHint = new URL(url).pathname
      .replace(/\//g, ' ').replace(/[-_]/g, ' ')
      .replace(/\.(html|htm|php|aspx)/gi, '').replace(/\d{5,}/g, '')
      .trim().slice(0, 120);
  } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  async function askClaude(prompt, maxTokens) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens || 1024,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    let text = '';
    for (const b of (data.content || [])) if (b.type === 'text') text += b.text;
    return text.trim();
  }

  function extractJSON(raw) {
    try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch {}
    const m = raw.match(/\{[\s\S]*?"title"[\s\S]*?"price"[\s\S]*?\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }

  async function proxyImage(imageUrl) {
    if (!imageUrl) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(imageUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }
      });
      clearTimeout(timer);
      if (!res.ok) return imageUrl;
      const ct = res.headers.get('content-type') || 'image/jpeg';
      if (!ct.startsWith('image/')) return imageUrl;
      const buf = await res.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      // If over ~400KB encoded, just return the URL and let browser try
      if (b64.length > 550000) return imageUrl;
      return `data:${ct};base64,${b64}`;
    } catch {
      return imageUrl;
    }
  }

  try {
    // Pass 1: price, title, and first attempt at image
    const p1 = await askClaude(
      `You are a procurement assistant. Use web_search to find the price and a product image for this item.

URL: ${url}
RETAILER: ${domain}
HINT: ${urlHint}

Steps:
1. Search the URL or product name for price and title
2. Also find the main product photo — a direct CDN image URL (jpg/png/webp)
3. If the retailer blocks you, search on Amazon or Google Shopping instead

Return ONLY this JSON (no markdown, no explanation):
{"title":"Full product name","price":29.99,"currency":"USD","source":"${domain}","imageUrl":"https://cdn.example.com/product.jpg","available":true}

If no price: price=null, available=false. If no image: imageUrl=null.`
    );
    const r1 = extractJSON(p1);
    const title = r1?.title || urlHint.replace(/\b\w/g, c => c.toUpperCase()).trim() || 'Unknown Product';
    const price = r1?.price || null;
    let imageUrl = r1?.imageUrl || null;

    // Pass 2: dedicated image search if pass 1 missed it
    if (!imageUrl && title && title !== 'Unknown Product') {
      const p2 = await askClaude(
        `Find a product photo image URL for: "${title}"

Search for this product and find a direct image URL (jpg, png, webp, or CDN link).
Look on the manufacturer website, Amazon, or major retailers.

Return ONLY: {"imageUrl":"https://direct-link-to-image.jpg"}
If not found: {"imageUrl":null}`,
        512
      );
      const r2 = extractJSON(p2);
      if (r2?.imageUrl) imageUrl = r2.imageUrl;
    }

    // Pass 3: proxy image through server to eliminate CORS
    const proxied = await proxyImage(imageUrl);

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, price, currency: r1?.currency || 'USD', source: domain, imageUrl: proxied, available: price != null })
    };

  } catch(err) {
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: urlHint ? urlHint.replace(/\b\w/g, c => c.toUpperCase()).trim() : 'Unknown Product',
        price: null, currency: 'USD', source: domain, imageUrl: null, available: false, _error: err.message
      })
    };
  }
};
