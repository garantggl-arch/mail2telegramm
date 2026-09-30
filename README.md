# Mail2Telegram 0.2.0 — Gemini edition

Desktop-приложение для Windows 7: Gmail OAuth → получение писем → Google Gemini → черновик поста → Telegram.

## AI без OpenAI API

Для генерации постов используется **Google Gemini API**, а не OpenAI API. Для `gemini-3-flash-preview` Google указывает Free Tier для этой модели; фактические лимиты зависят от доступности Free Tier для аккаунта и текущих квот Google.

Ключ можно создать в Google AI Studio: https://aistudio.google.com/apikey

## Настройка
1. Settings → сохраните Google OAuth Client ID/Secret.
2. Нажмите «Подключить Gmail».
3. Создайте Gemini API key в Google AI Studio и сохраните его в поле «Google Gemini API Key».
4. Нажмите «Проверить Gemini».
5. Сохраните Telegram Bot Token и Chat ID / @channel.
6. В Emails нажмите «Создать пост» у нужного письма.
7. В Posts проверьте черновик и нажмите «Опубликовать в Telegram».

Прокси используется для HTTPS-соединений, включая Gmail, Gemini и Telegram.

## Windows 7
Сборка использует Electron 22 и portable EXE без WebView2.


Win7 fix: electron-builder explicitly copies node_modules/electron/dist/ffmpeg.dll to the application root to prevent the missing ffmpeg.dll startup error.


Gemini model: gemini-3-flash-preview (Free Tier). Thinking level is set to low to avoid MAX_TOKENS truncation.
