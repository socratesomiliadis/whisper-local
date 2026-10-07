param([switch]$CpuOnly)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Close the existing app launch window before updating dependencies, then run setup again.'
}
$taskPython = Join-Path $PSScriptRoot '.runtime/python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
        throw 'Install the Python install manager from python.org, then run Setup.ps1 again.'
    }
    & py install --target (Join-Path $PSScriptRoot '.runtime') 3.11
    if ($LASTEXITCODE -ne 0) { throw 'Python setup failed. Use the Python install manager from python.org.' }
}
$taskUseGpu = $false
if (-not $CpuOnly -and (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    $taskGpuNames = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null
    $taskUseGpu = $LASTEXITCODE -eq 0 -and [bool]$taskGpuNames
}
if ($taskUseGpu) {
    Write-Host 'Installing GPU acceleration for NVIDIA graphics. This download can be several GB.'
    & $taskPython -m pip install -r (Join-Path $PSScriptRoot 'requirements-engine-gpu.txt') --index-url https://download.pytorch.org/whl/cu128 --disable-pip-version-check
    if ($LASTEXITCODE -ne 0) { $taskUseGpu = $false; Write-Host 'GPU installation failed. Installing the CPU fallback.' }
}
if (-not $taskUseGpu) {
    & $taskPython -m pip install -r (Join-Path $PSScriptRoot 'requirements-engine.txt') --index-url https://download.pytorch.org/whl/cpu --disable-pip-version-check
    if ($LASTEXITCODE -ne 0) { throw 'The CPU engine could not be installed.' }
}
& $taskPython -m pip install -e $PSScriptRoot --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'App dependencies could not be installed.' }
Write-Host 'Setup complete. Double-click Start.cmd to open Whisper Local.'
