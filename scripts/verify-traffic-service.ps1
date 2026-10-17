param()
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
chcp 65001 > $null

# This entrypoint never opens WinDivert, installs a service, or changes networking.
$packageRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.platform -ne 'windows' -or $manifest.arch -ne 'x86_64') {
    throw '不支持的验证包格式'
}
foreach ($entry in $manifest.files.PSObject.Properties) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $packageRoot $entry.Name))
    if (-not $candidate.StartsWith($packageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw '验证包包含越界路径'
    }
    $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $entry.Value) { throw ('文件校验失败：' + $entry.Name) }
}
& (Join-Path $packageRoot 'unit-tests.exe') --test-threads=1
if ($LASTEXITCODE -ne 0) { throw '本地自动测试失败' }
& (Join-Path $packageRoot 'codey-traffic-service.exe') --version
if ($LASTEXITCODE -ne 0) { throw '服务可执行文件检查失败' }
if ($manifest.desktopExecutableIncluded) {
    $env:NO_PROXY = '127.0.0.1,localhost,::1'
    foreach ($testFilter in @('network_proxy', 'launcher::windows_packaged', 'launch_proxy', 'appserver_call')) {
        & (Join-Path $packageRoot 'desktop-unit-tests.exe') $testFilter --test-threads=1
        if ($LASTEXITCODE -ne 0) { throw ('桌面启动接线测试失败：' + $testFilter) }
    }
}
$signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $packageRoot 'WinDivert64.sys')
$report = [ordered]@{
    automaticTests = 'passed'
    driverAuthenticode = $signature.Status.ToString()
    driverLoadTest = 'not-run'
    nativeCaptureTest = 'not-run'
    desktopExecutableIncluded = [bool]$manifest.desktopExecutableIncluded
    releaseReady = $false
}
$report | ConvertTo-Json
Write-Host '本地自动测试通过；未加载驱动或接管任何进程。实际接管请按 README 在独立测试环境验证。'
