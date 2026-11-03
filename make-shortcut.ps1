# 在桌面（和开始菜单）创建 ParallelRoom 快捷方式：双击就启动，不用开终端
# 用法：右键"使用 PowerShell 运行"，或在项目目录执行
#   powershell -ExecutionPolicy Bypass -File .\make-shortcut.ps1
# 想删掉快捷方式：加 -Remove

param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$targets = @(
  (Join-Path $desktop 'ParallelRoom.lnk'),
  (Join-Path $startMenu 'ParallelRoom.lnk')
)

if ($Remove) {
  foreach ($t in $targets) {
    if (Test-Path $t) {
      Remove-Item $t -Force
      Write-Host "已删除 $t"
    }
  }
  exit 0
}

if (-not (Test-Path $electron)) {
  Write-Host "找不到 electron：$electron" -ForegroundColor Red
  Write-Host "先装依赖：npm.cmd install，或补下载 electron 二进制：" -ForegroundColor Yellow
  Write-Host '  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"; node .\node_modules\electron\install.js'
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
  $lnk = $shell.CreateShortcut($t)
  $lnk.TargetPath = $electron
  # electron.exe 后面跟项目目录 = 启动这个应用
  $lnk.Arguments = '"' + $root + '"'
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$electron,0"
  $lnk.Description = 'ParallelRoom - 同一账号多看几个直播间的桌面工具'
  $lnk.WindowStyle = 1
  $lnk.Save()
  Write-Host "已创建 $t"
}

Write-Host ''
Write-Host '双击桌面的 ParallelRoom 就能启动。' -ForegroundColor Green
Write-Host '想删掉：powershell -ExecutionPolicy Bypass -File .\make-shortcut.ps1 -Remove'
