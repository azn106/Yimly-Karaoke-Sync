[CmdletBinding()]
param(
    [string]$AppRoot = ""
)

$ErrorActionPreference = "Continue"

if (-not $AppRoot) {
    $AppRoot = $PSScriptRoot
    if (-not $AppRoot) {
        $AppRoot = (Get-Item .).FullName
    }
}
$AppRoot = $AppRoot.TrimEnd('\').TrimEnd('/')

$LauncherPs1 = Join-Path $AppRoot "YimlyLauncher.ps1"
$IconIco = Join-Path $AppRoot "Yimly.ico"
$OutputExe = Join-Path $AppRoot "Yimly Sync Monitor.exe"

Write-Host "  -> Source script: $LauncherPs1"
Write-Host "  -> Icon file:     $IconIco"
Write-Host "  -> Output target: $OutputExe"
Write-Host ""

$compiled = $false

# 1. Primary Method: PS2EXE
try {
    Write-Host "Checking for PS2EXE module..."
    if (-not (Get-Command -Name ps2exe -ErrorAction SilentlyContinue) -and -not (Get-Module -ListAvailable -Name ps2exe)) {
        Write-Host "Installing PS2EXE for current user (Scope: CurrentUser)..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Install-Module -Name ps2exe -Scope CurrentUser -Force -SkipPublisherCheck -AllowClobber -ErrorAction Stop
    }
    
    Import-Module ps2exe -ErrorAction Stop
    Write-Host "Compiling with PS2EXE..."
    
    $ps2exeParams = @{
        InputFile    = $LauncherPs1
        OutputFile   = $OutputExe
        Title        = "Yimly Sync Monitor"
        Description  = "Yimly Sync Monitor Launcher"
        Company      = "Yimly"
        Product      = "Yimly Sync Monitor"
        Copyright    = "Yimly"
        noConsole    = $true
        RequireAdmin = $false
    }
    if (Test-Path $IconIco) {
        $ps2exeParams["IconFile"] = $IconIco
    }
    
    Invoke-PS2EXE @ps2exeParams
    
    if (Test-Path $OutputExe) {
        Write-Host "PS2EXE compilation succeeded."
        $compiled = $true
    }
} catch {
    Write-Warning "PS2EXE method failed or was unavailable: $($_.Exception.Message)"
}

# 2. Fallback Method: Built-in Windows .NET C# Compiler (csc.exe / Add-Type)
if (-not $compiled) {
    Write-Host "Attempting native .NET compiler fallback..."
    try {
        $cscPaths = @(
            "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
            "$env:SystemRoot\Microsoft.NET\Framework\v4.0.30319\csc.exe"
        )
        $csc = $cscPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
        
        $csharpSource = @"
using System;
using System.IO;
using System.Diagnostics;
using System.Windows.Forms;

namespace YimlyLauncher {
    static class Program {
        [STAThread]
        static void Main() {
            try {
                string exePath = System.Reflection.Assembly.GetExecutingAssembly().Location;
                string appRoot = Path.GetDirectoryName(exePath);
                if (string.IsNullOrEmpty(appRoot)) {
                    appRoot = AppDomain.CurrentDomain.BaseDirectory;
                }
                string startBat = Path.Combine(appRoot, "start.bat");
                if (!File.Exists(startBat)) {
                    startBat = Path.Combine(appRoot, "Start-YimlySync.bat");
                }
                if (!File.Exists(startBat)) {
                    MessageBox.Show(
                        "Could not find start.bat in:\n" + appRoot + "\n\nPlease ensure start.bat is in the application folder.",
                        "Yimly Sync Monitor Error",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                    return;
                }
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
                psi.Arguments = "/c \"" + startBat + "\"";
                psi.WorkingDirectory = appRoot;
                psi.UseShellExecute = true;
                Process.Start(psi);
            } catch (Exception ex) {
                MessageBox.Show(
                    "Error launching start.bat:\n" + ex.Message,
                    "Yimly Sync Monitor Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }
    }
}
"@
        $tempCs = Join-Path $AppRoot "YimlyLauncher_temp.cs"
        Set-Content -Path $tempCs -Value $csharpSource -Encoding UTF8
        
        $cscArgs = @(
            "/target:winexe",
            "/out:`"$OutputExe`"",
            "/reference:System.Windows.Forms.dll",
            "/reference:System.dll"
        )
        if (Test-Path $IconIco) {
            $cscArgs += "/win32icon:`"$IconIco`""
        }
        $cscArgs += "`"$tempCs`""
        
        if ($csc) {
            Write-Host "Invoking csc.exe ($csc)..."
            & $csc $cscArgs
        } else {
            Write-Host "Invoking Add-Type compiler..."
            $cp = New-Object System.CodeDom.Compiler.CompilerParameters
            $cp.GenerateExecutable = $true
            $cp.OutputAssembly = $OutputExe
            $cp.ReferencedAssemblies.Add("System.dll") | Out-Null
            $cp.ReferencedAssemblies.Add("System.Windows.Forms.dll") | Out-Null
            $cp.CompilerOptions = "/target:winexe" + $(if (Test-Path $IconIco) { " /win32icon:`"$IconIco`"" } else { "" })
            
            $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
            $cr = $provider.CompileAssemblyFromFile($cp, $tempCs)
            if ($cr.Errors.Count -gt 0) {
                foreach ($err in $cr.Errors) {
                    Write-Error $err.ToString()
                }
            }
        }
        
        Remove-Item -Path $tempCs -Force -ErrorAction SilentlyContinue
        
        if (Test-Path $OutputExe) {
            Write-Host "Native .NET compilation succeeded."
            $compiled = $true
        }
    } catch {
        Write-Error "Native fallback failed: $($_.Exception.Message)"
    }
}

if (-not (Test-Path $OutputExe)) {
    Write-Error "Failed to produce $OutputExe"
    exit 1
}

Write-Host "Build complete: $OutputExe"
exit 0
