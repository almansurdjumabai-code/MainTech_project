# CQA: запуск демо одной командой — backend + ML + UI, затем открывается браузер.
#   .\start.ps1            (или двойной клик по start.bat)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$url = 'http://127.0.0.1:8000/'

# Сервер уже работает — просто открываем интерфейс
try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ($url + 'health') | Out-Null
    Write-Host "Сервер уже запущен: $url"
    Start-Process $url
    exit 0
} catch { }

if (-not (Test-Path 'backend\.venv\Scripts\python.exe')) {
    Write-Host 'Первый запуск: создаю окружение и ставлю зависимости (1-2 минуты)...'
    python -m venv backend\.venv
    backend\.venv\Scripts\python -m pip install -q -r backend\requirements.txt
}
if (-not (Test-Path 'backend\.env')) {
    Copy-Item .env.example backend\.env
    Write-Host 'Создан backend\.env из шаблона: впишите DATASET_URL (и ключ LLM, если нужен), затем перезапустите.'
}

# Браузер откроется, когда сервер поднимется
Start-Job -ArgumentList $url -ScriptBlock {
    param($u)
    for ($i = 0; $i -lt 30; $i++) {
        try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 ($u + 'health') | Out-Null; Start-Process $u; break } catch { Start-Sleep 1 }
    }
} | Out-Null

Write-Host "CQA: $url  (остановить: Ctrl+C)"
backend\.venv\Scripts\python -m uvicorn backend.app.main:app --port 8000
