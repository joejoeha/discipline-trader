$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$cargoRoot = Join-Path $workspaceRoot "tools\cargo"
$rustupRoot = Join-Path $workspaceRoot "tools\rustup"
$preferredTargetDir = "D:\discipline-trader-build-cache"

if (Test-Path -LiteralPath $cargoRoot) {
  $env:CARGO_HOME = $cargoRoot
  $env:RUSTUP_HOME = $rustupRoot
  $env:Path = "$cargoRoot\bin;$env:Path"
}

if (Test-Path -LiteralPath "D:\") {
  # 编译缓存放在空间充足的 D 盘，避免开发预览挤满系统盘。
  $env:CARGO_TARGET_DIR = $preferredTargetDir
}

Set-Location -LiteralPath $projectRoot
pnpm preview:desktop
