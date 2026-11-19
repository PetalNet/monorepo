<#
.SYNOPSIS
Runs one scripted tour in a 1920x1080 game window and prints its frame-time summary.

.EXAMPLE
./run-tour.ps1 -EngineRoot 'C:\Program Files\Epic Games\UE_5.8' -WorkDir C:\envgen\Host58 -Tour walk

Run it from a logged-in desktop session: the game needs a real window. -Exe runs a packaged build
instead of the editor binary. The summary is Saved/EnvGen/tour_<name>.json in the project (or in the
packaged build's own Saved directory).
#>
param(
	[string] $EngineRoot,
	[string] $WorkDir,
	[string] $Exe,
	[Parameter(Mandatory)] [ValidateSet('walk', 'stand', 'fly', 'overview')] [string] $Tour,
	[int] $Seconds = 60,
	[int] $TimeoutSeconds = 0,
	[string[]] $ExtraArgs = @()
)
$ErrorActionPreference = 'Stop'
if (-not $Exe -and -not ($EngineRoot -and $WorkDir)) { throw 'give either -Exe, or both -EngineRoot and -WorkDir' }

$common = @('-windowed', '-ResX=1920', '-ResY=1080', '-WinX=0', '-WinY=0', "-EnvGenTour=$Tour", "-EnvGenTourSeconds=$Seconds", '-unattended', '-nosplash') + $ExtraArgs
if ($Exe) {
	$binary = $Exe
	$arguments = $common
	$saved = Join-Path (Split-Path -Parent $Exe) 'EnvGenHost\Saved'
} else {
	$binary = Join-Path $EngineRoot 'Engine\Binaries\Win64\UnrealEditor.exe'
	$arguments = @("`"$(Join-Path $WorkDir 'EnvGenHost.uproject')`"", '-game') + $common
	$saved = Join-Path $WorkDir 'Saved'
}
$summary = Join-Path $saved "EnvGen\tour_$Tour.json"
Remove-Item $summary, ([IO.Path]::ChangeExtension($summary, 'csv')) -ErrorAction SilentlyContinue

# Writing frames to disk is many times slower than real time; pass a larger -TimeoutSeconds for that.
if ($TimeoutSeconds -le 0) { $TimeoutSeconds = $Seconds + 600 }
$process = Start-Process $binary -ArgumentList $arguments -PassThru
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
	$process.Kill()
	throw "the tour did not finish within $TimeoutSeconds s"
}
if (-not (Test-Path $summary)) { throw "the game exited ($($process.ExitCode)) without writing $summary" }
Get-Content $summary
