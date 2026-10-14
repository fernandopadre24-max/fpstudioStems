# abrir-app.ps1
# Sobe o app no seu PC e cria uma URL publica (tunel Cloudflare, sem conta).
# O download do YouTube sai do seu IP residencial -> funciona sempre.
# Voce so precisa deixar esta janela aberta. Ctrl+C encerra.

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Err($m)  { Write-Host $m -ForegroundColor Red }

$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$bin  = Join-Path $root ".bin"
if (-not (Test-Path -LiteralPath $bin)) { New-Item -ItemType Directory -Path $bin | Out-Null }

$cfPath = Join-Path $bin "cloudflared.exe"
$devLog = Join-Path $env:TEMP "stemroller-dev.log"
$devErr = Join-Path $env:TEMP "stemroller-dev.err.log"
$cfLog  = Join-Path $env:TEMP "stemroller-cf.log"
$cfOut  = Join-Path $env:TEMP "stemroller-cf.out.log"
$localPort = 5173

Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "   FPStudio - Stems : abrir app (modo local + url publica)" -ForegroundColor DarkCyan
Write-Host "============================================================" -ForegroundColor DarkCyan

# 1) Garante o cloudflared
if (-not (Test-Path -LiteralPath $cfPath)) {
  Info "Baixando o cloudflared (~35 MB, so na primeira vez)..."
  $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  curl.exe -L --fail -o $cfPath $url
  if (-not (Test-Path -LiteralPath $cfPath)) { Err "Falha ao baixar o cloudflared."; exit 1 }
  Ok "cloudflared pronto."
}

# 2) Sobe o servidor do app
Info "Iniciando o app (npm run dev)..."
foreach ($f in @($devLog, $devErr, $cfLog, $cfOut)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }
$dev = Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c npm run dev -- --host --port $localPort" `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $devLog -RedirectStandardError $devErr

$ready = $false
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  Start-Sleep 2
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$localPort" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
  if ($dev.HasExited) { break }
}
if (-not $ready) {
  Err "O app nao subiu a tempo. Veja o log: $devLog"
  if (Test-Path $devErr) { Get-Content -LiteralPath $devErr -Tail 20 }
  exit 1
}
Ok "App rodando em http://localhost:$localPort"

# 3) Abre o tunel publico
Info "Criando a URL publica (tunel Cloudflare)..."
$cf = Start-Process -FilePath $cfPath `
  -ArgumentList "tunnel","--url","http://localhost:$localPort","--no-autoupdate" `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $cfOut -RedirectStandardError $cfLog

$publicUrl = $null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  Start-Sleep 2
  $txt = ""
  if (Test-Path -LiteralPath $cfLog) { $txt += (Get-Content -LiteralPath $cfLog -Raw) }
  if (Test-Path -LiteralPath $cfOut) { $txt += (Get-Content -LiteralPath $cfOut -Raw) }
  $m = [regex]::Match($txt, "https://[a-z0-9-]+\.trycloudflare\.com")
  if ($m.Success) { $publicUrl = $m.Value; break }
  if ($cf.HasExited) { break }
}

Write-Host ""
if ($publicUrl) {
  Write-Host "============================================================" -ForegroundColor Green
  Write-Host "  URL PUBLICA (use em qualquer lugar):" -ForegroundColor Green
  Write-Host "  $publicUrl" -ForegroundColor Green
  Write-Host "" 
  Write-Host "  Local tambem funciona: http://localhost:$localPort" -ForegroundColor Green
  Write-Host "============================================================" -ForegroundColor Green
  Write-Host ""
  Warn "IMPORTANTE: deixe esta janela aberta enquanto usa o app."
  Warn "Para encerrar: feche esta janela ou aperte Ctrl+C."
  try { Start-Process $publicUrl } catch { }
} else {
  Err "Nao consegui criar a URL publica. Use a local: http://localhost:$localPort"
  if (Test-Path -LiteralPath $cfLog) { Get-Content -LiteralPath $cfLog -Tail 20 }
}

# 4) Mantem rodando ate fechar
try {
  if (-not $cf.HasExited) { Wait-Process -Id $cf.Id }
} finally {
  Warn "Encerrando..."
  foreach ($p in @($cf, $dev)) {
    if ($p -and -not $p.HasExited) { try { Stop-Process -Id $p.Id -Force } catch { } }
  }
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-30) } | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch { } }
}
