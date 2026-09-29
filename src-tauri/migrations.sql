CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS email_accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, provider TEXT NOT NULL,
  last_sync_at TEXT, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  thread_id TEXT, sender TEXT, recipient TEXT, subject TEXT, body_text TEXT,
  body_html TEXT, received_at TEXT, content_hash TEXT, status TEXT NOT NULL DEFAULT 'received',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(account_id, provider_id)
);
CREATE TABLE IF NOT EXISTS telegram_channels (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, username TEXT, chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email_account_id TEXT NOT NULL DEFAULT '',
  telegram_channel_id TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'approval', sender_filter TEXT, subject_filter TEXT,
  keywords TEXT, language TEXT NOT NULL DEFAULT 'ru', prompt TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY, email_id TEXT, automation_id TEXT, channel_id TEXT,
  title TEXT, content TEXT, source_url TEXT, status TEXT NOT NULL DEFAULT 'draft',
  telegram_message_id TEXT, ai_model TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS app_events (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, entity_id TEXT, payload TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
