param(
  [string]$DshCommand = 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd',
  [string]$Profile = 'desktop'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $DshCommand)) { throw "找不到 DSH 命令：$DshCommand" }
$archivePackage = Join-Path $PSScriptRoot 'dist\dsh-archive-manager-local-2.3.0.tgz'
if (-not (Test-Path -LiteralPath $archivePackage)) { throw '请先运行 npm run pack:plugin。' }
& $DshCommand plugin --profile $Profile add $archivePackage
if ($LASTEXITCODE -ne 0) { throw "安装失败，退出码：$LASTEXITCODE" }
Write-Host '安装完成。完全退出并重启 DSH 后，进入 设置 → 归档管理。'
