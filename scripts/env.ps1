# ToolForge 本地工具链环境（沙箱 / CI 隔离安装用）
#
#   . .\scripts\env.ps1
#
# 该脚本把 Rust 工具链与 pnpm 指向仓库内的 .tools/ 目录，
# 这样不需要污染用户级 PATH / CARGO_HOME。
# 如果你已经全局安装了 Rust 与 pnpm，可以不使用本脚本。

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

$env:RUSTUP_HOME = Join-Path $repoRoot '.tools\rust\rustup'
$env:CARGO_HOME  = Join-Path $repoRoot '.tools\rust\cargo'

$cargoBin = Join-Path $env:CARGO_HOME 'bin'
$pnpmBin  = Join-Path $repoRoot '.tools\pkg\node_modules\.bin'

foreach ($p in @($cargoBin, $pnpmBin)) {
    if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) {
        $env:PATH = "$p;$env:PATH"
    }
}

# 本机（以及部分企业网络）存在 TLS 中间人代理时，Node 侧需要显式信任代理根证书。
$caFile = Join-Path $repoRoot '.tools\steampp-ca.pem'
if (Test-Path $caFile) {
    $env:NODE_EXTRA_CA_CERTS = $caFile
}

# cargo 使用 sparse 索引；镜像可通过环境变量覆盖
if (-not $env:CARGO_REGISTRIES_CRATES_IO_PROTOCOL) {
    $env:CARGO_REGISTRIES_CRATES_IO_PROTOCOL = 'sparse'
}
$env:CARGO_TERM_COLOR = 'always'

Write-Host "ToolForge env ready" -ForegroundColor Green
if (Test-Path $cargoBin) { Write-Host ("  rustc : " + (& (Join-Path $cargoBin 'rustc.exe') -V 2>$null)) }
if (Test-Path $pnpmBin)  { Write-Host ("  pnpm  : " + (& (Join-Path $pnpmBin 'pnpm.cmd') -v 2>$null)) }
Write-Host ("  repo  : " + $repoRoot)
