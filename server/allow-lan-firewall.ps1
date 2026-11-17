$ErrorActionPreference = 'Stop'

$ruleName = 'SafeChat Relay LAN (TCP 8080)'
$isAdministrator = ([Security.Principal.WindowsPrincipal](
    [Security.Principal.WindowsIdentity]::GetCurrent()
)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdministrator) {
    Write-Host 'Ten skrypt wymaga uruchomienia jako administrator.' -ForegroundColor Yellow
    Write-Host 'Kliknij prawym przyciskiem i wybierz: Uruchom z programem PowerShell jako administrator.'
    Read-Host 'Nacisnij Enter, aby zamknac'
    exit 1
}

$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existingRule) {
    Write-Host 'Regula zapory SafeChat juz istnieje.' -ForegroundColor Green
    exit 0
}

New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 8080 `
    -Profile Private `
    -RemoteAddress LocalSubnet | Out-Null

Write-Host 'Dodano dostep do TCP 8080 wylacznie z prywatnej sieci lokalnej.' -ForegroundColor Green
