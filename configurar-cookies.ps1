# configurar-cookies.ps1
# Sobe o cookies.txt do YouTube para a Vercel (variavel YTDLP_COOKIES) e faz o deploy.
# Voce NUNCA copia/cola o valor: o script le o arquivo e envia sozinho.
#
# Uso:
#   .\configurar-cookies.ps1
#   .\configurar-cookies.ps1 -CookiesPath "C:\caminho\cookies.txt"

param(
  [string]$CookiesPath = ""
)

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Err($m)  { Write-Host $m -ForegroundColor Red }

function Find-CookiesFile {
  param([string]$Explicit)
  if ($Explicit) {
    if (Test-Path -LiteralPath $Explicit) { return (Get-Item -LiteralPath $Explicit).FullName }
    Err "Nao encontrei o arquivo indicado: $Explicit"
    return $null
  }
  $dirs = @("$HOME\Downloads", "$HOME\OneDrive\Downloads", "$HOME\Desktop", "$HOME\OneDrive\Desktop", (Get-Location).Path)
  $candidates = @()
  foreach ($d in $dirs) {
    if (Test-Path -LiteralPath $d) {
      $candidates += Get-ChildItem -LiteralPath $d -Filter "*.txt" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '(?i)cookie' }
    }
  }
  if ($candidates.Count -gt 0) {
    $pick = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Ok "Arquivo de cookies encontrado automaticamente: $($pick.FullName)"
    return $pick.FullName
  }
  return $null
}

# 1) Localiza e valida o arquivo de cookies
$found = Find-CookiesFile -Explicit $CookiesPath
if (-not $found) {
  Err "Nao encontrei nenhum cookies.txt."
  Write-Host ""
  Info "Como exportar os cookies do YouTube:"
  Info "  1) No Chrome logado no YouTube, instale a extensao 'Get cookies.txt LOCALLY'"
  Info "     (loja do Chrome, pesquise por 'Get cookies.txt LOCALLY')."
  Info "  2) Abra https://www.youtube.com"
  Info "  3) Clique no icone da extensao e em 'Export'."
  Info "  4) Salve o arquivo (cookies.txt) na pasta Downloads."
  Info "  5) Rode este script de novo."
  Write-Host ""
  Info "Ja tem o arquivo em outro lugar? Passe o caminho:"
  Info "  .\configurar-cookies.ps1 -CookiesPath 'C:\caminho\cookies.txt'"
  exit 1
}
$CookiesPath = $found

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

# 1.5) Valida os cookies com o yt-dlp local (se ja existir). Cookies expirados
# ("rotacionados") sao a causa numero 1 do bloqueio "Sign in to confirm you're
# not a bot" na Vercel — melhor avisar antes de subir.
$ytdlpPath = Join-Path (Get-Location).Path ".bin\yt-dlp.exe"
if (Test-Path -LiteralPath $ytdlpPath) {
  Info "Validando os cookies com o yt-dlp..."
  $probe = (& $ytdlpPath --simulate --no-playlist --cookies $CookiesPath `
      --print "%(title)s" "https://www.youtube.com/watch?v=jNQXAC9IVRw" 2>&1 | Out-String)
  if ($probe -match "(?i)no longer valid|rotated") {
    Warn "ATENCAO: o YouTube considerou estes cookies INVALIDOS (rotacionados)."
    Warn "Exporte novamente logado no YouTube e rode o script de novo."
    Warn "Se subir assim, o download na Vercel continua bloqueado."
  } elseif ($probe -match "(?i)ERROR") {
    Warn "Nao consegui validar os cookies agora (erro do yt-dlp). Sigo mesmo assim."
  } else {
    Ok "Cookies aceitos pelo yt-dlp."
  }
} else {
  Warn "yt-dlp ainda nao esta em .bin; pulando a validacao local dos cookies."
}

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
# O valor e enviado por ARQUIVO (redirecionamento). Passar via pipe do
# PowerShell trunca em ~8192 chars, corrompendo o base64 dos cookies.
$b64File = Join-Path $env:TEMP "fpstems-cookies.b64"
[IO.File]::WriteAllText($b64File, $b64)
cmd.exe /c "npx --yes vercel@latest env add YTDLP_COOKIES production < `"$b64File`""
$addCode = $LASTEXITCODE
Remove-Item -LiteralPath $b64File -Force -ErrorAction SilentlyContinue
if ($addCode -ne 0) {
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
