<#
.SYNOPSIS
Cooks and packages the host project for Win64 from a work directory prepared by build-level.ps1.

.EXAMPLE
./package.ps1 -EngineRoot 'C:\Program Files\Epic Games\UE_5.8' -WorkDir C:\envgen\Host58 -OutDir C:\envgen\Packaged58

The packaged game is OutDir\Windows\EnvGenHost.exe. Development keeps logging and the CSV profiler.
#>
param(
	[Parameter(Mandatory)] [string] $EngineRoot,
	[Parameter(Mandatory)] [string] $WorkDir,
	[Parameter(Mandatory)] [string] $OutDir,
	[ValidateSet('Development', 'Shipping')] [string] $Configuration = 'Development'
)
$ErrorActionPreference = 'Stop'
$project = Join-Path $WorkDir 'EnvGenHost.uproject'
if (-not (Test-Path (Join-Path $WorkDir 'Content\EnvGen\Maps\Site.umap'))) {
	throw "no level in $WorkDir yet: run build-level.ps1 with -Manifest first"
}
& (Join-Path $EngineRoot 'Engine\Build\BatchFiles\RunUAT.bat') BuildCookRun "-project=$project" -platform=Win64 "-clientconfig=$Configuration" `
	-build -cook -stage -pak -archive "-archivedirectory=$OutDir" -map=/Game/EnvGen/Maps/Site -nop4 -utf8output -unattended -nosplash
if ($LASTEXITCODE -ne 0) { throw "packaging failed ($LASTEXITCODE)" }
Get-Item (Join-Path $OutDir 'Windows\EnvGenHost.exe') | Select-Object FullName, Length
