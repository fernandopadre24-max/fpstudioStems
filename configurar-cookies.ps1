# configurar-cookies.ps1
# Sobe o cookies.txt do YouTube para a Vercel (variavel YTDLP_COOKIES) e faz o deploy.
# Voce NUNCA copia/cola o valor: o script le o arquivo e envia sozinho.
#
# Uso:
#   .\configurar-cookies.ps1
#   .\configurar-cookies.ps1 -CookiesPath "C:\caminho\cookies.txt"

param(
  [string]$CookiesPath = (Join-Path $HOME "Downloads\cookies.txt")
)

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Err($m)  { Write-Host $m -ForegroundColor Red }

# 1) Localiza e valida o arquivo de cookies
if (-not (Test-Path -LiteralPath $CookiesPath)) {
  Err "Nao encontrei o arquivo: $CookiesPath"
  Info "Exporte os cookies do YouTube com a extensao 'Get cookies.txt LOCALLY'"
  Info "(instale no Chrome logado no YouTube, clique em Export) e salve como:"
  Info "  $CookiesPath"
  Info "Ou passe o caminho:  .\configurar-cookies.ps1 -CookiesPath 'C:\caminho\cookies.txt'"
  exit 1
}

$content = Get-Content -LiteralPath $CookiesPath -Raw
$tabLines = ($content -split "`n" | Where-Object { ([regex]::Matches($_, "\t")).Count -ge 6 }).Count
if ($content -notmatch '# Netscape HTTP Cookie File' -and $tabLines -eq 0) {
  Err "O arquivo nao parece um cookies.txt no formato Netscape."
  Info "Exporte novamente com a extensao 'Get cookies.txt LOCALLY'."
  exit 1
}
if ($content -notmatch '\.youtube\.com') {
  Warn "Aviso: nao encontrei '.youtube.com' no arquivo. Confirme que exportou logado no YouTube."
}

# base64 de uma linha so: evita problemas de quebra de linha no envio
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($CookiesPath))
$sizeKb = [math]::Round((Get-Item -LiteralPath $CookiesPath).Length / 1kb, 1)
Ok "cookies.txt OK ($sizeKb KB, $($content.Length) chars)"

# 2) Vercel CLI + login
Info "Verificando a Vercel CLI (pode baixar na primeira vez)..."
$who = (npx --yes vercel@latest whoami 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $who -match '(?i)error|not logged') {
  Warn "Voce nao esta logado na Vercel. Abrindo o login (siga no navegador)..."
  npx --yes vercel@latest login
} else {
  Ok "Logado como: $($who.Trim())"
}

# 3) Link do projeto (uma vez)
if (-not (Test-Path -LiteralPath ".vercel\project.json")) {
  Warn "Este diretorio ainda nao esta vinculado a um projeto Vercel."
  Info "Vou rodar 'vercel link'. Escolha LINKAR a um projeto EXISTENTE e selecione o do app."
  npx --yes vercel@latest link
} else {
  Ok "Diretorio ja vinculado a um projeto Vercel."
}

# 4) Define a variavel (remove a antiga e adiciona a nova)
Info "Configurando a variavel YTDLP_COOKIES (production)..."
npx --yes vercel@latest env rm YTDLP_COOKIES production --yes 2>&1 | Out-Null
$b64 | npx --yes vercel@latest env add YTDLP_COOKIES production
if ($LASTEXITCODE -ne 0) {
  Err "Falha ao definir a variavel. Veja as mensagens acima."
  exit 1
}
Ok "Variavel YTDLP_COOKIES definida."

# 5) Deploy de producao
Info "Fazendo deploy de producao (a nova variavel so vale num deploy novo)..."
npx --yes vercel@latest --prod
if ($LASTEXITCODE -ne 0) {
  Err "Falha no deploy. Se preferir, faca um redeploy pelo painel da Vercel."
  exit 1
}
Ok "Deploy concluido."

# 6) Teste rapido do endpoint
Info "Aguardando propagacao e testando o download de audio..."
Start-Sleep 12
$code = (curl.exe -s -o "$env:TEMP\yt-test.bin" -w "%{http_code}" --max-time 90 "https://fpsstems.vercel.app/api/youtube/audio?id=kJQP7kiw5Fk")
if ($code -eq "200") {
  Ok "FUNCIONOU! O download de audio do YouTube esta liberado em producao."
} else {
  Warn "Retorno HTTP $code. Veja o detalhe:"
  if (Test-Path "$env:TEMP\yt-test.bin") {
    $body = Get-Content -LiteralPath "$env:TEMP\yt-test.bin" -Raw
    if ($body -match '^\s*\{') { Write-Host $body }
  }
  Info "Se aparecer 'cookies:sim' no detalhe, os cookies foram aceitos; pode ser bloqueio momentaneo."
}
