param(
    [string]$ExecutablePath = "",
    [int]$StartupSeconds = 5
)

$ErrorActionPreference = "Stop"

if (-not $ExecutablePath) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $ExecutablePath = Join-Path $repoRoot "src-tauri\target\release\ask-hermes.exe"
}

$ExecutablePath = (Resolve-Path -LiteralPath $ExecutablePath).Path
$existing = Get-Process -Name "ask-hermes" -ErrorAction SilentlyContinue
if ($existing) {
    $details = ($existing | ForEach-Object { "$($_.Id): $($_.Path)" }) -join ", "
    throw "Close running Ask Hermes before startup smoke: $details"
}

$smokeDir = Join-Path ([IO.Path]::GetTempPath()) "ask-hermes-startup-smoke-$PID-$([guid]::NewGuid().ToString('N'))"
$stdoutPath = Join-Path $smokeDir "stdout.log"
$stderrPath = Join-Path $smokeDir "stderr.log"
$readyPath = Join-Path $smokeDir "renderer-ready.json"
New-Item -ItemType Directory -Path $smokeDir | Out-Null

$readyFileVariable = "ASK_HERMES_SMOKE_READY_FILE"
$previousReadyPath = [Environment]::GetEnvironmentVariable($readyFileVariable, "Process")

$process = $null
try {
    [Environment]::SetEnvironmentVariable($readyFileVariable, $readyPath, "Process")
    try {
        $process = Start-Process `
            -FilePath $ExecutablePath `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath `
            -PassThru
    }
    finally {
        [Environment]::SetEnvironmentVariable($readyFileVariable, $previousReadyPath, "Process")
    }

    $rendererReport = $null
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 100
        $process.Refresh()
        if ($process.HasExited) {
            $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
            $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
            throw "Ask Hermes exited during startup smoke (code $($process.ExitCode)).`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
        }

        if ($null -eq $rendererReport -and (Test-Path -LiteralPath $readyPath)) {
            try {
                $rendererReport = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
            }
            catch {
                # Rust may still be completing the report write.
            }
        }
    }

    if ($null -eq $rendererReport) {
        throw "Ask Hermes stayed alive, but Workspace frontend never reported a mounted renderer."
    }
    if ($rendererReport.nativeDev -ne $false) {
        throw "Ask Hermes executable was built in Tauri development mode."
    }
    $tauriUrlPattern = "^(tauri://localhost|https?://tauri\.localhost)(?:/|$)"
    if ($rendererReport.nativeUrl -notmatch $tauriUrlPattern -or $rendererReport.documentUrl -notmatch $tauriUrlPattern) {
        throw "Workspace did not load bundled Tauri frontend. Native URL: $($rendererReport.nativeUrl); document URL: $($rendererReport.documentUrl)"
    }
    if ($rendererReport.label -ne "workspace") {
        throw "Renderer smoke came from unexpected window: $($rendererReport.label)"
    }
    if ($rendererReport.shellDisplay -ne "grid" -or $rendererReport.shellWidth -le 0 -or $rendererReport.shellHeight -le 0) {
        throw "Workspace shell did not render with expected layout: display=$($rendererReport.shellDisplay), size=$($rendererReport.shellWidth)x$($rendererReport.shellHeight)"
    }
    if ($rendererReport.wordmark -ne "Hermes") {
        throw "Workspace wordmark did not render: $($rendererReport.wordmark)"
    }

    Write-Output "Startup smoke passed: native process plus bundled Workspace HTML, JavaScript, and CSS remained healthy for $StartupSeconds seconds."
}
finally {
    if ($process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id
            $process.WaitForExit(5000) | Out-Null
        }
    }
    Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $smokeDir -Force -ErrorAction SilentlyContinue
}
