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

    ⚠️ 本文件是**带 UTF-8 BOM** 的（`.gitattributes` 另外声明了 `*.ps1 eol=crlf`）。
    两个都不是洁癖，是实测出来的必需品：
      * **没有 BOM** 时，Windows PowerShell 5.1（Windows 自带的那个）会按 **ANSI/GBK**
        解码这个文件。注释里的中文是多字节序列，其中某些字节会被当成 GBK 的**后继字节**，
        把它后面紧邻的那个 ASCII 字符**吞掉** —— 而 GBK 的后继字节范围 0x40–0x7E
        **正好包含 `}`**。于是括号配对崩掉，脚本连**解析**都过不去
        （报 `Unexpected token '}'`，指的却是一个完全正确的行）。PowerShell 7 默认按
        UTF-8 读，所以这个问题只在"用系统自带 PowerShell 跑"时出现 —— 而这正是
        Windows 用户的默认情况。
      * **行尾用 CRLF** 是给老版本 PowerShell 的解析器留的余地（见 `.gitattributes`）。

    亲测：去掉 BOM，`[Parser]::ParseFile()` 立刻报 1–2 个 `Unexpected token '}'`；
    加回去就是 0 个。
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
        # ⚠️ 只杀**本应用**的 WebView2，不要 `Get-Process msedgewebview2` 一把撸。
        # `msedgewebview2.exe` 是共享的运行时宿主：Windows 自己的 SearchHost 也在用它，
        # 无差别 kill 会把开始菜单的 WebView 一起干掉（能恢复，但不是我们该做的事）。
        # 认法：WebView2 会把自己的宿主程序名写在 `--webview-exe-name=` 里。
        $procs = @()
        $procs += Get-Process -Name toolforge -ErrorAction SilentlyContinue
        $procs += Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*--webview-exe-name=toolforge.exe*' } |
            ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
        $procs = $procs | Where-Object { $_ }
        if (-not $procs) { break }
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 700
    }

    # 锁可能**根本不属于我们**。
    #
    # 实测：本机有个带反作弊的游戏进程（`DeltaForceClient-Win64-Shipping.exe`，
    # 用 Restart Manager 查出来的）会抓住仓库里新写出来的 exe 不放，于是
    # `cargo build` 报 `failed to remove file ...toolforge.exe`。
    # 重启应用没有用 —— 句柄不在我们手里。
    #
    # 而且它**不止抓一个**：实测先抓走 `target`，换到 `target-app` 之后又被抓走。
    # 所以这里按顺序挑一个"当前可写"的编译目录，而不是写死一个备胎。
    # 挑中的目录会打印出来 —— 出问题时第一件要知道的事就是"这次到底用的哪个目录"。
    $candidates = @('target', 'target-app', 'target-app2', 'target-app3')
    $chosen = $null
    $lockedDirs = @()
    foreach ($name in $candidates) {
        $dir = Join-Path $repoRoot ('.tools\probe\' + $name)
        $exe = Join-Path $dir 'debug\toolforge.exe'
        if (-not (Test-Path $exe)) {
            # 还没有产物 —— 建一次全量（慢），但一定是干净的
            $chosen = @{ dir = $dir; name = $name; why = '还没有产物' }
            break
        }
        $free = $false
        for ($i = 0; $i -lt 6; $i++) {
            try { [System.IO.File]::OpenWrite($exe).Close(); $free = $true; break }
            catch { Start-Sleep -Milliseconds 400 }
        }
        if ($free) {
            $chosen = @{ dir = $dir; name = $name; why = 'exe 可写' }
            break
        }
        $lockedDirs += $name
    }
    if (-not $chosen) {
        # 全都锁着：只能开一个新的（代价是一次全量重建）
        $name = 'target-app' + (Get-Date -Format 'MMddHHmm')
        $chosen = @{ dir = (Join-Path $repoRoot ('.tools\probe\' + $name)); name = $name; why = '前面几个都被占用' }
    }

    if ($chosen.name -ne 'target') {
        Write-Warning ("编译目录被本应用之外的进程占用（{0}），改用 .tools\probe\{1}（{2}）" -f ($lockedDirs -join '、'), $chosen.name, $chosen.why)
    }
    $env:CARGO_TARGET_DIR = $chosen.dir
    Write-Host ("编译目录: " + $chosen.dir) -ForegroundColor DarkGray
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
# （上面已经挑好了这次的编译目录：默认 `target`，被外部进程占用时依次退到
#   `target-app` / `target-app2` / …，见那一段的注释）
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
