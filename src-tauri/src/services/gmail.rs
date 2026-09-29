use crate::{db, services::secrets};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde_json::{json, Value};
use std::{io::Read, net::TcpListener, path::Path, thread, time::Duration};
use urlencoding::encode;

const SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";

pub fn oauth_and_connect(path: &Path) -> Result<String, String> {
    let client_id = secrets::get("google_client_id")?;
    let client_secret = secrets::get("google_client_secret")?;
    if client_id.is_empty() { return Err("Сначала сохраните Google Client ID".into()); }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let auth = format!("https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        encode(&client_id), encode(&redirect), encode(SCOPE));
    webbrowser::open(&auth).map_err(|e| e.to_string())?;
    listener.set_nonblocking(false).ok();
    let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
    let mut buf = [0u8; 8192]; let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let line = request.lines().next().unwrap_or("");
    let query = line.split_whitespace().nth(1).unwrap_or("/").split('?').nth(1).unwrap_or("");
    let mut code = None; let mut err = None;
    for p in query.split('&') { let mut it=p.splitn(2,'='); let k=it.next().unwrap_or(""); let v=it.next().unwrap_or(""); if k=="code" { code=Some(v.to_string()); } if k=="error" { err=Some(v.to_string()); } }
    use std::io::Write; let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<h2>Mail2Telegram: Gmail подключён. Можно закрыть вкладку.</h2>");
    if let Some(e)=err { return Err(format!("Google OAuth: {e}")); }
    let code = code.ok_or("Не получен OAuth code")?;
    let rt = runtime_tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(exchange_and_profile(path, &client_id, &client_secret, &redirect, &code))
}

async fn exchange_and_profile(path: &Path, client_id: &str, client_secret: &str, redirect: &str, code: &str) -> Result<String,String> {
    let c=Client::new();
    let token: Value=c.post("https://oauth2.googleapis.com/token").form(&[("code",code),("client_id",client_id),("client_secret",client_secret),("redirect_uri",redirect),("grant_type","authorization_code")]).send().await.map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
    if let Some(e)=token.get("error") { return Err(format!("Google token error: {e}")); }
    let refresh=token["refresh_token"].as_str().ok_or("Google не вернул refresh token. Попробуйте подключить заново.")?;
    secrets::set("google_refresh_token",refresh)?;
    let access=token["access_token"].as_str().ok_or("Нет access token")?;
    let profile:Value=c.get("https://gmail.googleapis.com/gmail/v1/users/me/profile").bearer_auth(access).send().await.map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
    let email=profile["emailAddress"].as_str().ok_or("Не удалось определить Gmail адрес")?.to_string();
    db::upsert_account(path,&email).map_err(|e|e.to_string())?;
    Ok(email)
}

async fn access_token() -> Result<String,String> {
    let cid=secrets::get("google_client_id")?; let cs=secrets::get("google_client_secret")?; let rt=secrets::get("google_refresh_token")?;
    let c=Client::new(); let v:Value=c.post("https://oauth2.googleapis.com/token").form(&[("client_id",cid.as_str()),("client_secret",cs.as_str()),("refresh_token",rt.as_str()),("grant_type","refresh_token")]).send().await.map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
    v["access_token"].as_str().map(str::to_string).ok_or_else(|| format!("Google refresh error: {v}"))
}

pub async fn sync_account(path: &Path, account_id: &str) -> Result<usize,String> {
    let access=access_token().await?; let c=Client::new();
    let list:Value=c.get("https://gmail.googleapis.com/gmail/v1/users/me/messages").bearer_auth(&access).query(&[("maxResults","20"),("q","newer_than:7d")]).send().await.map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
    let ids=list["messages"].as_array().cloned().unwrap_or_default(); let mut count=0;
    for item in ids { let id=item["id"].as_str().unwrap_or(""); if id.is_empty(){continue;}
        let m:Value=c.get(format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}")).bearer_auth(&access).query(&[("format","full")]).send().await.map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
        let e=parse_message(&m,account_id)?; if db::save_email(path,&e).map_err(|e|e.to_string())? {count+=1;}
    }
    db::set_last_sync(path,account_id).map_err(|e|e.to_string())?; Ok(count)
}

fn parse_message(m:&Value, account_id:&str)->Result<Value,String>{
    let headers=m["payload"]["headers"].as_array().ok_or("Gmail message headers missing")?; let mut from="";let mut to="";let mut subject="";
    for h in headers { let n=h["name"].as_str().unwrap_or("").to_ascii_lowercase(); let v=h["value"].as_str().unwrap_or(""); match n.as_str(){"from"=>from=v,"to"=>to=v,"subject"=>subject=v,_=>{}} }
    let (text,html)=extract_parts(&m["payload"]); let internal=m["internalDate"].as_str().unwrap_or("0").parse::<i64>().unwrap_or(0); let received=DateTime::<Utc>::from_timestamp_millis(internal).map(|d|d.to_rfc3339()).unwrap_or_default();
    Ok(json!({"id":uuid::Uuid::new_v4().to_string(),"account_id":account_id,"provider_id":m["id"].as_str().unwrap_or(""),"thread_id":m["threadId"].as_str(),"sender":from,"recipient":to,"subject":subject,"body_text":text,"body_html":html,"received_at":received,"content_hash":format!("{}:{}:{}",from,subject,text)}))
}
fn extract_parts(p:&Value)->(String,String){
    let mime=p["mimeType"].as_str().unwrap_or(""); let data=p["body"]["data"].as_str().unwrap_or(""); let decoded=URL_SAFE_NO_PAD.decode(data).or_else(|_|base64::engine::general_purpose::URL_SAFE.decode(data)).unwrap_or_default(); let s=String::from_utf8_lossy(&decoded).to_string();
    let mut text=if mime=="text/plain" {s.clone()} else {String::new()}; let mut html=if mime=="text/html" {s.clone()} else {String::new()};
    if let Some(parts)=p["parts"].as_array(){ for part in parts { let (t,h)=extract_parts(part); if !t.is_empty(){text.push_str(&t);} if !h.is_empty(){html.push_str(&h);} } }
    (text,html)
}
