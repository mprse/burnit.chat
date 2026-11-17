$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$projectDirectory = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue

if (-not $nodeCommand) {
    throw 'Nie znaleziono node.exe. Zainstaluj aktualną wersję Node.js LTS.'
}
if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory 'node_modules\ws'))) {
    throw 'Brakuje zależności. W katalogu projektu uruchom najpierw: npm install'
}

if ([string]::IsNullOrWhiteSpace($env:NODE_ENV)) {
    $env:NODE_ENV = 'development'
}
if ([string]::IsNullOrWhiteSpace($env:PORT)) {
    $env:PORT = '8080'
}
if ([string]::IsNullOrWhiteSpace($env:BURNIT_ALLOWED_ORIGINS)) {
    $env:BURNIT_ALLOWED_ORIGINS = 'http://localhost,http://127.0.0.1,http://safechat.test'
}
if ([string]::IsNullOrWhiteSpace($env:BURNIT_LOG_LEVEL)) {
    $env:BURNIT_LOG_LEVEL = 'debug'
}

Write-Host ''
Write-Host 'burnit.chat relay Node.js' -ForegroundColor Green
Write-Host "Node.js:   $($nodeCommand.Source)"
Write-Host "WebSocket: ws://localhost:$env:PORT/ws"
Write-Host "Originy:   $env:BURNIT_ALLOWED_ORIGINS"
Write-Host ''
Write-Host 'Pozostaw to okno otwarte podczas lokalnego testu.' -ForegroundColor Yellow
Write-Host 'Zatrzymanie: Ctrl+C' -ForegroundColor DarkGray
Write-Host ''

Set-Location $projectDirectory
& $nodeCommand.Source 'server\node-relay.cjs'
$serverExitCode = $LASTEXITCODE

if ($serverExitCode -ne 0) {
    Write-Host ''
    Write-Host "Relay zakończył się błędem ($serverExitCode)." -ForegroundColor Red
}

exit $serverExitCode
