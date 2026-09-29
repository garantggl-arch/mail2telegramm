use reqwest::Client;
use serde_json::{json, Value};
use super::secrets;

pub async fn make_post(subject:&str, sender:&str, body:&str, custom_prompt:Option<&str>)->Result<(String,String),String>{
    let key=secrets::get("openai_api_key")?; if key.is_empty(){return Err("OpenAI API key не задан".into());}
    let prompt=custom_prompt.unwrap_or("Сделай короткий пост для Telegram на русском языке по содержимому письма. Не выдумывай факты. Верни JSON: {\\\"title\\\":\\\"...\\\",\\\"content\\\":\\\"...\\\"}. Заголовок до 100 символов, текст до 3500 символов.");
    let input=format!("{prompt}\n\nОтправитель: {sender}\nТема: {subject}\n\nПисьмо:\n{body}");
    let req=json!({"model":"gpt-5.6-luna","input":input,"max_output_tokens":1200});
    let c=Client::new(); let v:Value=c.post("https://api.openai.com/v1/responses").bearer_auth(key).json(&req).send().await.map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
    if v.get("error").is_some(){return Err(v.to_string());}
    let text=extract_text(&v).ok_or_else(||format!("OpenAI: не найден текст ответа: {v}"))?;
    let cleaned=text.trim().trim_matches('`').trim_start_matches("json").trim();
    if let Ok(o)=serde_json::from_str::<Value>(cleaned){
        return Ok((o["title"].as_str().unwrap_or(subject).to_string(),o["content"].as_str().unwrap_or(cleaned).to_string()));
    }
    Ok((subject.to_string(),cleaned.to_string()))
}
fn extract_text(v:&Value)->Option<String>{
    if let Some(s)=v["output_text"].as_str(){return Some(s.to_string())}
    if let Some(arr)=v["output"].as_array(){for item in arr{if let Some(content)=item["content"].as_array(){for c in content{if let Some(t)=c["text"].as_str(){return Some(t.to_string())}}}}}
    None
}
