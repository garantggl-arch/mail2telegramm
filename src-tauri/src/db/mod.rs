use rusqlite::{params, Connection, Result};
use serde_json::Value;
use std::path::Path;
use uuid::Uuid;

pub fn init(path: &Path) -> Result<()> {
    let c = Connection::open(path)?;
    c.execute_batch(include_str!("../../migrations.sql"))?;
    if get_setting(path, "interval_minutes")?.is_none() { set_setting(path, "interval_minutes", "5")?; }
    Ok(())
}

pub fn set_setting(path: &Path, key: &str, value: &str) -> Result<()> {
    let c = Connection::open(path)?;
    c.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])?;
    Ok(())
}

pub fn get_setting(path: &Path, key: &str) -> Result<Option<String>> {
    let c = Connection::open(path)?;
    c.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional()
}

pub fn upsert_account(path: &Path, email: &str) -> Result<String> {
    let c = Connection::open(path)?;
    let existing: Option<String> = c.query_row("SELECT id FROM email_accounts WHERE email=?1", [email], |r| r.get(0)).optional()?;
    let id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
    c.execute("INSERT INTO email_accounts(id,email,provider) VALUES(?1,?2,'gmail') ON CONFLICT(id) DO UPDATE SET email=excluded.email,updated_at=CURRENT_TIMESTAMP", params![id,email])?;
    Ok(id)
}

pub fn save_email(path: &Path, e: &Value) -> Result<bool> {
    let c = Connection::open(path)?;
    let changed = c.execute("INSERT OR IGNORE INTO emails(id,account_id,provider_id,thread_id,sender,recipient,subject,body_text,body_html,received_at,content_hash,status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'received')",
        params![e["id"].as_str().unwrap_or(""), e["account_id"].as_str().unwrap_or(""), e["provider_id"].as_str().unwrap_or(""), e["thread_id"].as_str(), e["sender"].as_str(), e["recipient"].as_str(), e["subject"].as_str(), e["body_text"].as_str(), e["body_html"].as_str(), e["received_at"].as_str(), e["content_hash"].as_str()])?;
    Ok(changed > 0)
}

pub fn set_last_sync(path: &Path, account_id: &str) -> Result<()> {
    let c = Connection::open(path)?;
    c.execute("UPDATE email_accounts SET last_sync_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?1", [account_id])?;
    Ok(())
}

pub fn accounts(path: &Path) -> Result<Vec<(String,String)>> {
    let c = Connection::open(path)?;
    let mut s = c.prepare("SELECT id,email FROM email_accounts WHERE status='active'")?;
    let rows = s.query_map([], |r| Ok((r.get(0)?,r.get(1)?)))?;
    rows.collect()
}

pub fn list_emails(path: &Path) -> Result<Vec<Value>> {
    let c = Connection::open(path)?;
    let mut s = c.prepare("SELECT id,sender,subject,received_at,status FROM emails ORDER BY received_at DESC LIMIT 100")?;
    let rows = s.query_map([], |r| Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"sender":r.get::<_,Option<String>>(1)?,"subject":r.get::<_,Option<String>>(2)?,"received_at":r.get::<_,Option<String>>(3)?,"status":r.get::<_,String>(4)?})))?;
    rows.collect()
}

pub fn list_posts(path: &Path) -> Result<Vec<Value>> {
    let c = Connection::open(path)?;
    let mut s = c.prepare("SELECT p.id,p.title,p.content,p.status,e.sender,p.created_at FROM posts p LEFT JOIN emails e ON e.id=p.email_id ORDER BY p.created_at DESC LIMIT 100")?;
    let rows = s.query_map([], |r| Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,Option<String>>(1)?,"content":r.get::<_,Option<String>>(2)?,"status":r.get::<_,String>(3)?,"source":r.get::<_,Option<String>>(4)?,"created_at":r.get::<_,String>(5)?})))?;
    rows.collect()
}

pub fn upsert_automation(path: &Path, v: &Value) -> Result<String> {
    let c = Connection::open(path)?;
    let id = v["id"].as_str().filter(|x| !x.is_empty()).unwrap_or_else(|| "");
    let id = if id.is_empty() { Uuid::new_v4().to_string() } else { id.to_string() };
    c.execute("INSERT INTO automations(id,name,email_account_id,telegram_channel_id,enabled,mode,sender_filter,subject_filter,keywords,language,prompt) VALUES(?1,?2,'','',1,?3,?4,?5,?6,'ru',?7) ON CONFLICT(id) DO UPDATE SET name=excluded.name,mode=excluded.mode,sender_filter=excluded.sender_filter,subject_filter=excluded.subject_filter,keywords=excluded.keywords,prompt=excluded.prompt,updated_at=CURRENT_TIMESTAMP",
        params![id,v["name"].as_str().unwrap_or("Automation"),v["mode"].as_str().unwrap_or("approval"),v["sender_filter"].as_str(),v["subject_filter"].as_str(),v["keywords"].as_str(),v["prompt"].as_str()])?;
    Ok(id)
}

pub fn automations(path: &Path) -> Result<Vec<Value>> {
    let c = Connection::open(path)?;
    let mut s = c.prepare("SELECT id,name,mode,sender_filter,subject_filter,keywords,prompt,enabled FROM automations WHERE enabled=1")?;
    let rows = s.query_map([], |r| Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"mode":r.get::<_,String>(2)?,"sender_filter":r.get::<_,Option<String>>(3)?,"subject_filter":r.get::<_,Option<String>>(4)?,"keywords":r.get::<_,Option<String>>(5)?,"prompt":r.get::<_,Option<String>>(6)?,"enabled":r.get::<_,i64>(7)?})))?;
    rows.collect()
}

pub fn find_post_for_email(path: &Path, email_id: &str) -> Result<bool> {
    let c = Connection::open(path)?;
    let n: i64 = c.query_row("SELECT COUNT(*) FROM posts WHERE email_id=?1", [email_id], |r| r.get(0))?;
    Ok(n > 0)
}

pub fn create_post(path: &Path, email_id: &str, title: &str, content: &str, mode: &str) -> Result<String> {
    let c = Connection::open(path)?;
    let id = Uuid::new_v4().to_string();
    let status = if mode == "automatic" { "queued" } else { "draft" };
    c.execute("INSERT INTO posts(id,email_id,title,content,status,ai_model) VALUES(?1,?2,?3,?4,?5,'gpt-5.6-luna')", params![id,email_id,title,content,status])?;
    Ok(id)
}

pub fn post(path: &Path, id: &str) -> Result<Option<(String,String,String)>> {
    let c = Connection::open(path)?;
    c.query_row("SELECT id,content,status FROM posts WHERE id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()
}

pub fn mark_published(path: &Path, id: &str, message_id: &str) -> Result<()> {
    let c = Connection::open(path)?;
    c.execute("UPDATE posts SET status='published',telegram_message_id=?2,published_at=CURRENT_TIMESTAMP WHERE id=?1", params![id,message_id])?;
    Ok(())
}

trait OptionalExt<T> { fn optional(self) -> Result<Option<T>>; }
impl<T> OptionalExt<T> for Result<T> { fn optional(self) -> Result<Option<T>> { match self { Ok(v)=>Ok(Some(v)), Err(rusqlite::Error::QueryReturnedNoRows)=>Ok(None), Err(e)=>Err(e) } } }
