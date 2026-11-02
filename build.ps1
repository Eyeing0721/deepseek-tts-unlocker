# 打包脚本：一份源码 → Chrome/Edge 包 + Firefox 包
#
#   pwsh -File build.ps1
#
# 产物：
#   dist/deepseek-tts-unlocker-chrome.zip     （Chrome/Edge：解压后「加载已解压的扩展程序」）
#   dist/deepseek-tts-unlocker-firefox.xpi    （Firefox：about:debugging 临时加载，或安装到开发者版）
#   dist/chrome/  dist/firefox/               （未压缩的目录，也可直接加载）

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$shared = @('inject.js', 'bridge.js', 'i18n.js', 'lamejs.min.js', 'popup.html', 'popup.js', 'LICENSE', 'LICENSE-lamejs.txt')

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }

foreach ($target in @('chrome', 'firefox')) {
    $out = Join-Path $dist $target
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    foreach ($f in $shared) { Copy-Item (Join-Path $root $f) (Join-Path $out $f) }
    Copy-Item (Join-Path $root '_locales') (Join-Path $out '_locales') -Recurse
    $mf = if ($target -eq 'chrome') { 'manifest.json' } else { 'manifest.firefox.json' }
    Copy-Item (Join-Path $root $mf) (Join-Path $out 'manifest.json')
    Write-Host ("[{0}] {1} 个文件" -f $target, (Get-ChildItem $out -File).Count)
}

$chromeZip = Join-Path $dist 'deepseek-tts-unlocker-chrome.zip'
$firefoxXpi = Join-Path $dist 'deepseek-tts-unlocker-firefox.xpi'
$firefoxZip = Join-Path $dist 'deepseek-tts-unlocker-firefox.zip'
Compress-Archive -Path (Join-Path $dist 'chrome\*') -DestinationPath $chromeZip -Force
# Compress-Archive 只认 .zip 扩展名，先压成 zip 再改名成 .xpi
Compress-Archive -Path (Join-Path $dist 'firefox\*') -DestinationPath $firefoxZip -Force
Move-Item -Path $firefoxZip -Destination $firefoxXpi -Force

Write-Host ''
Get-ChildItem $dist -File | Select-Object Name, @{ n = 'KB'; e = { [math]::Round($_.Length / 1KB, 1) } } |
    Format-Table -AutoSize | Out-String | Write-Host
