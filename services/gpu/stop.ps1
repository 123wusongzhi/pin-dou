$ErrorActionPreference = "Stop"
$gpuPidFile = Join-Path $PSScriptRoot ".runtime\service.pid"
if (-not (Test-Path -LiteralPath $gpuPidFile)) {
    Write-Output "No GPU service PID file was found."
    exit 0
}
$gpuServicePid = [int](Get-Content -LiteralPath $gpuPidFile -Raw)
$gpuProcess = Get-Process -Id $gpuServicePid -ErrorAction SilentlyContinue
if ($gpuProcess) {
    $gpuExpectedPython = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".venv\Scripts\python.exe"))
    $gpuProcessDetails = Get-CimInstance Win32_Process -Filter "ProcessId = $gpuServicePid"
    if (
        $gpuProcess.Path -ne $gpuExpectedPython -or
        -not $gpuProcessDetails.CommandLine.Contains("-m uvicorn server:app")
    ) {
        throw "PID $gpuServicePid belongs to a different executable; it was not stopped."
    }
    # Windows virtualenv launchers spawn the base interpreter as a child.
    # Validate that child's command before stopping it, then stop the launcher.
    $gpuChildren = Get-CimInstance Win32_Process -Filter "ParentProcessId = $gpuServicePid"
    foreach ($gpuChild in $gpuChildren) {
        if (
            $gpuChild.Name -eq "python.exe" -and
            $gpuChild.CommandLine.Contains($gpuExpectedPython) -and
            $gpuChild.CommandLine.Contains("-m uvicorn server:app")
        ) {
            Stop-Process -Id $gpuChild.ProcessId
        }
    }
    Stop-Process -Id $gpuServicePid -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $gpuPidFile
Write-Output "GPU service stopped."
