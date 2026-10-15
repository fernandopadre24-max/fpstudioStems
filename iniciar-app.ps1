# iniciar-app.ps1
# Roda o FPStudio - Stems no seu proprio PC (modo local).
# Usa o seu IP residencial -> o download do YouTube funciona.
# Nao depende da Vercel. Para encerrar: feche esta janela ou Ctrl+C.

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Err($m)  { Write-Host $m -ForegroundColor Red }

$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$port = 4173
$url = "http://localhost:$port"

Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "   FPStudio - Stems   (app local no seu PC)" -ForegroundColor DarkCyan
Write-Host "============================================================" -ForegroundColor DarkCyan

# 0) Ja esta rodando?
try {
  $probe = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
  if ($probe.StatusCode -eq 200) {
    Ok "O app ja esta rodando. Abrindo no navegador..."
    Start-Process $url
    Write-Host ""
    Warn "Se quiser reiniciar, feche a outra janela do app primeiro."
    exit 0
  }
} catch { }

# 1) Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Err "Node.js nao encontrado."
  Err "Instale o Node.js LTS em https://nodejs.org e rode este atalho de novo."
  exit 1
}
$nodeVer = ((& node --version) 2>&1 | Out-String).Trim()
Info "Node.js detectado: $nodeVer"

# 2) Dependencias
if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
  Info "Instalando dependencias (npm install). So na primeira vez, pode demorar..."
  & cmd.exe /c "npm install"
  if ($LASTEXITCODE -ne 0) { Err "Falhou o 'npm install'."; exit 1 }
}

# 3) Build (somente se necessario)
$distIndex = Join-Path $root "dist\index.html"
$needsBuild = -not (Test-Path -LiteralPath $distIndex)
if (-not $needsBuild) {
  $ref = (Get-Item -LiteralPath $distIndex).LastWriteTime
  $watch = @()
  foreach ($d in @("src", "server")) {
    $p = Join-Path $root $d
    if (Test-Path -LiteralPath $p) {
      $watch += Get-ChildItem -Path $p -Recurse -File |
        Where-Object { $_.Extension -in ".ts", ".tsx", ".css", ".html" }
    }
  }
  foreach ($f in @("index.html", "vite.config.ts", "package.json")) {
    $p = Join-Path $root $f
    if (Test-Path -LiteralPath $p) { $watch += Get-Item -LiteralPath $p }
  }
  if ($watch | Where-Object { $_.LastWriteTime -gt $ref } | Select-Object -First 1) { $needsBuild = $true }
}
if ($needsBuild) {
  Info "Compilando o app (npm run build)..."
  & cmd.exe /c "npm run build"
  if ($LASTEXITCODE -ne 0) { Err "Falhou o 'npm run build'."; exit 1 }
}
Ok "App pronto."

# 4) Sobe o servidor local
$outLog = Join-Path $env:TEMP "fpstems-preview.out.log"
$errLog = Join-Path $env:TEMP "fpstems-preview.err.log"
foreach ($f in @($outLog, $errLog)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }

Info "Iniciando o servidor local..."
$server = Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c npm run preview -- --port $port --host 127.0.0.1" `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$ready = $false
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 800
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
  if ($server.HasExited) { break }
}
if (-not $ready) {
  Err "O servidor nao subiu a tempo. Log de erro: $errLog"
  if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Tail 20 }
  if ($server -and -not $server.HasExited) { try { Stop-Process -Id $server.Id -Force } catch { } }
  exit 1
}

Ok "App rodando em $url"
try { Start-Process $url } catch { }
Write-Host ""
Warn "Deixe esta janela aberta enquanto usa o app."
Warn "Para encerrar: feche esta janela ou aperte Ctrl+C."
Write-Host ""

# 5) Mantem rodando
try {
  Wait-Process -Id $server.Id
} finally {
  Warn "Encerrando o app..."
  if ($server -and -not $server.HasExited) { try { Stop-Process -Id $server.Id -Force } catch { } }
}
