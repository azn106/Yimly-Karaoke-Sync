# ==============================================================================
# Yimly Sync Monitor - Windows Launcher
# ==============================================================================
# This launcher dynamically resolves the application directory and executes Start.bat
# preserving all native server initialization, file monitoring, and browser workflows.

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

# 1. Dynamically determine the application root directory
$AppRoot = $PSScriptRoot
if (-not $AppRoot -or -not (Test-Path -LiteralPath $AppRoot)) {
    # If executing inside a compiled PS2EXE wrapper
    try {
        $AppRoot = Split-Path -Parent ([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
    } catch {
        $AppRoot = $null
    }
}
if (-not $AppRoot -or -not (Test-Path -LiteralPath $AppRoot)) {
    $AppRoot = [System.AppDomain]::CurrentDomain.BaseDirectory
}
if (-not $AppRoot -or -not (Test-Path -LiteralPath $AppRoot)) {
    $AppRoot = (Get-Location).Path
}

# Trim trailing slash if present
$AppRoot = $AppRoot.TrimEnd('\').TrimEnd('/')

# Set current working directory to application root
Set-Location -LiteralPath $AppRoot

# 2. Locate Start.bat (or Start-YimlySync.bat fallback)
$StartScript = Join-Path -Path $AppRoot -ChildPath "start.bat"
if (-not (Test-Path -LiteralPath $StartScript)) {
    $StartScript = Join-Path -Path $AppRoot -ChildPath "Start-YimlySync.bat"
}

if (-not (Test-Path -LiteralPath $StartScript)) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "Could not find 'start.bat' in the application directory:`n`n$AppRoot`n`nPlease verify that the application files are intact.",
        "Yimly Sync Monitor - Launcher Error",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
    exit 1
}

# 3. Launch Start.bat in its own command prompt window with the project directory as working directory
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = if ($env:ComSpec) { $env:ComSpec } else { "cmd.exe" }
$psi.Arguments = "/c `"`"$StartScript`"`""
$psi.WorkingDirectory = $AppRoot
$psi.UseShellExecute = $true

try {
    $proc = [System.Diagnostics.Process]::Start($psi)
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "Failed to launch start.bat:`n`n$($_.Exception.Message)",
        "Yimly Sync Monitor - Launcher Error",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
    exit 1
}
