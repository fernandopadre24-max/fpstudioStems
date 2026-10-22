# abrir-app.ps1
# Sobe o app no seu PC (build de producao) e publica uma URL via tunel Cloudflare.
# O download do YouTube sai do seu IP residencial -> nao sofre o bloqueio da Vercel.
# Deixe esta janela aberta enquanto usa. Ctrl+C encerra tudo.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\abrir-app.ps1
#   powershell -ExecutionPolicy Bypass -File .\abrir-app.ps1 -NoBuild   (reaproveita o dist/)

param(
  [switch]$NoBuild
)

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Err($m)  { Write-Host $m -ForegroundColor Red }

$root  = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$bin   = Join-Path $root ".bin"
if (-not (Test-Path -LiteralPath $bin)) { New-Item -ItemType Directory -Path $bin | Out-Null }

$cfPath      = Join-Path $bin "cloudflared.exe"
$urlFile     = Join-Path $bin "public-url.txt"
$localPort   = 5173
$localUrl    = "http://127.0.0.1:$localPort"
$previewLog  = Join-Path $env:TEMP "stemroller-preview.log"
$previewErr  = Join-Path $env:TEMP "stemroller-preview.err.log"
$cfLog       = Join-Path $env:TEMP "stemroller-cf.log"
$cfOut       = Join-Path $env:TEMP "stemroller-cf.out.log"

$preview = $null
$cf      = $null

function Clear-Logs {
  foreach ($f in @($previewLog, $previewErr, $cfLog, $cfOut)) {
    if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
  }
}

function Stop-Tree($proc) {
  if ($proc -and -not $proc.HasExited) {
    # Start-Process evita o NativeCommandError do PowerShell 5.1 (taskkill
    # escreve em stderr e, com ErrorActionPreference=Stop, derrubaria o script).
    try {
      Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID","$($proc.Id)","/T","/F" `
        -WindowStyle Hidden -Wait | Out-Null
    } catch { }
  }
}

# --- app (vite preview = build de producao + APIs) -------------------------
function Start-Preview {
  Info "Subindo o app em $localUrl ..."
  if (Test-Path -LiteralPath $previewLog) { Remove-Item -LiteralPath $previewLog -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $previewErr) { Remove-Item -LiteralPath $previewErr -Force -ErrorAction SilentlyContinue }
  $script:preview = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c npm run preview -- --host 127.0.0.1 --port $localPort --strictPort" `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $previewLog -RedirectStandardError $previewErr
}

function Wait-Preview {
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    try {
      $r = Invoke-WebRequest -Uri $localUrl -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    if ($preview.HasExited) { return $false }
  }
  return $false
}

# --- tunel publico ---------------------------------------------------------
function Start-Tunnel {
  if (Test-Path -LiteralPath $cfLog) { Remove-Item -LiteralPath $cfLog -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $cfOut) { Remove-Item -LiteralPath $cfOut -Force -ErrorAction SilentlyContinue }
  Info "Criando a URL publica (tunel Cloudflare)..."
  $script:cf = Start-Process -FilePath $cfPath `
    -ArgumentList "tunnel","--url","$localUrl","--no-autoupdate" `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $cfOut -RedirectStandardError $cfLog
}

function Get-TunnelUrl {
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    $txt = ""
    if (Test-Path -LiteralPath $cfLog) { $txt += (Get-Content -LiteralPath $cfLog -Raw -ErrorAction SilentlyContinue) }
    if (Test-Path -LiteralPath $cfOut) { $txt += (Get-Content -LiteralPath $cfOut -Raw -ErrorAction SilentlyContinue) }
    $m = [regex]::Match($txt, "https://[a-z0-9-]+\.trycloudflare\.com")
    if ($m.Success) { return $m.Value }
    if ($cf.HasExited) { return $null }
  }
  return $null
}

function Test-Public {
  param([string]$Url)
  if (-not $Url) { return $false }
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400)
  } catch {
    return $false
  }
}

function Publish-Url {
  param([string]$Url, [switch]$Changed)

  Set-Content -LiteralPath $urlFile -Value $Url -Encoding ASCII
  try { Set-Clipboard -Value $Url } catch { }

  Write-Host ""
  Write-Host "============================================================" -ForegroundColor Green
  Write-Host "  URL PUBLICA (use em qualquer aparelho):" -ForegroundColor Green
  Write-Host "  $Url" -ForegroundColor Green
  Write-Host "" 
  Write-Host "  Local tambem funciona: $localUrl" -ForegroundColor Green
  Write-Host "  Copiada para a area de transferencia." -ForegroundColor Green
  if ($Changed) {
    Write-Host "  (URL NOVA: o tunel reiniciou -- reenvie este link)" -ForegroundColor Yellow
  }
  Write-Host "============================================================" -ForegroundColor Green
  Write-Host ""

  try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $qrScript = Join-Path $root "scripts\print-qr.mjs"
    if (Test-Path -LiteralPath $qrScript) { & node $qrScript $Url }
  } catch {
    Warn "Nao consegui desenhar o QR: $($_.Exception.Message)"
  }

  Write-Host ""
  Warn "Deixe esta janela aberta. O app se recupera sozinho se o tunel cair."
  Warn "Para encerrar: Ctrl+C (ou feche esta janela)."
  Write-Host ""
}

# ===========================================================================
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "   FPStudio - Stems : modo local (seu IP) + URL publica" -ForegroundColor DarkCyan
Write-Host "============================================================" -ForegroundColor DarkCyan

# 1) cloudflared
if (-not (Test-Path -LiteralPath $cfPath)) {
  Info "Baixando o cloudflared (~35 MB, so na primeira vez)..."
  $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  try {
    Invoke-WebRequest -Uri $url -OutFile $cfPath -UseBasicParsing -TimeoutSec 300
  } catch {
    Err "Falha ao baixar o cloudflared: $($_.Exception.Message)"
    exit 1
  }
  if (-not (Test-Path -LiteralPath $cfPath)) { Err "Falha ao baixar o cloudflared."; exit 1 }
  Ok "cloudflared pronto."
}

# 2) build de producao
if (-not $NoBuild) {
  Info "Compilando o app (npm run build)..."
  $buildLog = Join-Path $env:TEMP "stemroller-build.log"
  $buildErr = Join-Path $env:TEMP "stemroller-build.err.log"
  # O vite avisa sobre tamanho de chunk no stderr; com PowerShell 5.1 isso vira
  # erro fatal. Start-Process redireciona para arquivo e so olhamos o ExitCode.
  $build = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run build" `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru -Wait `
    -RedirectStandardOutput $buildLog -RedirectStandardError $buildErr
  if ($build.ExitCode -ne 0) {
    Err "O build falhou. Veja: $buildLog"
    if (Test-Path -LiteralPath $buildLog) { Get-Content -LiteralPath $buildLog -Tail 25 }
    if (Test-Path -LiteralPath $buildErr) { Get-Content -LiteralPath $buildErr -Tail 25 }
    exit 1
  }
  Ok "Build pronto."
} elseif (-not (Test-Path -LiteralPath (Join-Path $root "dist\index.html"))) {
  Err "Nao existe build em dist/. Rode sem -NoBuild."
  exit 1
}

# 3) app
Clear-Logs
Start-Preview
if (-not (Wait-Preview)) {
  Err "O app nao subiu. Log: $previewLog"
  if (Test-Path -LiteralPath $previewErr) { Get-Content -LiteralPath $previewErr -Tail 25 }
  Stop-Tree $preview
  exit 1
}
Ok "App rodando em $localUrl"

# 4) pre-aquece o yt-dlp (o primeiro download do usuario ja sai rapido)
try {
  Info "Preparando o yt-dlp (primeira vez baixa ~18 MB)..."
  Invoke-WebRequest -Uri "$localUrl/api/youtube/status?prepare=1" -UseBasicParsing -TimeoutSec 180 | Out-Null
  Ok "yt-dlp pronto."
} catch {
  Warn "Nao consegui preparar o yt-dlp agora (o app baixa no primeiro uso)."
}

# 5) tunel
Start-Tunnel
$publicUrl = Get-TunnelUrl
if (-not $publicUrl) {
  Err "Nao consegui criar a URL publica. Continue no local: $localUrl"
  if (Test-Path -LiteralPath $cfLog) { Get-Content -LiteralPath $cfLog -Tail 20 }
} else {
  Publish-Url -Url $publicUrl
  try { Start-Process $publicUrl } catch { }
}

# 6) vigia: app morreu -> sobe de novo; tunel caiu -> recria e publica URL nova
$fails = 0
try {
  while ($true) {
    Start-Sleep -Seconds 12

    # Tunel no ar mas sem URL publicada (ex.: o log demorou): tenta de novo.
    if (-not $publicUrl -and -not $cf.HasExited) {
      $late = Get-TunnelUrl
      if ($late) {
        $publicUrl = $late
        Publish-Url -Url $publicUrl -Changed
        $fails = 0
        continue
      }
    }

    if ($preview.HasExited) {
      Warn "O app parou. Reiniciando..."
      Start-Preview
      if (Wait-Preview) { Ok "App de volta em $localUrl" } else { Warn "O app ainda nao respondeu." }
      $fails = 0
    }

    if ($cf.HasExited) {
      Warn "O tunel caiu. Recriando..."
      Start-Tunnel
      $newUrl = Get-TunnelUrl
      if ($newUrl) {
        $publicUrl = $newUrl
        Publish-Url -Url $publicUrl -Changed
      } else {
        Warn "Ainda sem URL publica; tento de novo em instantes."
      }
      $fails = 0
      continue
    }

    if ($publicUrl) {
      if (Test-Public -Url $publicUrl) {
        $fails = 0
      } else {
        $fails += 1
        if ($fails -ge 3) {
          Warn "A URL publica parou de responder. Recriando o tunel..."
          Stop-Tree $cf
          Start-Tunnel
          $newUrl = Get-TunnelUrl
          if ($newUrl) {
            $publicUrl = $newUrl
            Publish-Url -Url $publicUrl -Changed
          }
          $fails = 0
        }
      }
    }
  }
} finally {
  Warn "Encerrando..."
  Stop-Tree $cf
  Stop-Tree $preview
  if (Test-Path -LiteralPath $urlFile) {
    Remove-Item -LiteralPath $urlFile -Force -ErrorAction SilentlyContinue
  }
}
