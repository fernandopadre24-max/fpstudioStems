# Verifica um cookies.txt do YouTube, testa com o yt-dlp e copia o base64.
# Uso: powershell -ExecutionPolicy Bypass -File .\verificar-cookies.ps1
param([string]$Path)

$ErrorActionPreference = "Continue"

if (-not $Path) {
  $Path = (Get-ChildItem "$HOME\Downloads\*cookie*.txt" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}

Write-Host "==================== VERIFICACAO DE COOKIES ====================" -ForegroundColor Cyan

if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
  Write-Host "Nenhum *cookie*.txt encontrado em Downloads." -ForegroundColor Red
  Write-Host "Exporte logado em youtube.com com a extensao 'Get cookies.txt LOCALLY' (formato Netscape)." -ForegroundColor Yellow
  exit 1
}

$len = (Get-Item -LiteralPath $Path).Length
$first = (Get-Content -LiteralPath $Path -TotalCount 1)
Write-Host "Arquivo : $Path"
Write-Host "Tamanho : $len bytes"
Write-Host "1a linha: $first"

if ($len -lt 200) {
  Write-Host "-> ARQUIVO PEQUENO DEMAIS: o export falhou (exporte logado no YouTube)." -ForegroundColor Red
}

$ytdlp = "F:\WEB\stemroller\.bin\yt-dlp.exe"
if (Test-Path -LiteralPath $ytdlp) {
  Write-Host ""
  Write-Host "Testando autenticacao com o yt-dlp (pode demorar ~10s)..."
  & $ytdlp --cookies $Path -f "bestaudio[ext=webm]/bestaudio/best" --simulate --no-warnings "https://www.youtube.com/watch?v=fJ9rUzIMcZQ" 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "-> OK: os cookies autenticaram no YouTube." -ForegroundColor Green
  } else {
    Write-Host "-> FALHA: os cookies NAO autenticaram. Reexporte logado no YouTube." -ForegroundColor Red
  }
} else {
  Write-Host "(yt-dlp nao encontrado em $ytdlp; pulando o teste de autenticacao.)" -ForegroundColor Yellow
}

Write-Host ""
$b = [Convert]::ToBase64String([IO.File]::ReadAllBytes($Path))
Write-Host "base64 gerado: $($b.Length) caracteres (esperado: > 1000)"
Write-Host "inicio       : $($b.Substring(0, [Math]::Min(40, $b.Length)))"
Write-Host "esperado     : IyBOZXRzY2FwZSBIVFRQIENvb2tpZSBGaWxl..."

if ($b.Length -gt 1000) {
  $b | Set-Clipboard
  Write-Host ""
  Write-Host "COPIADO para a area de transferencia." -ForegroundColor Green
  Write-Host "Agora na Vercel: Settings > Environment Variables > YTDLP_COOKIES >" -ForegroundColor Green
  Write-Host "apague o Value e cole (Ctrl+V). Depois faca Redeploy." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "base64 curto demais -> NAO copiado. Conserte o export primeiro." -ForegroundColor Red
}
