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
    const data = body == null ? null : (Buffer.isBuffer(body) ? body : (typeof body === 'string' ? body : JSON.stringify(body)));
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
    proxySocket.setTimeout(90000, () => fail(new Error(`Прокси: тайм-аут подключения к ${proxy.host}:${proxy.port}`)));
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
      secure.setTimeout(90000, () => { try { secure.destroy(new Error('HTTPS через прокси: тайм-аут')); } catch (_) {} });
      secure.once('error', fail);
      secure.once('secureConnect', () => {
        const requestPath = u.pathname + u.search;
        let request = `${options.method || 'GET'} ${requestPath} HTTP/1.1\r\nHost: ${u.hostname}${u.port && u.port !== '443' ? ':' + u.port : ''}\r\nConnection: close\r\n`;
        for (const [k, v] of Object.entries(headers)) request += `${k}: ${v}\r\n`;
        request += '\r\n';
        const headBuffer = Buffer.from(request, 'utf8');
        secure.write(data ? Buffer.concat([headBuffer, Buffer.from(data)]) : headBuffer);

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
function decodeHtmlEntities(value) {
  return String(value || '')
    // Common named entities used by HTML email templates. In particular,
    // &nbsp; and &zwnj; must not leak into Telegram as literal text.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&zwnj;/gi, '')
    .replace(/&zwj;/gi, '')
    .replace(/&thinsp;/gi, ' ')
    .replace(/&ensp;/gi, ' ')
    .replace(/&emsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code) => {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    });
}
function extractParts(part, acc = { text: '', html: '', links: [], images: [] }) {
  const mime = part && part.mimeType || '';
  const data = part && part.body && part.body.data || '';
  const decoded = base64urlDecode(data);
  if (mime === 'text/plain') acc.text += decoded;
  if (mime === 'text/html') acc.html += decoded;
  if (mime.startsWith('image/')) {
    acc.images.push({
      mimeType: mime,
      filename: part.filename || 'image',
      attachmentId: part.body && part.body.attachmentId || '',
      contentId: header(part.headers || [], 'Content-ID').replace(/^<|>$/g, ''),
      data: data || ''
    });
  }
  for (const p of (part && part.parts) || []) extractParts(p, acc);
  return acc;
}
function enrichEmail(parts) {
  const html = parts.html || '';
  const links = [];
  const images = Array.isArray(parts.images) ? parts.images.slice() : [];
  const addLink = href => {
    href = decodeHtmlEntities(href).trim();
    if (!href || !/^https?:\/\//i.test(href)) return;
    if (!links.includes(href)) links.push(href);
  };
  html.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, href) => { addLink(href); return _; });
  html.replace(/<img\b[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, src) => {
    src = decodeHtmlEntities(src).trim();
    if (/^https?:\/\//i.test(src)) {
      if (!images.some(x => x.url === src)) images.push({ url: src, mimeType: 'image/*', filename: 'image' });
    } else if (/^cid:/i.test(src)) {
      const cid = src.slice(4).replace(/^<|>$/g, '');
      const found = images.find(x => x.contentId === cid);
      if (found) found.inline = true;
    }
    return _;
  });
  return { links, images };
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
    const existing = d.emails.find(e => e.provider_id === item.id);
    if (existing && existing.rich_extracted && existing.body_html && Array.isArray(existing.images) && existing.images.length) continue;
    const m = await requestJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`, { headers: { Authorization: `Bearer ${access}` } });
    const h = m.payload && m.payload.headers || [];
    const parts = extractParts(m.payload || {});
    const rich = enrichEmail(parts);
    const received = new Date(Number(m.internalDate || Date.now())).toISOString();
    if (existing) {
      existing.body_text = existing.body_text || parts.text;
      existing.body_html = existing.body_html || parts.html;
      existing.links = rich.links;
      existing.images = rich.images;
      existing.rich_extracted = true;
      continue;
    }
    d.emails.push({ id: crypto.randomUUID(), provider_id: m.id, thread_id: m.threadId || '', sender: header(h, 'from'), recipient: header(h, 'to'), subject: header(h, 'subject'), body_text: parts.text, body_html: parts.html, links: rich.links, images: rich.images, rich_extracted: true, received_at: received, status: 'received' });
    count++;
  }
  return count;
}

function uniqueUrls(urls) {
  return Array.from(new Set((urls || []).filter(u => /^https?:\/\//i.test(String(u || '')))));
}
function stripEmailFooter(body) {
  const text = String(body || '');
  const marker = /Хотите\s+уточнить\s+детали,?\s*напишите\s+нам\s*[—–-]?/i;
  const m = text.search(marker);
  return m >= 0 ? text.slice(0, m).trim() : text.trim();
}
function cutEmailFooterHtml(html) {
  const source = String(html || '');
  // Remove only the correspondence/footer section beginning with this phrase.
  // Footnotes such as "* Доступ предоставляется..." are intentionally kept.
  const marker = /Хотите\s+уточнить\s+детали,?\s*напишите\s+нам\s*[—–-]?/i;
  const m = source.search(marker);
  return m >= 0 ? source.slice(0, m) : source;
}
function escapeTelegramHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function extractImportantFootnoteHtml(html) {
  const source = String(html || '');
  // Keep the offer footnote associated with the access button. It is content,
  // not the removable mail footer.
  const m = source.match(/\*\s*Доступ\s+предоставляется[\s\S]*?Не\s+пропустите\s+звонок!?/i);
  if (!m) return '';
  return String(m[0]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function emailHtmlToTelegramHtml(html) {
  const original = String(html || '');
  let source = cutEmailFooterHtml(original);
  const importantFootnote = extractImportantFootnoteHtml(source);
  // Remove non-content markup, images and tracking pixels. Images are sent separately.
  source = source.replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<\/(p|div|li|h[1-6]|tr|table|section|article)>/gi, '\n')
    .replace(/<\/(ul|ol)>/gi, '\n');
  const anchors = [];
  source = source.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
    href = decodeHtmlEntities(href).trim();
    const rawAnchor = String(_ || '');
    const cleanLabel = decodeHtmlEntities(String(label || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!/^https?:\/\//i.test(href) || !cleanLabel) return cleanLabel;
    const token = `@@MAIL2TG_LINK_${anchors.length}@@`;
    const isAccessButton = /Получить\s+доступ/i.test(cleanLabel);
    anchors.push({ token, href, label: cleanLabel, isAccessButton });
    return token;
  });
  source = decodeHtmlEntities(source).replace(/<[^>]+>/g, ' ');
  // Remove the newsletter preheader "Готовые алгоритмы". It is not part of the article body.
  source = source.replace(/^\s*Готовые\s+алгоритмы\s*/i, '');
  source = source.replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ');
  source = source.split('\n').map(x => x.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  let out = escapeTelegramHtml(source);
  // The actual article heading is kept from the source email and rendered bold.
  const articleHeading = 'Отчётность и уплата за 9 месяцев: что нового?';
  const escapedHeading = escapeTelegramHtml(articleHeading);
  out = out.replace(escapedHeading, `<b>${escapedHeading}</b>`);
  for (const a of anchors) {
    // Telegram HTML has no arbitrary button element. Keep the access action
    // at the exact place where the email had its button and make it a bold
    // clickable link inside the post body (not a separate reply keyboard).
    const rendered = a.isAccessButton
      ? `<a href="${escapeTelegramHtml(a.href)}"><b>${escapeTelegramHtml(a.label)}</b></a>`
      : `<a href="${escapeTelegramHtml(a.href)}">${escapeTelegramHtml(a.label)}</a>`;
    out = out.replace(a.token, rendered);
  }
  if (importantFootnote) {
    const normalized = importantFootnote.replace(/\s+/g, ' ').trim();
    const normalizedOut = out.replace(/\s+/g, ' ').trim();
    if (!normalizedOut.includes(normalized)) out = `${out}\n\n${escapeTelegramHtml(importantFootnote)}`;
  }
  return out;
}
function extractAccessButton(html) {
  const source = String(html || '');
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(source))) {
    const label = decodeHtmlEntities(String(m[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (/Получить\s+доступ/i.test(label) && /^https?:\/\//i.test(m[1])) return decodeHtmlEntities(m[1]);
  }
  return '';
}
function publishableEmailImages(email) {
  const images = Array.isArray(email && email.images) ? email.images : [];
  // Exactly the first real content image. The second portrait and tracking pixel are not published.
  return images.filter(x => !/read\.sendsay\.ru\/1\.gif/i.test(String(x.url || ''))).slice(0, 1);
}
function linksForPost(email) {
  const html = cutEmailFooterHtml(email && email.body_html || '');
  const links = [];
  html.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, href) => {
    href = decodeHtmlEntities(href).trim();
    if (/^https?:\/\//i.test(href) && !links.includes(href)) links.push(href);
    return _;
  });
  return links.length ? links : (email && email.links || []);
}
async function requestBinary(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const d = loadData();
    const proxy = d.settings && d.settings.proxyEnabled && d.settings.proxyHost ? {
      host: String(d.settings.proxyHost).trim(), port: Number(d.settings.proxyPort || 3128),
      user: String(d.settings.proxyUser || ''), password: String(d.settings.proxyPassword || '')
    } : null;
    const finish = (res, chunks) => {
      const headers = Object.fromEntries(Object.entries(res.headers || {}).map(([k,v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : String(v || '')]));
      const buf = Buffer.concat(chunks);
      let out = buf;
      const enc = String(headers['content-encoding'] || '').toLowerCase();
      try { if (enc.includes('gzip')) out = zlib.gunzipSync(buf); else if (enc.includes('deflate')) out = zlib.inflateSync(buf); } catch (_) {}
      if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) resolve({ statusCode: res.statusCode, headers, data: out });
      else reject(new Error(`HTTP ${res.statusCode || 0} при загрузке изображения`));
    };
    if (!proxy) {
      const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: options.method || 'GET', headers: options.headers || {} }, res => {
        const chunks=[]; res.on('data', c=>chunks.push(Buffer.from(c))); res.on('end',()=>finish(res,chunks));
      });
      req.on('error',reject); req.end(); return;
    }
    const socket = net.connect(proxy.port, proxy.host);
    let settled=false; const fail=e=>{if(!settled){settled=true;try{socket.destroy();}catch(_){}reject(e);}};
    socket.setTimeout(90000,()=>fail(new Error('Прокси: тайм-аут загрузки изображения'))); socket.once('error',fail);
    socket.once('connect',()=>{
      let h=`CONNECT ${u.hostname}:${u.port||443} HTTP/1.1\r\nHost: ${u.hostname}:${u.port||443}\r\nProxy-Connection: Keep-Alive\r\n`;
      if(proxy.user) h+=`Proxy-Authorization: Basic ${Buffer.from(`${proxy.user}:${proxy.password}`).toString('base64')}\r\n`;
      h+='\r\n'; socket.write(h);
    });
    let cb=Buffer.alloc(0); const onData=chunk=>{
      cb=Buffer.concat([cb,Buffer.from(chunk)]); const marker=cb.indexOf(Buffer.from('\r\n\r\n')); if(marker<0)return;
      socket.removeListener('data',onData); const status=(cb.slice(0,marker).toString('latin1').match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)||[])[1];
      if(Number(status)!==200){fail(new Error(`Прокси CONNECT: ${status||0}`));return;}
      const secure=tls.connect({socket,servername:u.hostname,rejectUnauthorized:true}); secure.once('error',fail); secure.setTimeout(90000,()=>fail(new Error('HTTPS через прокси: тайм-аут загрузки изображения')));
      secure.once('secureConnect',()=>{
        let req=`GET ${u.pathname+u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\nConnection: close\r\nUser-Agent: Mozilla/5.0\r\n`;
        for(const [k,v] of Object.entries(options.headers||{})) req+=`${k}: ${v}\r\n`; req+='\r\n'; secure.write(req);
        let rb=Buffer.alloc(0); secure.on('data',c=>rb=Buffer.concat([rb,Buffer.from(c)])); secure.on('end',()=>{
          if(settled)return; settled=true; const marker=rb.indexOf(Buffer.from('\r\n\r\n')); if(marker<0){reject(new Error('Некорректный ответ изображения'));return;}
          const lines=rb.slice(0,marker).toString('latin1').split('\r\n'); const first=lines.shift()||''; const m=first.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i); const headers={};
          for(const line of lines){const i=line.indexOf(':');if(i>0)headers[line.slice(0,i).trim().toLowerCase()]=line.slice(i+1).trim();}
          const fake={statusCode:m?Number(m[1]):0,headers}; finish(fake,[rb.slice(marker+4)]);
        });
      });
    }; socket.on('data',onData);
  });
}
function appendOriginalLinks(content, links) { return String(content || '').trim(); }
function splitTelegramHtml(html, max = 1024) {
  const text = String(html || '');
  if (text.length <= max) return [text, ''];
  const candidates = [text.lastIndexOf('\n\n', max), text.lastIndexOf('\n', max), text.lastIndexOf('</a>', max) + 4];
  let cut = Math.max(...candidates.filter(x => x > 0));
  if (cut < 200) cut = max;
  // Never cut inside an HTML tag.
  const lt = text.lastIndexOf('<', cut);
  const gt = text.lastIndexOf('>', cut);
  if (lt > gt) cut = gt;
  if (cut <= 0) cut = max;
  return [text.slice(0, cut).trim(), text.slice(cut).trim()];
}
async function gmailAttachmentBuffer(d, email, image) {
  if (image.data) return Buffer.from(image.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!image.attachmentId) return null;
  const access = await gmailAccessToken(d);
  const v = await requestJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(email.provider_id)}/attachments/${encodeURIComponent(image.attachmentId)}`, { headers: { Authorization: `Bearer ${access}` } });
  if (!v.data) return null;
  return Buffer.from(v.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function makeMultipart(fields, file) {
  const boundary = `----Mail2Telegram${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${String(file.filename || 'image.jpg').replace(/"/g, '')}"\r\nContent-Type: ${file.mimeType || 'application/octet-stream'}\r\n\r\n`, 'utf8'));
  chunks.push(file.data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
async function sendTelegramPhoto(d, image, caption) {
  const token = getSecret(d, 'telegram_bot_token');
  const chat = d.settings.telegramChatId;
  if (!token || !chat) throw new Error('Telegram не настроен.');
  // The access action is part of the post body now, not a separate Telegram keyboard.
  const fields = { chat_id: chat, caption: String(caption || '').slice(0, 1024), parse_mode: 'HTML' };
  if (image.data) {
    const form = makeMultipart(fields, { field: 'photo', filename: image.filename || 'image.jpg', mimeType: image.mimeType || 'image/jpeg', data: image.data });
    const v = await requestJson(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': form.contentType } }, form.body);
    if (!v.ok) throw new Error(JSON.stringify(v));
    return String(v.result && v.result.message_id || '');
  }
  if (image.url) {
    try {
      const downloaded = await requestBinary(image.url);
      if (downloaded.data && downloaded.data.length) {
        const form = makeMultipart(fields, { field: 'photo', filename: image.filename || 'image.jpg', mimeType: image.mimeType || downloaded.headers['content-type'] || 'image/jpeg', data: downloaded.data });
        const v = await requestJson(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': form.contentType } }, form.body);
        if (!v.ok) throw new Error(JSON.stringify(v));
        return String(v.result && v.result.message_id || '');
      }
    } catch (_) {}
    const v = await requestJson(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, { ...fields, photo: image.url });
    if (!v.ok) throw new Error(JSON.stringify(v));
    return String(v.result && v.result.message_id || '');
  }
  throw new Error('Изображение не найдено.');
}

async function sendTelegramHtml(d, html) {
  const token = getSecret(d, 'telegram_bot_token');
  const chat = d.settings.telegramChatId;
  if (!token || !chat) throw new Error('Telegram не настроен.');
  const v = await requestJson(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, { chat_id: chat, text: String(html || '').slice(0, 4096), parse_mode: 'HTML', disable_web_page_preview: false });
  if (!v.ok) throw new Error(JSON.stringify(v));
  return String(v.result && v.result.message_id || '');
}

async function sendTelegramPost(d, post) {
  const email = d.emails.find(e => e.id === post.email_id);
  if (!email) return sendTelegram(d, stripEmailFooter(post.content));
  // The published text is the original email HTML, not Gemini's rewritten text.
  const content = emailHtmlToTelegramHtml(email.body_html || email.body_text || post.content || '');
  const images = publishableEmailImages(email);
  const [caption, remainder] = splitTelegramHtml(content, 1024);
  if (!images.length) {
    if (content.length <= 4096) return sendTelegramHtml(d, content);
    let rest = content;
    let first = '';
    while (rest) { const parts = splitTelegramHtml(rest, 4096); const id = await sendTelegramHtml(d, parts[0]); if (!first) first = id; rest = parts[1]; }
    return first;
  }
  let firstMessage = '';
  try {
    firstMessage = await sendTelegramPhoto(d, images[0], caption);
  } catch (_) {}
  if (!firstMessage) return sendTelegramHtml(d, content);
  if (remainder) {
    let rest = remainder;
    while (rest) {
      const parts = splitTelegramHtml(rest, 4096);
      await sendTelegramHtml(d, parts[0]);
      rest = parts[1];
    }
  }
  return firstMessage;
}

async function geminiGenerate(d, key, input, opts = {}) {
  const models = opts.models || ['gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-3.6-flash'];
  const payload = {
    contents: [{ role: 'user', parts: [{ text: input }] }],
    generationConfig: {
      responseMimeType: opts.json ? 'application/json' : undefined,
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxOutputTokens ?? 2048
    }
  };
  if (!payload.generationConfig.responseMimeType) delete payload.generationConfig.responseMimeType;

  let lastError = null;
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await requestJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, payload);
      } catch (e) {
        lastError = e;
        const msg = String(e || '');
        const retryable = /HTTP (429|500|502|503|504)/.test(msg) || /UNAVAILABLE|high demand|temporarily/i.test(msg);
        if (!retryable || attempt === 1) break;
        await new Promise(r => setTimeout(r, 2500));
      }
    }
  }
  throw lastError || new Error('Gemini: не удалось получить ответ');
}

async function makePost(d, subject, sender, body, customPrompt) {
  const key = getSecret(d, 'gemini_api_key');
  if (!key) throw new Error('Google Gemini API key не задан. Получите ключ в Google AI Studio и сохраните его в Settings.');
  const prompt = customPrompt && customPrompt.trim() ? customPrompt : 'Сделай короткий пост для Telegram на русском языке по содержимому письма. Не выдумывай факты. Верни только JSON без markdown: {"title":"...","content":"..."}. Заголовок до 100 символов, текст до 3500 символов.';
  const input = `${prompt}\n\nОтправитель: ${sender}\nТема: ${subject}\n\nПисьмо:\n${body}`;
  let v;
  try {
    v = await geminiGenerate(d, key, input, { json: true, maxOutputTokens: 3072 });
  } catch (e) {
    const msg = String(e || '');
    if (/HTTP 503|UNAVAILABLE|high demand/i.test(msg)) {
      throw new Error('Gemini временно перегружен. Приложение попробовало несколько бесплатных моделей. Повторите через 1–2 минуты.');
    }
    throw e;
  }
  const text = (((v || {}).candidates || [])[0] || {}).content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error(`Gemini: не найден текст ответа: ${JSON.stringify(v).slice(0, 1500)}`);
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    const o = JSON.parse(cleaned);
    return { title: o.title || subject || 'Без заголовка', content: o.content || cleaned };
  } catch (_) { return { title: subject || 'Без заголовка', content: cleaned }; }
}

async function testGemini() {
  const d = loadData();
  const key = getSecret(d, 'gemini_api_key');
  if (!key) throw new Error('Google Gemini API key не задан.');
  let v;
  try {
    v = await geminiGenerate(d, key, 'Ответь одним словом: OK', { maxOutputTokens: 64 });
  } catch (e) {
    const msg = String(e || '');
    if (/HTTP 503|UNAVAILABLE|high demand/i.test(msg)) {
      throw new Error('Gemini временно перегружен. Проверка попробовала несколько бесплатных моделей. Повторите позже.');
    }
    throw e;
  }
  const text = (((v || {}).candidates || [])[0] || {}).content?.parts?.map(p => p.text || '').join('').trim() || '';
  if (!text) throw new Error(`Gemini не вернул ответ: ${JSON.stringify(v).slice(0, 1000)}`);
  return 'Gemini подключён';
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
      const body = stripEmailFooter(e.body_text || e.body_html || '');
      for (const a of d.automations.filter(x => x.enabled !== false)) {
        if (!matchesAutomation(a, e.sender || '', e.subject || '', body)) continue;
        const made = await makePost(d, e.subject || '', e.sender || '', body, a.prompt);
        const post = { id: crypto.randomUUID(), email_id: e.id, title: made.title, content: stripEmailFooter(e.body_text || e.body_html || made.content), image_count: publishableEmailImages(e).length, status: a.mode === 'automatic' ? 'queued' : 'draft', source: e.sender || 'Gmail', created_at: new Date().toISOString() };
        d.posts.unshift(post); generated++;
        if (a.mode === 'automatic') {
          try { const mid = await sendTelegramPost(d, post); post.status = 'published'; post.telegram_message_id = mid; post.published_at = new Date().toISOString(); } catch (err) { post.status = 'queued'; post.error = String(err.message || err); }
        }
        break;
      }
    }
    saveData(d);
    return { emails_synced: synced, posts_created: generated };
  } finally { syncing = false; }
}

function configState(d) {
  return { gmail: !!d.gmail.email && !!getSecret(d, 'google_refresh_token'), gemini: !!getSecret(d, 'gemini_api_key'), telegram: !!getSecret(d, 'telegram_bot_token') && !!d.settings.telegramChatId };
}

ipcMain.handle('app_status', async () => 'Локальное ядро Electron запущено');
ipcMain.handle('get_config_state', async () => configState(loadData()));
ipcMain.handle('get_settings', async () => {
  const d = loadData();
  return {
    clientId: getSecret(d, 'google_client_id'),
    hasClientSecret: !!getSecret(d, 'google_client_secret'),
    hasGeminiApiKey: !!getSecret(d, 'gemini_api_key'),
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
  if (input.geminiApiKey) setSecret(d, 'gemini_api_key', String(input.geminiApiKey).trim());
  if (input.telegramBotToken) setSecret(d, 'telegram_bot_token', String(input.telegramBotToken).trim());
  if (input.telegramChatId !== undefined && String(input.telegramChatId).trim()) d.settings.telegramChatId = String(input.telegramChatId).trim();
  saveData(d); return true;
});
ipcMain.handle('connect_gmail', async () => connectGmail());
ipcMain.handle('test_telegram', async () => testTelegram());
ipcMain.handle('test_gemini', async () => testGemini());
ipcMain.handle('sync_now', async () => syncAndProcess());
ipcMain.handle('create_post_from_email', async (_event, args = {}) => {
  const d = loadData();
  const email = d.emails.find(e => e.id === args.emailId);
  if (!email) throw new Error('Письмо не найдено');
  const existing = d.posts.find(p => p.email_id === email.id && p.status !== 'published');
  const automation = d.automations.find(a => a.enabled !== false && matchesAutomation(a, email.sender || '', email.subject || '', email.body_text || email.body_html || ''));
  const prompt = automation ? automation.prompt : '';
  const body = stripEmailFooter(email.body_text || email.body_html || '');
  const made = await makePost(d, email.subject || '', email.sender || '', body, prompt);
  if (existing) {
    existing.title = made.title;
    existing.content = stripEmailFooter(email.body_text || email.body_html || made.content);
    existing.image_count = publishableEmailImages(email).length;
    existing.status = 'draft';
    delete existing.error;
    existing.created_at = new Date().toISOString();
    saveData(d);
    return existing.id;
  }
  const post = {
    id: crypto.randomUUID(),
    email_id: email.id,
    title: made.title,
    content: stripEmailFooter(email.body_text || email.body_html || made.content),
    image_count: publishableEmailImages(email).length,
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
  const mid = await sendTelegramPost(d, post); post.status = 'published'; post.telegram_message_id = mid; post.published_at = new Date().toISOString(); saveData(d); return mid;
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
