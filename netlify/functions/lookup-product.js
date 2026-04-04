// netlify/functions/lookup-product.js
// Server-side product lookup via Anthropic API + web search
// Returns: { title, price, currency, source, imageUrl, available }

exports.handler = async function(event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  }

  let url, domain, urlHint;
  try {
    const body = JSON.parse(event.body);
    url = body.url;
    if (!url) throw new Error('Missing url');
    domain = new URL(url).hostname.replace('www.', '');
    const path = new URL(url).pathname;
    urlHint = path
      .replace(/\//g, ' ')
      .replace(/[-_]/g, ' ')
      .replace(/\.(html|htm|php|aspx)/gi, '')
      .replace(/\d{5,}/g, '')
      .trim()
      .slice(0, 120);
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request: ' + e.message }) };
  }

  const prompt = `You are a procurement assistant helping a concierge agency source products. Use web_search to find the price AND a product image URL for this item.

PRODUCT URL: ${url}
RETAILER: ${domain}
URL HINT: ${urlHint}

INSTRUCTIONS:
1. Search for the product using the URL or extract the product name from the URL path and search for it.
2. Find the current retail price.
3. Find a direct image URL for the product (preferably the main product photo from the retailer or manufacturer — must end in .jpg, .jpeg, .png, or .webp, or be a CDN image URL).
4. If the primary retailer blocks you, search for the same product on Amazon, Google Shopping, or the manufacturer site.

Respond ONLY with this exact JSON structure (no markdown, no explanation):
{
  "title": "Full product name",
  "price": 19.99,
  "currency": "USD",
  "source": "${domain}",
  "imageUrl": "https://example.com/product-image.jpg",
  "available": true
}

If you cannot find a price after searching, set price to null and available to false.
If you cannot find an image, set imageUrl to null.
Return ONLY the JSON object.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();

    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }

    // Collect all text blocks
    let raw = '';
    for (const b of (data.content || [])) {
      if (b.type === 'text') raw += b.text;
    }
    raw = raw.trim();

    // Parse JSON — direct first, then regex extraction
    let parsed = null;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      const match = raw.match(/\{[\s\S]*?"title"[\s\S]*?"price"[\s\S]*?\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { /* fall through */ }
      }
    }

    if (!parsed) throw new Error('Could not parse model response');

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed)
    };

  } catch (err) {
    // Return a degraded result rather than a hard error so the UI can show manual entry
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: urlHint
          ? urlHint.replace(/\b\w/g, c => c.toUpperCase()).trim()
          : 'Unknown Product',
        price: null,
        currency: 'USD',
        source: domain,
        imageUrl: null,
        available: false,
        _error: err.message
      })
    };
  }
};
