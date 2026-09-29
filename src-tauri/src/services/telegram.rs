use reqwest::Client;
use serde_json::Value;

pub async fn test(token:&str, chat:&str)->Result<String,String>{
    let c=Client::new(); let me:Value=c.get(format!("https://api.telegram.org/bot{token}/getMe")).send().await.map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
    if me["ok"]!=true {return Err(me.to_string())}
    let chatv:Value=c.get(format!("https://api.telegram.org/bot{token}/getChat")).query(&[("chat_id",chat)]).send().await.map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
    if chatv["ok"]!=true{return Err(chatv.to_string())}
    Ok(chatv["result"]["title"].as_str().or(chatv["result"]["username"].as_str()).unwrap_or("Telegram подключён").to_string())
}

pub async fn send(token:&str, chat:&str, text:&str)->Result<String,String>{
    let c=Client::new(); let v:Value=c.post(format!("https://api.telegram.org/bot{token}/sendMessage")).json(&serde_json::json!({"chat_id":chat,"text":text,"disable_web_page_preview":false})).send().await.map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
    if v["ok"]!=true { return Err(v.to_string()); }
    Ok(v["result"]["message_id"].as_i64().unwrap_or_default().to_string())
}
