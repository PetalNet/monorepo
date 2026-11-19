<#
.SYNOPSIS
Builds the host project against one engine install and regenerates the level from a build manifest.

.EXAMPLE
./build-level.ps1 -EngineRoot 'C:\Program Files\Epic Games\UE_5.8' -WorkDir C:\envgen\Host58 -Manifest C:\envgen\build\site\build.json

The project is copied into WorkDir so that each engine version compiles into its own directory and
the source tree stays clean. -ExtraPlugin adds a plugin directory from outside this repository, and
-DroneClass names the pawn from it that the walker can swap to.
#>
param(
	[Parameter(Mandatory)] [string] $EngineRoot,
	[Parameter(Mandatory)] [string] $WorkDir,
	[string] $Manifest,
	[string[]] $ExtraPlugin = @(),
	[string] $DroneClass,
	[switch] $SkipCompile,
	[int] $TimeoutSeconds = 3600
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Copy-Tree([string] $From, [string] $To) {
	robocopy $From $To /E /NFL /NDL /NJH /NJS /NP | Out-Null
	# robocopy reports success as 0 to 7; 8 and above mean something was not copied.
	if ($LASTEXITCODE -ge 8) { throw "copying $From to $To failed (robocopy $LASTEXITCODE)" }
}

$version = Get-Content (Join-Path $EngineRoot 'Engine\Build\Build.version') -Raw | ConvertFrom-Json
$association = "$($version.MajorVersion).$($version.MinorVersion)"
Write-Host "engine $association.$($version.PatchVersion) at $EngineRoot"

New-Item -ItemType Directory -Force $WorkDir | Out-Null
Copy-Tree (Join-Path $here 'Host') $WorkDir
Copy-Tree (Join-Path $here 'Plugins') (Join-Path $WorkDir 'Plugins')
foreach ($plugin in $ExtraPlugin) {
	Copy-Tree $plugin (Join-Path $WorkDir "Plugins\$(Split-Path -Leaf $plugin)")
}

$project = Join-Path $WorkDir 'EnvGenHost.uproject'
$descriptor = Get-Content $project -Raw | ConvertFrom-Json
$descriptor.EngineAssociation = $association
$descriptor | ConvertTo-Json -Depth 8 | Set-Content $project -Encoding ascii

if ($DroneClass) {
	Add-Content (Join-Path $WorkDir 'Config\DefaultGame.ini') "`n[/Script/EnvGen.EnvGenWalker]`nDroneClass=$DroneClass"
}

if (-not $SkipCompile) {
	& (Join-Path $EngineRoot 'Engine\Build\BatchFiles\Build.bat') EnvGenHostEditor Win64 Development "-project=$project" -waitmutex
	if ($LASTEXITCODE -ne 0) { throw "compile failed ($LASTEXITCODE)" }
}

if ($Manifest) {
	# The editor changes its working directory, so it needs an absolute path.
	$manifestPath = (Resolve-Path $Manifest).Path
	$receipt = Join-Path $WorkDir 'Saved\EnvGen\build_receipt.json'
	Remove-Item $receipt -ErrorAction SilentlyContinue

	# The full editor, not a commandlet: the engine merges Landscape edit layers on the GPU over several frames.
	$editor = Join-Path $EngineRoot 'Engine\Binaries\Win64\UnrealEditor-Cmd.exe'
	$arguments = @("`"$project`"", "-EnvGenManifest=`"$manifestPath`"", '-RenderOffscreen', '-unattended', '-nosplash', '-nopause', '-stdout')
	$process = Start-Process $editor -ArgumentList $arguments -PassThru -NoNewWindow
	# Windows PowerShell only reports ExitCode for a process whose handle was read before it exited.
	$null = $process.Handle
	if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
		$process.Kill()
		throw "the level build did not finish within $TimeoutSeconds s"
	}
	if (Test-Path $receipt) { Get-Content $receipt }
	if ($null -eq $process.ExitCode -or $process.ExitCode -ne 0) { throw "the level build failed (exit code '$($process.ExitCode)')" }
	if (-not (Test-Path $receipt)) { throw 'the editor exited without building the level: no receipt was written' }
}
