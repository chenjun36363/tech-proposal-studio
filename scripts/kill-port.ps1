<#
.SYNOPSIS
    终止占用指定 TCP 端口的进程（默认 1420，即 Vite 开发服务器端口）。

.DESCRIPTION
    使用 netstat 找出指定端口上处于 LISTENING 状态的进程 PID，
    列出后强制终止，并复核端口是否释放。
    与 scripts/run-tauri-dev.bat 的端口探测方式保持一致（netstat -ano -p tcp）。

.PARAMETER Port
    要释放的 TCP 端口号，默认 1420。

.EXAMPLE
    .\scripts\kill-port.ps1
    .\scripts\kill-port.ps1 -Port 1420
    .\scripts\kill-port.ps1 -Port 3000
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 1420
)

$ErrorActionPreference = "Stop"

function Get-ListeningPids {
    param([int]$Port)
    $lines = netstat -ano -p tcp | Where-Object { $_ -match ":$Port\s.*LISTENING" }
    $pids = @()
    foreach ($line in $lines) {
        $tokens = ($line -split '\s+') | Where-Object { $_ }
        if ($tokens.Count -ge 5 -and [int]::TryParse($tokens[-1], [ref]$null)) {
            $pids += [int]$tokens[-1]
        }
    }
    $pids | Sort-Object -Unique
}

$pids = Get-ListeningPids -Port $Port
if (-not $pids) {
    Write-Host "Port $Port is not in use. Nothing to kill."
    exit 0
}

Write-Host "Port $Port is in use by PID(s): $($pids -join ', ')"
foreach ($procId in $pids) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "  PID $procId is no longer running, skipping."
        continue
    }
    Write-Host ("  Killing PID {0} ({1}) ..." -f $procId, $proc.ProcessName)
    Stop-Process -Id $procId -Force
    Write-Host "  Killed PID $procId."
}

# Give the OS a moment to release the listening socket, then verify.
Start-Sleep -Milliseconds 500
$remaining = Get-ListeningPids -Port $Port
if ($remaining) {
    Write-Host "Warning: port $Port is still listening after kill (PID(s): $($remaining -join ', '))."
    exit 1
}
Write-Host "Port $Port is now free."
