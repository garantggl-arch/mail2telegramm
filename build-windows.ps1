$ErrorActionPreference = 'Stop'
Write-Host 'Mail2Telegram Windows build'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required.' }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Rust/Cargo is required. Install rustup from https://rustup.rs/' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
npm install
npm run tauri build
Write-Host ''
Write-Host 'EXE:'
Get-ChildItem -Recurse .\src-tauri\target\release\bundle\nsis\*.exe | Select-Object -ExpandProperty FullName
Write-Host 'MSI:'
Get-ChildItem -Recurse .\src-tauri\target\release\bundle\msi\*.msi | Select-Object -ExpandProperty FullName
