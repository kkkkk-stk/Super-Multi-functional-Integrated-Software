<#
.SYNOPSIS
    带 WebView2 远程调试端口启动 ToolForge 开发模式。

.DESCRIPTION
    `scripts/devtools/*.mjs` 全都通过 CDP（Chrome DevTools Protocol）读取
    WebView 的真实渲染状态。WebView 只有在启动时被告知开调试端口，外部才连得上 ——
    这就是本脚本存在的唯一原因。

    为什么不用窗口截图（PrintWindow）：
      WebView2 的内容由**独立的合成进程**绘制，PrintWindow 只能抓到窗口背景。
      据此判断"应用白屏"会得出**正确但理由错误**的结论（我踩过）。
      CDP 看到的就是渲染结果本身，而且能读到页面异常。

.PARAMETER Port
    CDP 端口，默认 9222。

.PARAMETER NoStop
    不清理已有的 toolforge / msedgewebview2 进程。

.EXAMPLE
    .\scripts\devtools\dev-with-cdp.ps1
    # 然后另开一个终端：
    node scripts/devtools/run.mjs

.NOTES
    重启时如果报 `failed to remove file ...toolforge.exe ... os error 32`，
    说明上一个进程还没释放文件锁。本脚本会等到 exe 可写为止才启动。
#>
[CmdletBinding()]
param(
    [int]$Port = 9222,
    [switch]$NoStop
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# ---- 1) 清掉旧进程，并**等到文件锁释放** ----
# 只 kill 不等待是常见错误：Windows 释放 exe 句柄有延迟，
# cargo 紧接着替换二进制时会报 os error 32。
if (-not $NoStop) {
    for ($i = 0; $i -lt 20; $i++) {
        $procs = Get-Process -Name toolforge, msedgewebview2 -ErrorAction SilentlyContinue
        if (-not $procs) { break }
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 700
    }
    $exe = Join-Path $repoRoot '.tools\probe\target\debug\toolforge.exe'
    if (Test-Path $exe) {
        for ($i = 0; $i -lt 20; $i++) {
            try { [System.IO.File]::OpenWrite($exe).Close(); break }
            catch { Start-Sleep -Milliseconds 500 }
        }
    }
}

# ---- 2) 工具链环境 ----
# 本仓库把 Rust / pnpm 隔离安装在工作区的 .tools 下，不污染全局 PATH。
$cargoBin = Join-Path $repoRoot '.tools\rust\cargo\bin'
$pnpmBin = Join-Path $repoRoot '.tools\pkg\node_modules\.bin'
foreach ($p in @($cargoBin, $pnpmBin)) {
    if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) { $env:PATH = "$p;$env:PATH" }
}
if (Test-Path (Join-Path $repoRoot '.tools\rust\rustup')) {
    $env:RUSTUP_HOME = Join-Path $repoRoot '.tools\rust\rustup'
    $env:CARGO_HOME = Join-Path $repoRoot '.tools\rust\cargo'
}
# 复用 devtools 的 target 缓存，避免 tauri dev 触发一次全量重建
$sharedTarget = Join-Path $repoRoot '.tools\probe\target'
if ((Test-Path $sharedTarget) -and -not $env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR = $sharedTarget
    Write-Host "复用编译缓存: $sharedTarget" -ForegroundColor DarkGray
}
# 本机若走企业代理 / TLS 中间人，Node 侧需要显式信任其根证书
$caFile = Join-Path $repoRoot '.tools\steampp-ca.pem'
if (Test-Path $caFile) { $env:NODE_EXTRA_CA_CERTS = $caFile }

# ---- 3) 开调试端口 ----
$env:WEBVIEW2_ADDITIONAL_BROWSER_OPTIONS = $null
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-allow-origins=*"

Write-Host "CDP 端口: $Port" -ForegroundColor Green
Write-Host "另一个终端里跑: node scripts/devtools/run.mjs" -ForegroundColor Green
Write-Host ''

# ---- 4) 启动 ----
Push-Location (Join-Path $repoRoot 'apps\desktop')
try {
    & (Join-Path $repoRoot 'apps\desktop\node_modules\.bin\tauri.cmd') dev
} finally {
    Pop-Location
}
