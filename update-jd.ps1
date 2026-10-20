# 刷新京东价：走京东公开报价接口（p.3.cn），不需要登录、不需要浏览器
# 用法: powershell -ExecutionPolicy Bypass -File update-jd.ps1
param([int]$Limit = 20)

$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
Set-Location $root

$node = $env:PRICE_NODE
if (-not $node) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $node = $c.Source } }
if (-not $node) { foreach ($p in @("C:\Program Files\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe", "D:\nodejs\node.exe")) { if (Test-Path $p) { $node = $p; break } } }
if (-not $node) { Write-Host "找不到 node.exe"; exit 1 }

Write-Host "正在用公开接口刷新京东价（最多 $Limit 个 SKU）..."
& $node "src/jd_price_api.mjs" "--limit" "$Limit"

Write-Host ""
Write-Host "重新导出快照..."
& $node "src/export.mjs"

Write-Host ""
Write-Host "完成。刷新页面即可看到新的京东价。"
Write-Host "说明：这是京东的公开报价接口，不需要登录；"
Write-Host "      如果本机 DNS 被污染（解析到内网地址）会全部连接超时，此时改用 GitHub Actions 跑。"
