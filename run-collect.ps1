# 比价项目 · 定时采集（计划任务调用）
# 说明：路径全部基于脚本所在目录，换电脑不用改
# 注意：本文件必须保存为 UTF-8 with BOM，否则 PowerShell 5.1 会把中文路径读乱

$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
Set-Location $root

$logs = Join-Path $root "logs"
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$log = Join-Path $logs "collect.log"

# —— 找 Node（环境变量 PRICE_NODE > PATH > 常见安装位置）——
function Find-Node {
  if ($env:PRICE_NODE -and (Test-Path $env:PRICE_NODE)) { return $env:PRICE_NODE }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @(
      "C:\Program Files\nodejs\node.exe",
      "C:\Program Files (x86)\nodejs\node.exe",
      "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
      "D:\nodejs\node.exe"
    )) { if (Test-Path $p) { return $p } }
  return $null
}
$node = Find-Node
if (-not $node) {
  Add-Content -Path $log -Value "找不到 node.exe，请安装 Node 22.5+ 或设置环境变量 PRICE_NODE" -Encoding UTF8
  exit 1
}

function Write-Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
  Add-Content -Path $log -Value $line -Encoding UTF8
}

Write-Log "==== round start（node: $node）===="

$jobs = @(
  @{ cat = "vga";       limit = 22; extra = @("--filter", "modern") },
  @{ cat = "memory";    limit = 20; extra = @() },
  @{ cat = "power";     limit = 16; extra = @() },
  @{ cat = "case";      limit = 16; extra = @() },
  @{ cat = "keyboard";  limit = 16; extra = @() },
  @{ cat = "router";    limit = 12; extra = @() },
  @{ cat = "projector"; limit = 12; extra = @() },
  @{ cat = "notebook";  limit = 8;  extra = @() }
)

foreach ($j in $jobs) {
  $a = @("src/collect.mjs", "--category", $j.cat, "--limit", "$($j.limit)") + $j.extra
  $out = & $node @a 2>&1
  $summary = ($out | Select-String -Pattern "本轮:" | Select-Object -Last 1)
  Write-Log ("[" + $j.cat + "] " + ($(if ($summary) { $summary.ToString().Trim() } else { "no summary" })))
  Add-Content -Path $log -Value ($out -join "`n") -Encoding UTF8
}

# 收敛 + 去重 + 补图 + 导出（顺序不能反）
foreach ($step in @("src/dedupe_products.mjs", "src/trim.mjs", "src/quality.mjs", "src/images.mjs", "src/export.mjs")) {
  $out = & $node $step 2>&1
  Write-Log ("[" + $step + "] done")
  Add-Content -Path $log -Value ($out -join "`n") -Encoding UTF8
}

Write-Log "==== round done ===="
