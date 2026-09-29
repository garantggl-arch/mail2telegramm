use crate::{db, services::{gmail, openai, secrets, telegram}};
use serde_json::Value;
use std::path::Path;

pub async fn sync_and_process(path:&Path)->Result<Value,String>{
    let mut synced=0usize; for (id,_) in db::accounts(path).map_err(|e|e.to_string())? { synced+=gmail::sync_account(path,&id).await?; }
    let mut generated=0usize;
    for e in db::list_emails(path).map_err(|e|e.to_string())? {
        let sender=e["sender"].as_str().unwrap_or(""); let subject=e["subject"].as_str().unwrap_or("");
        let id=e["id"].as_str().unwrap_or("");
        if db::find_post_for_email(path,id).map_err(|e|e.to_string())? {continue;}
        let body=load_email_body(path,id).unwrap_or_default();
        for a in db::automations(path).map_err(|e|e.to_string())? {
            if !matches(&a,sender,subject,&body){continue;}
            let (title,content)=openai::make_post(subject,sender,&body,a["prompt"].as_str()).await?;
            let post_id=db::create_post(path,id,&title,&content,a["mode"].as_str().unwrap_or("approval")).map_err(|e|e.to_string())?; generated+=1;
            if a["mode"].as_str()==Some("automatic") { let _=publish_post(path,&post_id).await?; }
            break;
        }
    }
    Ok(serde_json::json!({"emails_synced":synced,"posts_created":generated}))
}
fn matches(a:&Value,sender:&str,subject:&str,body:&str)->bool{
    if let Some(f)=a["sender_filter"].as_str(){if !f.trim().is_empty() && !sender.to_lowercase().contains(&f.to_lowercase()){return false;}}
    if let Some(f)=a["subject_filter"].as_str(){if !f.trim().is_empty() && !subject.to_lowercase().contains(&f.to_lowercase()){return false;}}
    if let Some(k)=a["keywords"].as_str(){for x in k.split(',').map(str::trim).filter(|x|!x.is_empty()){if !format!("{subject} {body}").to_lowercase().contains(&x.to_lowercase()){return false;}}}
    true
}
fn load_email_body(path:&Path,id:&str)->Result<String,String>{
    let c=rusqlite::Connection::open(path).map_err(|e|e.to_string())?; c.query_row("SELECT COALESCE(body_text,body_html,'') FROM emails WHERE id=?1",[id],|r|r.get(0)).map_err(|e|e.to_string())
}
pub async fn publish_post(path:&Path,id:&str)->Result<String,String>{
    let (_,content,status)=db::post(path,id).map_err(|e|e.to_string())?.ok_or("Пост не найден")?; if status=="published"{return Ok("already-published".into());}
    let token=secrets::get("telegram_bot_token")?; let chat=db::get_setting(path,"telegram_chat_id").map_err(|e|e.to_string())?.ok_or("Telegram chat_id не задан")?;
    let mid=telegram::send(&token,&chat,&content).await?; db::mark_published(path,id,&mid).map_err(|e|e.to_string())?; Ok(mid)
}
