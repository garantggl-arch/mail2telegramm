use keyring::Entry;
const SERVICE: &str = "Mail2Telegram";
pub fn set(key: &str, value: &str) -> Result<(), String> {
    Entry::new(SERVICE, key).map_err(|e| e.to_string())?.set_password(value).map_err(|e| e.to_string())
}
pub fn get(key: &str) -> Result<String, String> {
    Entry::new(SERVICE, key).map_err(|e| e.to_string())?.get_password().map_err(|e| e.to_string())
}
