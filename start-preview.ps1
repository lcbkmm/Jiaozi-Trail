param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$previewRoot = $PSScriptRoot
$previewUrl = "http://127.0.0.1:$Port/baidu-map.html"

function Test-Preview {
    try {
        $response = Invoke-WebRequest -Uri $previewUrl -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200 -and $response.Content.Contains('scene-canvas')
    } catch { return $false }
}

if (Test-Preview) {
    Write-Host "Preview is already running: $previewUrl"
    return
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is used by another service. Run this script with -Port 8766."
}

$previewPython = (Get-Command python -ErrorAction Stop).Source
$previewOutput = Join-Path $previewRoot 'map-renderer/output'
New-Item -ItemType Directory -Path $previewOutput -Force | Out-Null
$previewLogName = if ($Port -eq 8765) { 'preview' } else { "preview-$Port" }
$previewErrorLog = Join-Path $previewOutput "$previewLogName.stderr.log"
$previewProcess = Start-Process -FilePath $previewPython `
    -ArgumentList @('map-renderer/scripts/serve.py', '--port', $Port) `
    -WorkingDirectory $previewRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $previewOutput "$previewLogName.stdout.log") `
    -RedirectStandardError $previewErrorLog

for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (Test-Preview) {
        Write-Host "Preview is ready: $previewUrl"
        Write-Host "Background process: $($previewProcess.Id). Run this script again after a restart."
        return
    }
    $previewProcess.Refresh()
    if ($previewProcess.HasExited) { break }
    Start-Sleep -Milliseconds 250
}
throw "Preview failed to start. Check $previewErrorLog."
