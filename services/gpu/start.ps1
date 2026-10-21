param(
    [string]$Bind = "0.0.0.0",
    [int]$Port = 8766,
    [string]$TokenFile = "",
    [switch]$Foreground
)

$ErrorActionPreference = "Stop"
$gpuPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$gpuRuntime = Join-Path $PSScriptRoot ".runtime"
if (-not (Test-Path -LiteralPath $gpuPython)) {
    throw "Create services/gpu/.venv and install requirements.txt first. See README.md."
}
New-Item -ItemType Directory -Path $gpuRuntime -Force | Out-Null
if (-not $TokenFile) { $TokenFile = Join-Path $gpuRuntime "token.txt" }
$TokenFile = [IO.Path]::GetFullPath($TokenFile)
if (-not (Test-Path -LiteralPath $TokenFile)) {
    & $gpuPython -c "import pathlib,secrets,sys; pathlib.Path(sys.argv[1]).write_text(secrets.token_hex(32),encoding='utf-8')" $TokenFile
    if ($LASTEXITCODE -ne 0) { throw "Could not create GPU service token." }
}
$gpuArguments = @(
    "-m", "uvicorn", "server:app", "--app-dir", $PSScriptRoot,
    "--host", $Bind, "--port", "$Port", "--workers", "1", "--no-access-log"
)
$gpuPreviousTokenFile = $env:GPU_SERVICE_TOKEN_FILE
$env:GPU_SERVICE_TOKEN_FILE = $TokenFile
try {
    if ($Foreground) {
        & $gpuPython @gpuArguments
        exit $LASTEXITCODE
    }
    $gpuPidFile = Join-Path $gpuRuntime "service.pid"
    if (Test-Path -LiteralPath $gpuPidFile) {
        $gpuPreviousPid = [int](Get-Content -LiteralPath $gpuPidFile -Raw)
        if (Get-Process -Id $gpuPreviousPid -ErrorAction SilentlyContinue) {
            throw "The recorded GPU service process is still running (PID $gpuPreviousPid)."
        }
    }
    $gpuProcess = Start-Process -FilePath $gpuPython -ArgumentList $gpuArguments `
        -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $gpuRuntime "stdout.log") `
        -RedirectStandardError (Join-Path $gpuRuntime "stderr.log")
    Set-Content -LiteralPath $gpuPidFile -Value $gpuProcess.Id -Encoding ascii
    Write-Output "GPU service starting: PID $($gpuProcess.Id), http://${Bind}:${Port}"
    Write-Output "Token file: $TokenFile"
    Write-Output "Logs: $gpuRuntime"
}
finally {
    $env:GPU_SERVICE_TOKEN_FILE = $gpuPreviousTokenFile
}
