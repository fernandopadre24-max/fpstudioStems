# criar-atalho.ps1
# Cria um atalho "FPStudio Stems" na Area de Trabalho para abrir o app local.
$ErrorActionPreference = "Stop"

$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$desktop = [Environment]::GetFolderPath("Desktop")
$lnk = Join-Path $desktop "FPStudio Stems.lnk"
$target = Join-Path $root "iniciar-app.cmd"

if (-not (Test-Path -LiteralPath $target)) {
  Write-Host "Nao encontrei 'iniciar-app.cmd' em $root." -ForegroundColor Red
  exit 1
}

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $target
$sc.WorkingDirectory = $root
$sc.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,137"
$sc.Description = "FPStudio - Stems (app local)"
$sc.Save()

Write-Host "Atalho criado na Area de Trabalho:" -ForegroundColor Green
Write-Host "  $lnk" -ForegroundColor Green
Write-Host "Clique duas vezes em 'FPStudio Stems' para abrir o app." -ForegroundColor Cyan
