const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

let mainWindow = null;
let pollTimer = null;
let syncing = false;

const state = {
  get file() { return path.join(app.getPath('userData'), 'mail2telegram-data.json'); },
};

function defaultData() {
  return {
    settings: { intervalMinutes: 5, autostart: true, background: true, telegramChatId: '' },
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

function requestJson(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { ...(options.headers || {}) };
    if (data && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: options.method || 'GET', headers
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 1200)}`));
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
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

async function connectGmail() {
  const d = loadData();
  const clientId = getSecret(d, 'google_client_id');
  const clientSecret = getSecret(d, 'google_client_secret');
  if (!clientId) throw new Error('Сначала сохраните Google OAuth Client ID.');
  if (!clientSecret) throw new Error('Сначала сохраните Google OAuth Client Secret.');

  const server = http.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).on('error', reject));
  const port = server.address().port;
  const redirect = `http://127.0.0.1:${port}`;
  const scope = 'https://www.googleapis.com/auth/gmail.readonly';
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', clientId);
  auth.searchParams.set('redirect_uri', redirect);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', scope);
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('prompt', 'consent');
  await shell.openExternal(auth.toString());

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { server.close(); } catch (_) {} reject(new Error('Время ожидания Google OAuth истекло.')); }, 180000);
    server.on('request', (req, res) => {
      try {
        const u = new URL(req.url, redirect);
        const code = u.searchParams.get('code');
        const error = u.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        res.end('<h2>Mail2Telegram: Gmail подключён. Это окно можно закрыть.</h2>');
        clearTimeout(timer); server.close();
        if (error) reject(new Error(`Google OAuth: ${error}`));
        else if (!code) reject(new Error('Google не вернул OAuth code.'));
        else resolve(code);
      } catch (e) { clearTimeout(timer); server.close(); reject(e); }
    });
  });

  const form = new URLSearchParams({ code: result, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }).toString();
  const token = await requestJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, form);
  if (!token.refresh_token) throw new Error('Google не вернул refresh token. Нажмите «Подключить Gmail» ещё раз.');
  setSecret(d, 'google_refresh_token', token.refresh_token);
  const profile = await requestJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token.access_token}` } });
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
ipcMain.handle('list_emails', async () => loadData().emails.slice(0, 100));
ipcMain.handle('list_posts', async () => loadData().posts.slice(0, 100));
ipcMain.handle('save_credentials', async (_event, input = {}) => {
  const d = loadData();
  setSecret(d, 'google_client_id', input.clientId || '');
  setSecret(d, 'google_client_secret', input.clientSecret || '');
  setSecret(d, 'openai_api_key', input.openaiApiKey || '');
  setSecret(d, 'telegram_bot_token', input.telegramBotToken || '');
  d.settings.telegramChatId = input.telegramChatId || d.settings.telegramChatId || '';
  saveData(d); return true;
});
ipcMain.handle('connect_gmail', async () => connectGmail());
ipcMain.handle('test_telegram', async () => testTelegram());
ipcMain.handle('sync_now', async () => syncAndProcess());
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
