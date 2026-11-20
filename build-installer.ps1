<#
  ParallelRoom 一键生成 Windows 安装包
  =====================================
  用法（在仓库根目录）：
      powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
            → dist\ParallelRoom-Setup-<版本>.exe（安装版） + dist\ParallelRoom-<版本>-portable-win-x64.zip（绿色版）
      powershell -ExecutionPolicy Bypass -File .\build-installer.ps1 -ZipOnly       # 只要绿色版 zip
      powershell -ExecutionPolicy Bypass -File .\build-installer.ps1 -DirOnly       # 只要免安装目录（最快，自检用）
      powershell -ExecutionPolicy Bypass -File .\build-installer.ps1 -SkipRender    # 跳过 esbuild 重新打包渲染层

  它会依次做：
      0. 检查环境（node / npm / electron / electron-builder）
      1. 准备 Electron 离线缓存（本机装过的 electron zip 直接复用，不用联网下载官方包）
      2. 检查 vendor\ffmpeg\ffmpeg.exe + ffprobe.exe（安装版必须随包，否则录制/剪辑用不了）
      3. 检查 / 生成图标 build\icon.ico（没有就由 build\icon.png 生成；png 也没有就用 ffmpeg 画一个）
      4. npm run check（语法检查）
      5. npm run build:render（esbuild 重新打 studio/stage bundle，必须做，否则装的是旧前端）
      6. electron-builder 出安装包（NSIS，per-user，可改安装目录）；配了证书就顺手签名
      7. 打印成品路径 / 体积 + 冒烟检查（resources\ffmpeg 是否进包、exe/asar 是否生成、签名状态）

  签名（可选，三条路线按环境变量自动识别，脚本本身不用改）：
      A. pfx 文件        $env:CSC_LINK = 'D:\cert\my.pfx'; $env:CSC_KEY_PASSWORD = '密码'
      B. USB 令牌 / EV    $env:PR_SIGN_SUBJECT = '证书上 issued to 的那个名字'   # 令牌插好、证书在「个人」存储
      C. Azure 云签名     $env:AZURE_TRUSTED_SIGNING_ENDPOINT / _PROFILE / _ACCOUNT / _PUBLISHER
                          + $env:AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
      时间戳默认 http://timestamp.digicert.com，可用 $env:PR_SIGN_TIMESTAMP 换成别的时间戳服务器
      一个都不配 → 出未签名包（安装时提示「未知发布者」，属正常）

  说明：
      · 只动 dist\ 和 .tmp\，不碰 output\ 里的录制文件、不碰 %APPDATA% 里的登录状态
      · 打包全程可离线：Electron 走本机缓存，NSIS / 7zip 走 %LOCALAPPDATA%\electron-builder\Cache
      · 签名用 signtool 时需要一个能联网访问的时间戳服务器（只签名不联外网会失败）
#>

param(
  [switch]$SkipRender,
  [switch]$DirOnly,
  [switch]$ZipOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  √ $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Die($msg) { Write-Host "  × $msg" -ForegroundColor Red; exit 1 }

# npm 一律走 npm.cmd：直接写 npm 时 PowerShell 可能命中 npm.ps1，被执行策略挡住
# 注意：调用处不要写成 `$x = RunNpm ...`（会把 npm 的输出当返回值吞掉），
#       也绝对不要加 `2>&1`（esbuild 往 stderr 写日志，PS 5.1 会把它变成
#       NativeCommandError，配上 ErrorActionPreference=Stop 就直接终止脚本）
function RunNpm([string[]]$npmArgs) {
  & npm.cmd @npmArgs
}

# ---------- 0. 环境 ----------
Step '0/7 检查环境'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die '找不到 node，先装 Node.js' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Die '找不到 npm.cmd' }
if (-not (Test-Path 'node_modules\electron-builder')) { Die '没装 electron-builder：先跑 npm install' }
if (-not (Test-Path 'node_modules\electron\dist\electron.exe')) { Die '没装 electron：先跑 npm install' }
# 版本号用 node 读（PowerShell 5.1 读 UTF-8 中文会乱码，ConvertFrom-Json 会直接报错）
$appVer = node -p "require('./package.json').version"
$ebVer = node -p "require('./node_modules/electron/package.json').version"
$bbVer = node -p "require('./node_modules/electron-builder/package.json').version"
$nodeVer = node -p "process.versions.node"
Ok ("node {0} / 应用 {1} / electron {2} / electron-builder {3}" -f $nodeVer, $appVer, $ebVer, $bbVer)

$drive = Get-PSDrive -Name (Split-Path -Qualifier $root).TrimEnd(':') -ErrorAction SilentlyContinue
if ($drive -and $drive.Free -lt 3GB) { Warn ("盘上只剩 {0:N1} GB，出包要 ~1 GB 空间" -f ($drive.Free / 1GB)) }

# ---------- 1. Electron 离线缓存 ----------
# electron-builder 只会去 github 的 release 地址取 electron zip，命中条件是
#   %LOCALAPPDATA%\electron\Cache\<sha256(github 目录URL)>\electron-v<ver>-win32-x64.zip
# 国内网络下 github 基本连不上（表现为一直卡在 packaging 那一步）。
# 本机 npm install 时下过同一份 zip（走 npmmirror，落在另一个 hash 目录），
# 这里把它搬/连到 github 那个目录，并补一份 SHASUMS256.txt-<ver> 种子，
# 让 electron-builder 校验也能离线完成（否则它还要联网拉 SHASUMS256.txt）。
Step '1/7 准备 Electron 离线缓存'
$ebCacheRoot = Join-Path $env:LOCALAPPDATA 'electron\Cache'
$zipName = "electron-v$ebVer-win32-x64.zip"
$ghUrl = "https://github.com/electron/electron/releases/download/v$ebVer/$zipName"
$ghDir = node -e "const c=require('crypto'),p=require('path');const u=new URL(process.argv[1]);u.hash='';u.search='';u.pathname=p.posix.dirname(u.pathname);process.stdout.write(c.createHash('sha256').update(u.toString()).digest('hex'))" $ghUrl
if (-not $ghDir) { $ghDir = '' }
$targetDir = Join-Path $ebCacheRoot $ghDir
$targetZip = Join-Path $targetDir $zipName

if (Test-Path $targetZip) {
  $hash = (Get-FileHash $targetZip -Algorithm SHA256).Hash.ToLower()
  Ok ("已就位：{0}（{1} MB）" -f $zipName, [math]::Round((Get-Item $targetZip).Length / 1MB, 1))
} else {
  $found = Get-ChildItem $ebCacheRoot -Recurse -File -Filter $zipName -ErrorAction SilentlyContinue |
    Sort-Object Length -Descending | Select-Object -First 1
  if (-not $found) {
    Warn "本机没缓存 $zipName"
    Warn '出包时 electron-builder 会自己去下载 Electron（国内网络可能卡住）'
    Warn '如卡在 packaging：设 $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" 再重跑'
    $hash = ''
  } else {
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    $copied = $false
    try {
      New-Item -ItemType HardLink -Path $targetZip -Target $found.FullName -ErrorAction Stop | Out-Null
      $copied = $true
    } catch {
      try { Copy-Item $found.FullName $targetZip -Force -ErrorAction Stop; $copied = $true } catch { }
    }
    if (-not $copied) { Die "复用缓存失败：$($found.FullName) → $targetZip" }
    $hash = (Get-FileHash $targetZip -Algorithm SHA256).Hash.ToLower()
    Ok ("复用本机缓存 → {0}（{1} MB，来源 {2}）" -f $zipName, [math]::Round((Get-Item $targetZip).Length / 1MB, 1), $found.Directory.Name.Substring(0, 8))
  }
}
if ($hash) {
  $seed = Join-Path $ebCacheRoot "SHASUMS256.txt-$ebVer"
  Set-Content -Path $seed -Value "$hash *$zipName" -Encoding ASCII
  Ok ("离线校验种子就位：SHASUMS256.txt-{0}" -f $ebVer)
}

# ---------- 2. ffmpeg ----------
Step '2/7 检查随包工具 ffmpeg / ffprobe'
$ff = 'vendor\ffmpeg\ffmpeg.exe'
$fp = 'vendor\ffmpeg\ffprobe.exe'
if (-not (Test-Path $ff) -or -not (Test-Path $fp)) {
  Warn "vendor\ffmpeg 里缺 ffmpeg.exe / ffprobe.exe"
  $src = 'D:\tools\ffmpeg-8.1.1-essentials_build\bin'
  if ((Test-Path "$src\ffmpeg.exe") -and (Test-Path "$src\ffprobe.exe")) {
    New-Item -ItemType Directory -Force -Path vendor\ffmpeg | Out-Null
    Copy-Item "$src\ffmpeg.exe" $ff -Force
    Copy-Item "$src\ffprobe.exe" $fp -Force
    Ok "已从 $src 复制进来"
  } else {
    Die '找不到 ffmpeg：把 ffmpeg.exe / ffprobe.exe 放进 vendor\ffmpeg\ 再重跑（见 vendor\ffmpeg\README.md）'
  }
}
$ffMB = [math]::Round((Get-Item $ff).Length / 1MB, 1)
$fpMB = [math]::Round((Get-Item $fp).Length / 1MB, 1)
Ok ("ffmpeg {0} MB + ffprobe {1} MB = 随包 +{2} MB" -f $ffMB, $fpMB, ($ffMB + $fpMB))

# ---------- 3. 图标 ----------
Step '3/7 检查图标'
if (-not (Test-Path 'build\icon.ico')) {
  if (-not (Test-Path 'build\icon.png')) {
    Warn 'build\icon.png 也没有，用 ffmpeg 生成一个纯色占位图标（建议之后换成自己的）'
    New-Item -ItemType Directory -Force -Path build, .tmp | Out-Null
    & $ff -hide_banner -loglevel error -y -f lavfi -i 'color=c=0x141821:s=256x256' `
      -vf 'drawbox=x=16:y=40:w=104:h=76:color=0xff5c8c@0.9:t=fill,drawbox=x=136:y=40:w=104:h=76:color=0x5ee08a@0.9:t=fill,drawbox=x=16:y=140:w=104:h=76:color=0x6ea8ff@0.9:t=fill,drawbox=x=136:y=140:w=104:h=76:color=0xffd18a@0.9:t=fill' `
      -frames:v 1 build\icon.png
  }
  node scripts\make-ico.js build\icon.png build\icon.ico
}
Ok ("build\icon.ico {0} 字节" -f (Get-Item 'build\icon.ico').Length)

# ---------- 4. 语法检查 ----------
Step '4/7 npm run check'
RunNpm @('run', 'check')
if ($LASTEXITCODE -ne 0) { Die '语法检查没过' }
Ok '语法检查通过'

# ---------- 5. 渲染层 bundle ----------
Step '5/7 重新打包渲染层（esbuild）'
if ($SkipRender) {
  Warn '按参数跳过（注意：用的还是上一次的 studio/stage bundle）'
} else {
  RunNpm @('run', 'build:render')
  if ($LASTEXITCODE -ne 0) { Die 'esbuild 失败' }
  foreach ($b in @('src\renderer\studio.bundle.js', 'src\renderer\stage.bundle.js')) {
    Ok ("{0} {1} MB" -f (Split-Path $b -Leaf), [math]::Round((Get-Item $b).Length / 1MB, 2))
  }
}

# ---------- 6. 出包（配了证书就顺便签名） ----------
Step '6/7 electron-builder 出安装包（几分钟，别关窗口）'
if (Test-Path dist) {
  Warn '清掉旧的 dist（避免混进旧 asar / 旧 installer）'
  Remove-Item dist -Recurse -Force
}

# 签名三条路线，按环境变量自动识别（不用改脚本，配好环境变量重跑就行）：
#   A. pfx 文件      CSC_LINK + CSC_KEY_PASSWORD                      （2023 后公共 CA 不再签 pfx，主要是自签名/内网 CA 用）
#   B. USB 令牌 / EV  PR_SIGN_SUBJECT="证书上 issued to 的名字"          （令牌插好，证书在「个人」证书存储）
#   C. Azure 云签名   AZURE_TRUSTED_SIGNING_ENDPOINT / _PROFILE / _ACCOUNT
#                     + AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
Step '6.5/7 检查签名配置'
$signArgs = @()
$signMode = 'none'
if ($env:CSC_LINK) {
  $signMode = 'pfx'
  if ((Test-Path $env:CSC_LINK) -or $env:CSC_LINK.Length -gt 500) {
    Ok 'pfx 签名：CSC_LINK 已设置（electron-builder 自己会读）'
  } else {
    Warn "CSC_LINK 指向的文件不存在：$($env:CSC_LINK)"
  }
} elseif ($env:PR_SIGN_SUBJECT) {
  $signMode = 'token'
  $signArgs += "-c.win.signtoolOptions.certificateSubjectName=$($env:PR_SIGN_SUBJECT)"
  Ok "令牌 / EV 签名：certificateSubjectName=$($env:PR_SIGN_SUBJECT)"
} elseif ($env:AZURE_TRUSTED_SIGNING_ENDPOINT -and $env:AZURE_TRUSTED_SIGNING_PROFILE -and $env:AZURE_TRUSTED_SIGNING_ACCOUNT) {
  $signMode = 'azure'
  $signArgs += "-c.win.azureSignOptions.endpoint=$($env:AZURE_TRUSTED_SIGNING_ENDPOINT)"
  $signArgs += "-c.win.azureSignOptions.certificateProfileName=$($env:AZURE_TRUSTED_SIGNING_PROFILE)"
  $signArgs += "-c.win.azureSignOptions.codeSigningAccountName=$($env:AZURE_TRUSTED_SIGNING_ACCOUNT)"
  $signArgs += "-c.win.azureSignOptions.publisherName=$($env:AZURE_TRUSTED_SIGNING_PUBLISHER)"
  Ok ("Azure Trusted Signing：{0} / {1} / {2}" -f $env:AZURE_TRUSTED_SIGNING_ACCOUNT, $env:AZURE_TRUSTED_SIGNING_PROFILE, $env:AZURE_TRUSTED_SIGNING_ENDPOINT)
} else {
  Warn '没配签名证书 → 这次出的是未签名包（别人装会看到「未知发布者」）'
  Warn '要签名：见 README「代码签名（可选）」，配好环境变量重跑本脚本即可，脚本不用改'
}
if ($signMode -ne 'none') {
  $ts = if ($env:PR_SIGN_TIMESTAMP) { $env:PR_SIGN_TIMESTAMP } else { 'http://timestamp.digicert.com' }
  $signArgs += "-c.win.signtoolOptions.rfc3161TimeStampServer=$ts"
  Ok "时间戳服务器：$ts（证书过期后签名依然有效）"
}

$ebWinTargets = @()
if ($DirOnly) { $ebWinTargets = @('dir') }
elseif ($ZipOnly) { $ebWinTargets = @('zip') }
else { $ebWinTargets = @('nsis', 'zip') }
Ok ("产出目标：{0}" -f ($ebWinTargets -join ' + '))
# 直接调 electron-builder 的 cli.js：签名参数带 `-c.xxx=yyy`，走 npm run 还要绕一层 `--`，容易把引号弄丢
& node node_modules\electron-builder\cli.js --win @ebWinTargets --x64 @signArgs
if ($LASTEXITCODE -ne 0) { Die 'electron-builder 失败（看上面的报错；常见原因：Electron/NSIS 下载、证书/令牌没就绪、杀软锁文件）' }

# ---------- 7. 冒烟检查 ----------
Step '7/7 冒烟检查'
$unpacked = 'dist\win-unpacked'
if (-not (Test-Path "$unpacked\ParallelRoom.exe")) { Die "没生成 $unpacked\ParallelRoom.exe" }
foreach ($need in @('resources\ffmpeg\ffmpeg.exe', 'resources\ffmpeg\ffprobe.exe', 'resources\app.asar')) {
  if (-not (Test-Path "$unpacked\$need")) { Die "缺 $need —— 打包配置有问题" }
  Ok "$need 已进包"
}
$exeMB = [math]::Round((Get-Item "$unpacked\ParallelRoom.exe").Length / 1MB, 1)
$asarMB = [math]::Round((Get-Item "$unpacked\resources\app.asar").Length / 1MB, 2)
$unpackedMB = [math]::Round((Get-ChildItem $unpacked -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Ok "ParallelRoom.exe $exeMB MB / app.asar $asarMB MB / 免安装目录共 $unpackedMB MB"

# 签名校验：没签名就明说，签了就把发行者 / 指纹 / 有效期 / 有没有时间戳打出来
$signTargets = @("$unpacked\ParallelRoom.exe")
$setupExe = Get-ChildItem dist -Filter 'ParallelRoom-Setup-*.exe' | Sort-Object LastWriteTime | Select-Object -Last 1
if ($setupExe) { $signTargets += $setupExe.FullName }
foreach ($t in $signTargets) {
  $sig = Get-AuthenticodeSignature -FilePath $t
  $name = Split-Path $t -Leaf
  if (-not $sig.SignerCertificate) {
    Warn "$name 未签名（Status=$($sig.Status)）"
    continue
  }
  $cert = $sig.SignerCertificate
  $ts = $sig.TimeStamperCertificate
  $line = "{0}：{1} | 发行者 {2} | 指纹 {3} | 有效至 {4} | 时间戳 {5}" -f `
    $name, $sig.Status, $cert.Subject, $cert.Thumbprint.Substring(0, 16), $cert.NotAfter.ToString('yyyy-MM-dd'), `
    $(if ($ts) { '有（' + $ts.Subject + '）' } else { '无' })
  if ($sig.Status -eq 'Valid') { Ok $line } else { Warn $line }
  if ($sig.Status -ne 'Valid' -and $signMode -ne 'none') {
    Warn '（自签名证书 / 根证书没进「受信任的根证书颁发机构」时就是这个 Status，属正常）'
  }
}

# 绿色版 zip：把 build\portable.txt 塞进 zip 根目录（exe 旁边）→ 解压后就是便携模式
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
$zipArtifact = Get-ChildItem dist -Filter 'ParallelRoom-*portable-win-x64.zip' | Sort-Object LastWriteTime | Select-Object -Last 1
if ($zipArtifact) {
  $marker = 'build\portable.txt'
  if (-not (Test-Path $marker)) { Die "缺 $marker（绿色版靠它开启便携模式）" }
  try {
    $z = [System.IO.Compression.ZipFile]::Open($zipArtifact.FullName, 'Update')
    try {
      $old = $z.GetEntry('portable.txt')
      if ($old) { $old.Delete() }
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, (Resolve-Path $marker).Path, 'portable.txt') | Out-Null
    } finally { $z.Dispose() }
    Ok 'portable.txt 已写进 zip 根目录（解压即便携模式）'
  } catch {
    Die "往 zip 里写 portable.txt 失败：$($_.Exception.Message)"
  }
  # 校验：zip 里该有的东西一个都不能少
  $z = [System.IO.Compression.ZipFile]::OpenRead($zipArtifact.FullName)
  try {
    $names = @($z.Entries | ForEach-Object { $_.FullName })
    $entryCount = $names.Count
  } finally { $z.Dispose() }
  foreach ($need in @('ParallelRoom.exe', 'resources/app.asar', 'resources/ffmpeg/ffmpeg.exe', 'resources/ffmpeg/ffprobe.exe', 'portable.txt')) {
    $hit = $names -contains $need
    if (-not $hit) { Die "zip 里缺 $need" }
    Ok "zip 含 $need"
  }
  $zipMB = [math]::Round($zipArtifact.Length / 1MB, 1)
  Ok ("绿色版 zip：{0} MB / {1} 个文件" -f $zipMB, $entryCount)
}

Write-Host ''
$setup = Get-ChildItem dist -Filter 'ParallelRoom-Setup-*.exe' | Sort-Object LastWriteTime | Select-Object -Last 1
if ($setup -and -not $DirOnly) {
  $setupMB = [math]::Round($setup.Length / 1MB, 1)
  Write-Host '安装版：' -NoNewline
  Write-Host $setup.FullName -ForegroundColor Green
  Write-Host ("体积：{0} MB（压缩后；装完约 {1} MB）" -f $setupMB, $unpackedMB)
} elseif (-not $DirOnly -and -not $ZipOnly) {
  Warn '没找到 dist\ParallelRoom-Setup-*.exe'
}
if ($zipArtifact) {
  Write-Host '绿色版：' -NoNewline
  Write-Host $zipArtifact.FullName -ForegroundColor Green
  Write-Host ("体积：{0} MB（解压后 {1} MB）" -f $zipMB, $unpackedMB)
  Write-Host ''
  Write-Host '绿色版怎么给别人：' -ForegroundColor Cyan
  Write-Host '  1) 把 zip 发过去，对方解压到任意目录（不要在压缩包里直接双击）'
  Write-Host '  2) 双击 ParallelRoom.exe 就能用：不用安装、不写注册表、不需要管理员'
  Write-Host '  3) 数据在解压目录的 data\（登录态 + 房间列表 + 录制），整个文件夹能拷到 U 盘接着用'
  Write-Host '  4) 下载来的 zip 先右键 → 属性 → 勾「解除锁定」再解压，能少一次「未知发布者」提示'
  Write-Host '  5) 卸载就是删文件夹（想干净就 data\ 一起删）'
} elseif (-not $DirOnly) {
  Warn '没找到 dist\ParallelRoom-*-portable-win-x64.zip'
}
if ($DirOnly) {
  Write-Host '免安装目录：' -NoNewline
  Write-Host (Resolve-Path "$unpacked").Path -ForegroundColor Green
}
Write-Host ''
