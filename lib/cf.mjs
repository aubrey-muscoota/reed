// Small client for the Cloudflare REST API: Workers AI, Vectorize and D1.
// Scripts run in GitHub Actions with CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID; the Worker itself only reads D1 through its binding.

const BASE = 'https://api.cloudflare.com/client/v4';

export function cloudflare({ token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID, fetchImpl = fetch } = {}) {
  if (!token || !account) throw new Error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');
  const acct = `${BASE}/accounts/${account}`;

  async function call(path, { method = 'POST', body, contentType = 'application/json', tries = 4 } = {}) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetchImpl(`${acct}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && { 'Content-Type': contentType }) },
        body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body,
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success !== false) return json.result;
      const retry = res.status === 429 || res.status >= 500;
      if (!retry || attempt >= tries) {
        const msg = (json.errors ?? []).map(e => `${e.code}: ${e.message}`).join('; ') || res.statusText;
        const err = new Error(`Cloudflare ${method} ${path} failed (${res.status}): ${msg}`);
        err.status = res.status;
        throw err;
      }
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }

  return {
    call,
    ai: (model, input) => call(`/ai/run/${model}`, { body: input }),
    async embed(model, texts) {
      const r = await call(`/ai/run/${model}`, { body: { text: texts } });
      return r.data;
    },
    async chat(model, messages, opts = {}) {
      const r = await call(`/ai/run/${model}`, { body: { messages, max_tokens: 1200, temperature: 0, ...opts } });
      // Older models answer in `response`; OpenAI-style models in `choices`.
      if (typeof r.response === 'string') return r.response;
      if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
      return r.choices?.[0]?.message?.content ?? '';
    },
    vectorize: {
      get: name => call(`/vectorize/v2/indexes/${name}`, { method: 'GET' }),
      create: (name, dimensions) => call(`/vectorize/v2/indexes`, { body: { name, config: { dimensions, metric: 'cosine' } } }),
      upsert: (name, vectors) => call(`/vectorize/v2/indexes/${name}/upsert`, {
        body: vectors.map(v => JSON.stringify(v)).join('\n'),
        contentType: 'application/x-ndjson',
      }),
      query: (name, vector, topK = 20) => call(`/vectorize/v2/indexes/${name}/query`, {
        body: { vector, topK, returnMetadata: 'all', returnValues: false },
      }).then(r => r.matches ?? []),
    },
    d1: {
      list: name => call(`/d1/database?name=${encodeURIComponent(name)}`, { method: 'GET' }),
      create: name => call(`/d1/database`, { body: { name } }),
      async query(id, sql, params = []) {
        const r = await call(`/d1/database/${id}/query`, { body: { sql, params } });
        return r?.[0]?.results ?? [];
      },
    },
  };
}

// Pull the first JSON object or array out of a model's answer.
export function parseJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/g, '');
  const start = cleaned.search(/[[{]/);
  if (start < 0) throw new Error('No JSON in model output');
  const open = cleaned[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
  }
  throw new Error('Unclosed JSON in model output');
}
