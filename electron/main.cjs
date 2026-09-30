const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const zlib = require('zlib');

let mainWindow = null;
let pollTimer = null;
let syncing = false;

const state = {
  get file() { return path.join(app.getPath('userData'), 'mail2telegram-data.json'); },
};

function defaultData() {
  return {
    settings: { intervalMinutes: 5, autostart: true, background: true, telegramChatId: '', proxyEnabled: true, proxyHost: '', proxyPort: 3128, proxyUser: '', proxyPassword: '' },
    secrets: {},
    gmail: { email: '', refreshToken: '' },
    emails: [],
    posts: [],
    automations: []
  };
}

function loadData() {
  try {
    if (!fs.existsSync(state.file)) return defaultData();
    const d = JSON.parse(fs.readFileSync(state.file, 'utf8'));
    return { ...defaultData(), ...d, settings: { ...defaultData().settings, ...(d.settings || {}) } };
  } catch (_) { return defaultData(); }
}

function saveData(d) {
  fs.mkdirSync(path.dirname(state.file), { recursive: true });
  fs.writeFileSync(state.file, JSON.stringify(d, null, 2), 'utf8');
}

function encryptSecret(value) {
  if (!value) return '';
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(value).toString('base64');
  throw new Error('Безопасное хранилище Windows недоступно. Перезапустите приложение.');
}
function decryptSecret(value) {
  if (!value) return '';
  if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(value, 'base64'));
  throw new Error('Безопасное хранилище Windows недоступно.');
}
function getSecret(d, key) { return d.secrets[key] ? decryptSecret(d.secrets[key]) : ''; }
function setSecret(d, key, value) { d.secrets[key] = encryptSecret(value || ''); }

function decodeHttpBody(bodyBuffer, headers) {
  let body = Buffer.from(bodyBuffer || '');
  const transferEncoding = String(headers['transfer-encoding'] || '').toLowerCase();
  if (transferEncoding.includes('chunked')) {
    const chunks = [];
    let offset = 0;
    while (offset < body.length) {
      const lineEnd = body.indexOf('\r\n', offset);
      if (lineEnd < 0) break;
      const sizeText = body.slice(offset, lineEnd).toString('ascii').split(';', 1)[0].trim();
      const size = parseInt(sizeText, 16);
      if (!Number.isFinite(size) || size < 0) break;
      offset = lineEnd + 2;
      if (size === 0) break;
      if (offset + size > body.length) break;
      chunks.push(body.slice(offset, offset + size));
      offset += size + 2;
    }
    body = Buffer.concat(chunks);
  }

  const encoding = String(headers['content-encoding'] || '').toLowerCase();
  try {
    if (encoding.includes('gzip')) body = zlib.gunzipSync(body);
    else if (encoding.includes('deflate')) body = zlib.inflateSync(body);
    else if (encoding.includes('br')) body = zlib.brotliDecompressSync(body);
  } catch (_) {
    // If decompression fails, keep the original bytes so the caller gets a useful error.
  }
  return body.toString('utf8');
}

function parseHttpResponse(buffer) {
  const marker = buffer.indexOf(Buffer.from('\r\n\r\n'));
  if (marker < 0) return { code: 0, headers: {}, body: buffer.toString('utf8') };
  const head = buffer.slice(0, marker).toString('latin1');
  const bodyBuffer = buffer.slice(marker + 4);
  const lines = head.split('\r\n');
  const first = lines.shift() || '';
  const match = first.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i);
  const headers = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { code: match ? Number(match[1]) : 0, headers, body: decodeHttpBody(bodyBuffer, headers) };
}

function requestJson(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { ...(options.headers || {}) };
    if (data && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(data);
    const d = loadData();
    const proxy = d.settings && d.settings.proxyEnabled && d.settings.proxyHost ? {
      host: String(d.settings.proxyHost).trim(),
      port: Number(d.settings.proxyPort || 3128),
      user: String(d.settings.proxyUser || ''),
      password: String(d.settings.proxyPassword || '')
    } : null;

    if (!proxy) {
      const req = https.request({
        hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
        method: options.method || 'GET', headers
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const raw = decodeHttpBody(Buffer.concat(chunks), Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : String(v || '')])));
          let parsed;
          try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw }; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 1200)}`));
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
      return;
    }

    const proxySocket = net.connect(proxy.port, proxy.host);
    let settled = false;
    const fail = err => { if (!settled) { settled = true; try { proxySocket.destroy(); } catch (_) {} reject(err); } };
    proxySocket.setTimeout(30000, () => fail(new Error(`Прокси: тайм-аут подключения к ${proxy.host}:${proxy.port}`)));
    proxySocket.once('error', fail);
    proxySocket.once('connect', () => {
      let connectHeaders = `CONNECT ${u.hostname}:${u.port || 443} HTTP/1.1\r\nHost: ${u.hostname}:${u.port || 443}\r\nProxy-Connection: Keep-Alive\r\n`;
      if (proxy.user) {
        const auth = Buffer.from(`${proxy.user}:${proxy.password}`).toString('base64');
        connectHeaders += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      connectHeaders += '\r\n';
      proxySocket.write(connectHeaders);
    });

    let connectBuffer = Buffer.alloc(0);
    const onConnectData = chunk => {
      connectBuffer = Buffer.concat([connectBuffer, chunk]);
      const marker = connectBuffer.indexOf(Buffer.from('\r\n\r\n'));
      if (marker === -1) return;
      proxySocket.removeListener('data', onConnectData);
      const head = connectBuffer.slice(0, marker).toString('latin1');
      const statusLine = head.split('\r\n')[0] || '';
      const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i);
      const status = match ? Number(match[1]) : 0;
      if (status !== 200) {
        fail(new Error(`Прокси CONNECT: ${statusLine || 'неизвестный ответ'}`));
        return;
      }
      const leftover = connectBuffer.slice(marker + 4);
      const secure = tls.connect({ socket: proxySocket, servername: u.hostname, rejectUnauthorized: options.rejectUnauthorized !== false });
      secure.setTimeout(30000, () => { try { secure.destroy(new Error('HTTPS через прокси: тайм-аут')); } catch (_) {} });
      secure.once('error', fail);
      secure.once('secureConnect', () => {
        const requestPath = u.pathname + u.search;
        let request = `${options.method || 'GET'} ${requestPath} HTTP/1.1\r\nHost: ${u.hostname}${u.port && u.port !== '443' ? ':' + u.port : ''}\r\nConnection: close\r\n`;
        for (const [k, v] of Object.entries(headers)) request += `${k}: ${v}\r\n`;
        request += '\r\n';
        if (data) request += data;
        secure.write(request);

        let responseBuffer = leftover.length ? Buffer.from(leftover) : Buffer.alloc(0);
        secure.on('data', chunk => { responseBuffer = Buffer.concat([responseBuffer, Buffer.from(chunk)]); });
        secure.on('end', () => {
          if (settled) return;
          settled = true;
          const parsedResponse = parseHttpResponse(responseBuffer);
          let parsed;
          try { parsed = parsedResponse.body ? JSON.parse(parsedResponse.body) : {}; } catch (_) { parsed = { raw: parsedResponse.body }; }
          if (parsedResponse.code >= 200 && parsedResponse.code < 300) resolve(parsed);
          else reject(new Error(`HTTP ${parsedResponse.code}: ${parsedResponse.body.slice(0, 1200)}`));
        });
      });
    };
    proxySocket.on('data', onConnectData);
  });
}
function requestText(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : body;
    const headers = { ...(options.headers || {}) };
    if (data && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: options.method || 'GET', headers }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c);
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: raw, headers: res.headers }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

function base64urlDecode(s) {
  if (!s) return '';
  try { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (_) { return ''; }
}
function extractParts(part, acc = { text: '', html: '' }) {
  const mime = part && part.mimeType || '';
  const data = part && part.body && part.body.data || '';
  const decoded = base64urlDecode(data);
  if (mime === 'text/plain') acc.text += decoded;
  if (mime === 'text/html') acc.html += decoded;
  for (const p of (part && part.parts) || []) extractParts(p, acc);
  return acc;
}
function header(headers, name) {
  const h = (headers || []).find(x => String(x.name || '').toLowerCase() === name.toLowerCase());
  return h ? h.value || '' : '';
}

async function gmailAccessToken(d) {
  const cid = getSecret(d, 'google_client_id');
  const cs = getSecret(d, 'google_client_secret');
  const rt = getSecret(d, 'google_refresh_token');
  if (!cid || !cs || !rt) throw new Error('Gmail ещё не подключён. Сначала сохраните Google Client ID/Secret и нажмите «Подключить Gmail».');
  const form = new URLSearchParams({ client_id: cid, client_secret: cs, refresh_token: rt, grant_type: 'refresh_token' }).toString();
  const token = await requestJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, form);
  if (!token.access_token) throw new Error(`Google refresh error: ${JSON.stringify(token)}`);
  return token.access_token;
}

async function revokeGoogleToken(token) {
  if (!token) return;
  try {
    await requestJson('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, new URLSearchParams({ token }).toString());
  } catch (_) {
    // Revocation is best-effort. The next authorization attempt will still
    // request a fresh offline grant with explicit consent.
  }
}

function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(value).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function runGoogleOAuth(clientId, clientSecret) {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).on('error', reject));
  const port = server.address().port;
  const redirect = `http://127.0.0.1:${port}`;
  const scope = 'https://www.googleapis.com/auth/gmail.readonly';
  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = sha256Base64Url(codeVerifier);
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', clientId);
  auth.searchParams.set('redirect_uri', redirect);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', scope);
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('prompt', 'consent');
  auth.searchParams.set('include_granted_scopes', 'false');
  auth.searchParams.set('state', state);
  auth.searchParams.set('code_challenge', codeChallenge);
  auth.searchParams.set('code_challenge_method', 'S256');

  await shell.openExternal(auth.toString());

  const result = await new Promise((resolve, reject) => {
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { server.close(); } catch (_) {}
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Время ожидания Google OAuth истекло.')), 180000);
    server.on('request', (req, res) => {
      try {
        const u = new URL(req.url, redirect);
        const returnedState = u.searchParams.get('state');
        const code = u.searchParams.get('code');
        const error = u.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        res.end('<h2>Mail2Telegram: Gmail подключение завершено. Это окно можно закрыть.</h2>');
        if (returnedState !== state) return finish(reject, new Error('Google OAuth: неверный state. Попробуйте подключить Gmail ещё раз.'));
        if (error) return finish(reject, new Error(`Google OAuth: ${error}${u.searchParams.get('error_description') ? ` — ${u.searchParams.get('error_description')}` : ''}`));
        if (!code) return finish(reject, new Error('Google не вернул OAuth code.'));
        finish(resolve, { code, redirect, codeVerifier });
      } catch (e) { finish(reject, e); }
    });
  });

  const form = new URLSearchParams({
    code: result.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: result.redirect,
    grant_type: 'authorization_code',
    code_verifier: result.codeVerifier
  }).toString();
  return requestJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, form);
}

async function connectGmail() {
  const d = loadData();
  const clientId = getSecret(d, 'google_client_id');
  const clientSecret = getSecret(d, 'google_client_secret');
  if (!clientId) throw new Error('Сначала сохраните Google OAuth Client ID.');
  if (!clientSecret) throw new Error('Сначала сохраните Google OAuth Client Secret.');

  // First attempt. We explicitly request offline consent so Google can issue a refresh token.
  let token = await runGoogleOAuth(clientId, clientSecret);

  // Google may omit refresh_token when this account has an existing grant for this OAuth client.
  // If there is no previously saved token, revoke the newly issued access token and repeat the
  // authorization once. This clears the old grant and makes Google issue a fresh refresh token.
  if (!token.refresh_token && !getSecret(d, 'google_refresh_token') && token.access_token) {
    await revokeGoogleToken(token.access_token);
    token = await runGoogleOAuth(clientId, clientSecret);
  }

  if (!token.refresh_token) {
    const existingRefresh = getSecret(d, 'google_refresh_token');
    if (!existingRefresh) {
      const details = token.error_description || token.error || `ответ содержит поля: ${Object.keys(token).join(', ') || 'нет'}`;
      throw new Error(`Google не вернул refresh token (${details}). Если окно Google было закрыто или разрешение не подтверждено, нажмите «Подключить Gmail» ещё раз.`);
    }
    // Google legitimately omits a new refresh token for an existing grant.
    // Keep the already stored token instead of destroying it.
  } else {
    setSecret(d, 'google_refresh_token', token.refresh_token);
  }

  if (!token.access_token) throw new Error(`Google не вернул access token: ${JSON.stringify(token).slice(0, 1000)}`);
  const profile = await requestJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });
  d.gmail.email = profile.emailAddress || '';
  saveData(d);
  return d.gmail.email || 'Gmail подключён';
}

async function syncGmail(d) {
  if (!d.gmail.email) return 0;
  const access = await gmailAccessToken(d);
  const list = await requestJson('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=newer_than:7d', { headers: { Authorization: `Bearer ${access}` } });
  let count = 0;
  for (const item of (list.messages || [])) {
    const exists = d.emails.some(e => e.provider_id === item.id);
    if (exists) continue;
    const m = await requestJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`, { headers: { Authorization: `Bearer ${access}` } });
    const h = m.payload && m.payload.headers || [];
    const parts = extractParts(m.payload || {});
    const received = new Date(Number(m.internalDate || Date.now())).toISOString();
    d.emails.push({ id: crypto.randomUUID(), provider_id: m.id, thread_id: m.threadId || '', sender: header(h, 'from'), recipient: header(h, 'to'), subject: header(h, 'subject'), body_text: parts.text, body_html: parts.html, received_at: received, status: 'received' });
    count++;
  }
  return count;
}

async function makePost(d, subject, sender, body, customPrompt) {
  const key = getSecret(d, 'openai_api_key');
  if (!key) throw new Error('OpenAI API key не задан.');
  const prompt = customPrompt && customPrompt.trim() ? customPrompt : 'Сделай короткий пост для Telegram на русском языке по содержимому письма. Не выдумывай факты. Верни JSON: {"title":"...","content":"..."}. Заголовок до 100 символов, текст до 3500 символов.';
  const input = `${prompt}\n\nОтправитель: ${sender}\nТема: ${subject}\n\nПисьмо:\n${body}`;
  const v = await requestJson('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }, { model: 'gpt-5.6-luna', input, max_output_tokens: 1200 });
  let text = v.output_text;
  if (!text && Array.isArray(v.output)) {
    for (const item of v.output) for (const c of item.content || []) if (c.text) { text = c.text; break; }
  }
  if (!text) throw new Error(`OpenAI: не найден текст ответа: ${JSON.stringify(v).slice(0, 1500)}`);
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    const o = JSON.parse(cleaned);
    return { title: o.title || subject || 'Без заголовка', content: o.content || cleaned };
  } catch (_) { return { title: subject || 'Без заголовка', content: cleaned }; }
}

function matchesAutomation(a, sender, subject, body) {
  const hay = `${subject} ${body}`.toLowerCase();
  if (a.sender_filter && !sender.toLowerCase().includes(a.sender_filter.toLowerCase())) return false;
  if (a.subject_filter && !subject.toLowerCase().includes(a.subject_filter.toLowerCase())) return false;
  if (a.keywords) for (const k of a.keywords.split(',').map(x => x.trim()).filter(Boolean)) if (!hay.includes(k.toLowerCase())) return false;
  return true;
}

async function sendTelegram(d, text) {
  const token = getSecret(d, 'telegram_bot_token');
  const chat = d.settings.telegramChatId;
  if (!token) throw new Error('Telegram Bot Token не задан.');
  if (!chat) throw new Error('Telegram Chat ID / @channel не задан.');
  const v = await requestJson(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, { chat_id: chat, text, disable_web_page_preview: false });
  if (!v.ok) throw new Error(JSON.stringify(v));
  return String(v.result && v.result.message_id || '');
}

async function testTelegram() {
  const d = loadData();
  const token = getSecret(d, 'telegram_bot_token');
  const chat = d.settings.telegramChatId;
  if (!token) throw new Error('Telegram Bot Token не задан.');
  if (!chat) throw new Error('Telegram Chat ID / @channel не задан.');
  const me = await requestJson(`https://api.telegram.org/bot${token}/getMe`);
  if (!me.ok) throw new Error(JSON.stringify(me));
  const cv = await requestJson(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chat)}`);
  if (!cv.ok) throw new Error(JSON.stringify(cv));
  return cv.result && (cv.result.title || cv.result.username) || 'Telegram подключён';
}

async function syncAndProcess() {
  if (syncing) return { emails_synced: 0, posts_created: 0, busy: true };
  syncing = true;
  try {
    const d = loadData();
    const synced = await syncGmail(d);
    let generated = 0;
    for (const e of d.emails) {
      if (d.posts.some(p => p.email_id === e.id)) continue;
      const body = e.body_text || e.body_html || '';
      for (const a of d.automations.filter(x => x.enabled !== false)) {
        if (!matchesAutomation(a, e.sender || '', e.subject || '', body)) continue;
        const made = await makePost(d, e.subject || '', e.sender || '', body, a.prompt);
        const post = { id: crypto.randomUUID(), email_id: e.id, title: made.title, content: made.content, status: a.mode === 'automatic' ? 'queued' : 'draft', source: e.sender || 'Gmail', created_at: new Date().toISOString() };
        d.posts.unshift(post); generated++;
        if (a.mode === 'automatic') {
          try { const mid = await sendTelegram(d, post.content); post.status = 'published'; post.telegram_message_id = mid; post.published_at = new Date().toISOString(); } catch (err) { post.status = 'queued'; post.error = String(err.message || err); }
        }
        break;
      }
    }
    saveData(d);
    return { emails_synced: synced, posts_created: generated };
  } finally { syncing = false; }
}

function configState(d) {
  return { gmail: !!d.gmail.email && !!getSecret(d, 'google_refresh_token'), openai: !!getSecret(d, 'openai_api_key'), telegram: !!getSecret(d, 'telegram_bot_token') && !!d.settings.telegramChatId };
}

ipcMain.handle('app_status', async () => 'Локальное ядро Electron запущено');
ipcMain.handle('get_config_state', async () => configState(loadData()));
ipcMain.handle('get_settings', async () => {
  const d = loadData();
  return {
    clientId: getSecret(d, 'google_client_id'),
    hasClientSecret: !!getSecret(d, 'google_client_secret'),
    hasOpenaiApiKey: !!getSecret(d, 'openai_api_key'),
    hasTelegramBotToken: !!getSecret(d, 'telegram_bot_token'),
    telegramChatId: d.settings.telegramChatId || '',
    proxyEnabled: !!d.settings.proxyEnabled,
    proxyHost: d.settings.proxyHost || '',
    proxyPort: Number(d.settings.proxyPort || 3128),
    proxyUser: d.settings.proxyUser || '',
    hasProxyPassword: !!d.settings.proxyPassword,
    intervalMinutes: Number(d.settings.intervalMinutes || 5)
  };
});
ipcMain.handle('list_emails', async () => loadData().emails.slice(0, 100));
ipcMain.handle('list_posts', async () => loadData().posts.slice(0, 100));
ipcMain.handle('save_credentials', async (_event, input = {}) => {
  const d = loadData();
  // Empty fields mean 'leave the saved value unchanged'. This prevents the UI
  // from wiping credentials when it is opened or when only one setting changes.
  if (input.clientId) setSecret(d, 'google_client_id', String(input.clientId).trim());
  if (input.clientSecret) setSecret(d, 'google_client_secret', String(input.clientSecret));
  if (input.openaiApiKey) setSecret(d, 'openai_api_key', String(input.openaiApiKey).trim());
  if (input.telegramBotToken) setSecret(d, 'telegram_bot_token', String(input.telegramBotToken).trim());
  if (input.telegramChatId !== undefined && String(input.telegramChatId).trim()) d.settings.telegramChatId = String(input.telegramChatId).trim();
  saveData(d); return true;
});
ipcMain.handle('connect_gmail', async () => connectGmail());
ipcMain.handle('test_telegram', async () => testTelegram());
ipcMain.handle('sync_now', async () => syncAndProcess());
ipcMain.handle('create_post_from_email', async (_event, args = {}) => {
  const d = loadData();
  const email = d.emails.find(e => e.id === args.emailId);
  if (!email) throw new Error('Письмо не найдено');
  const existing = d.posts.find(p => p.email_id === email.id);
  if (existing) return existing.id;
  const automation = d.automations.find(a => a.enabled !== false && matchesAutomation(a, email.sender || '', email.subject || '', email.body_text || email.body_html || ''));
  const prompt = automation ? automation.prompt : '';
  const body = email.body_text || email.body_html || '';
  const made = await makePost(d, email.subject || '', email.sender || '', body, prompt);
  const post = {
    id: crypto.randomUUID(),
    email_id: email.id,
    title: made.title,
    content: made.content,
    status: 'draft',
    source: email.sender || 'Gmail',
    created_at: new Date().toISOString()
  };
  d.posts.unshift(post);
  saveData(d);
  return post.id;
});
ipcMain.handle('publish_post', async (_event, args = {}) => {
  const d = loadData(); const post = d.posts.find(p => p.id === args.postId);
  if (!post) throw new Error('Пост не найден');
  if (post.status === 'published') return post.telegram_message_id || 'already-published';
  const mid = await sendTelegram(d, post.content); post.status = 'published'; post.telegram_message_id = mid; post.published_at = new Date().toISOString(); saveData(d); return mid;
});
ipcMain.handle('save_automation', async (_event, input = {}) => {
  const d = loadData();
  const a = { id: input.id || crypto.randomUUID(), name: input.name || 'Automation', mode: input.mode || 'approval', sender_filter: input.sender_filter || '', subject_filter: input.subject_filter || '', keywords: input.keywords || '', prompt: input.prompt || '', enabled: true };
  const i = d.automations.findIndex(x => x.id === a.id);
  if (i >= 0) d.automations[i] = a; else d.automations.push(a);
  saveData(d); return a.id;
});
ipcMain.handle('save_settings', async (_event, input = {}) => {
  const d = loadData();
  if (input.intervalMinutes) d.settings.intervalMinutes = Math.max(1, Number(input.intervalMinutes));
  if (typeof input.autostart === 'boolean') d.settings.autostart = input.autostart;
  if (typeof input.background === 'boolean') d.settings.background = input.background;
  if (typeof input.proxyEnabled === 'boolean') d.settings.proxyEnabled = input.proxyEnabled;
  if (input.proxyHost !== undefined) d.settings.proxyHost = String(input.proxyHost || '').trim();
  if (input.proxyPort !== undefined) d.settings.proxyPort = Math.max(1, Number(input.proxyPort || 3128));
  if (input.proxyUser !== undefined) d.settings.proxyUser = String(input.proxyUser || '');
  if (input.proxyPassword !== undefined && String(input.proxyPassword || '')) d.settings.proxyPassword = String(input.proxyPassword);
  saveData(d); startPolling(); return true;
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const minutes = Math.max(1, Number(loadData().settings.intervalMinutes || 5));
  pollTimer = setInterval(() => { syncAndProcess().catch(() => {}); }, minutes * 60 * 1000);
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1180, height: 760, minWidth: 900, minHeight: 620, resizable: true, title: 'Mail2Telegram', webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') } });
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => { loadData(); createWindow(); startPolling(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
