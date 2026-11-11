param(
  [string]$DshCommand = 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd',
  [string]$Profile = 'desktop'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $DshCommand)) { throw "找不到 DSH 桌面命令：$DshCommand" }
$pluginArchive = Join-Path $PSScriptRoot 'dist\dsh-usage-stats-local-1.3.1.tgz'
if (-not (Test-Path -LiteralPath $pluginArchive)) { throw '请先在插件目录运行 npm run pack:plugin。' }
& $DshCommand plugin --profile $Profile add $pluginArchive
if ($LASTEXITCODE -ne 0) { throw "插件安装失败，退出码：$LASTEXITCODE" }
Write-Host '安装完成。请完全退出并重新打开 DSH，在 设置 → 使用统计 查看。'
