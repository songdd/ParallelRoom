# ParallelRoom 启动脚本（PowerShell 版）
# 本机若提示「脚本已被禁用」，用这条命令运行：
#   powershell -ExecutionPolicy Bypass -File start.ps1
# 用法：右键「使用 PowerShell 运行」，或 .\start.ps1
#      .\start.ps1 --rooms "460102249360,736168918844"

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$exe = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $exe)) {
  Write-Host '[!] 没找到 Electron，开始安装依赖（首次可能需要几分钟）...' -ForegroundColor Yellow

  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Write-Host '[x] 找不到 npm，请先安装 Node.js：https://nodejs.org/' -ForegroundColor Red
    exit 1
  }

  & npm.cmd install --no-audit --no-fund

  if (-not (Test-Path $exe)) {
    Write-Host '[i] Electron 二进制缺失，尝试用 npmmirror 镜像补装...' -ForegroundColor Yellow
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    & node (Join-Path $PSScriptRoot 'node_modules\electron\install.js')
  }

  if (-not (Test-Path $exe)) {
    Write-Host '[x] Electron 安装失败。请手动执行：npm install' -ForegroundColor Red
    exit 1
  }
}

Start-Process -FilePath $exe -ArgumentList (@('.') + $args)
