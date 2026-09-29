# Mail2Telegram 0.2.0

Рабочий desktop MVP для Windows/macOS: Gmail OAuth → локальная SQLite → фильтры → OpenAI Responses API → черновик или автоматическая публикация в Telegram.

## 1. Что нужно
- Node.js 20+
- Rust stable + Visual Studio Build Tools (Windows) или Xcode Command Line Tools (macOS)
- Google Cloud project с Gmail API и OAuth Client ID типа **Desktop app**
- OpenAI API key
- Telegram bot token и канал/чат, куда бот может писать

## 2. Запуск
```bash
npm install
npm run tauri dev
```

## 3. Настройка
1. Settings → сохраните Google Client ID/Secret, OpenAI key, Telegram Bot Token и Chat ID.
2. Нажмите «Подключить Gmail». Откроется браузер Google OAuth; после согласия вкладку можно закрыть.
3. Нажмите «Проверить Telegram».
4. В Automation создайте правило. В режиме Approval новые письма превращаются в черновики. В Automatic они публикуются сразу.
5. Нажмите «Синхронизировать» для первого запуска. Дальше фоновый цикл проверяет почту автоматически.

## 4. Windows build
```powershell
npm install
npm run tauri build
```
Установщики:
- `src-tauri/target/release/bundle/nsis/` — EXE installer
- `src-tauri/target/release/bundle/msi/` — MSI

## Важно
Gmail использует OAuth desktop flow с loopback redirect. Для Google Cloud нужен OAuth consent screen и включённый Gmail API. Токены и API keys хранятся через системное credential storage, а не в SQLite.
