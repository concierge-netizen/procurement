// netlify/functions/load-quotes.js
// Lists and fetches quotes from concierge-netizen/procurement/quotes/

const OWNER = 'concierge-netizen';
const REPO  = 'procurement';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const TOKEN = process.env.GITHUB_TOKEN;
  if (!TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GITHUB_TOKEN env var not set' }) };

  const params = event.queryStringParameters || {};

  // DELETE ?quoteNumber=HANDS-Q-2026-123
  if (event.httpMethod === 'DELETE') {
    const qn = params.quoteNumber;
    if (!qn) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing quoteNumber' }) };
    const filePath = `quotes/${qn}.json`;
    const apiUrl   = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`;
    try {
      const check = await fetch(apiUrl, {
        headers: { 'Authorization': `token ${TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
      });
      if (!check.ok) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found' }) };
      const existing = await check.json();
      const del = await fetch(apiUrl, {
        method: 'DELETE',
        headers: {
          'Authorization': `token ${TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: `Delete quote ${qn}`, sha: existing.sha })
      });
      if (!del.ok) { const r = await del.json(); throw new Error(r.message || `GitHub ${del.status}`); }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, deleted: qn }) };
    } catch(err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  // GET ?quoteNumber=HANDS-Q-2026-123 — fetch a specific quote
  if (params.quoteNumber) {
    const filePath = `quotes/${params.quoteNumber}.json`;
    try {
      const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`, {
        headers: { 'Authorization': `token ${TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
      });
      if (!res.ok) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Quote not found' }) };
      const file    = await res.json();
      const content = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(content) };
    } catch(err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // GET — list all quotes
  try {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/quotes`, {
      headers: { 'Authorization': `token ${TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (res.status === 404) {
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify([]) };
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);

    const files     = await res.json();
    const jsonFiles = files.filter(f => f.name.endsWith('.json'));

    const quotes = await Promise.all(jsonFiles.map(async f => {
      try {
        const fr      = await fetch(f.url, { headers: { 'Authorization': `token ${TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } });
        const fd      = await fr.json();
        const content = JSON.parse(Buffer.from(fd.content, 'base64').toString('utf8'));
        const total   = (content.items || []).reduce((sum, it) => {
          const up = it.manualPrice != null ? it.manualPrice : (it.price || 0);
          return sum + up * (it.qty || 1);
        }, 0);
        return {
          quoteNumber: content.quoteNumber,
          name:        content.name || content.quoteNumber,
          clientName:  content.clientName || '',
          savedAt:     content.savedAt || 0,
          itemCount:   (content.items || []).length,
          total
        };
      } catch(e) { return null; }
    }));

    const valid = quotes.filter(Boolean).sort((a, b) => b.savedAt - a.savedAt);
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(valid) };

  } catch(err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
