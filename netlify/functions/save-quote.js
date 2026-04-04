// netlify/functions/save-quote.js
// Saves a quote as JSON to concierge-netizen/procurement/quotes/{quoteNumber}.json via GitHub API

const OWNER = 'concierge-netizen';
const REPO  = 'procurement';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  const TOKEN = process.env.GITHUB_TOKEN;
  if (!TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GITHUB_TOKEN env var not set' }) };

  let payload;
  try {
    payload = JSON.parse(event.body);
    if (!payload.quoteNumber) throw new Error('Missing quoteNumber');
  } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  const filePath   = `quotes/${payload.quoteNumber}.json`;
  const fileContent = Buffer.from(JSON.stringify(payload, null, 2)).toString('base64');
  const apiUrl     = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`;

  try {
    // Get existing SHA if file already exists (required for updates)
    let sha = null;
    const check = await fetch(apiUrl, {
      headers: {
        'Authorization': `token ${TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (check.ok) {
      const existing = await check.json();
      sha = existing.sha;
    }

    const body = {
      message: `Save quote ${payload.quoteNumber} — ${payload.name || 'untitled'}`,
      content: fileContent
    };
    if (sha) body.sha = sha;

    const put = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const result = await put.json();
    if (!put.ok) throw new Error(result.message || `GitHub API ${put.status}`);

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, quoteNumber: payload.quoteNumber, path: filePath })
    };

  } catch(err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
