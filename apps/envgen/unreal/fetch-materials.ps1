<#
.SYNOPSIS
Downloads the scanned ground materials named in materials.json, once, and checks every file against its hash.

.EXAMPLE
./fetch-materials.ps1 -Directory C:\envgen\materials

Files already present with the right hash are not downloaded again. A file with the wrong hash is an error and is kept
for inspection under a .bad suffix.
#>
param(
	[Parameter(Mandatory)] [string] $Directory
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$materials = Get-Content (Join-Path $here 'materials.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force $Directory | Out-Null
$downloaded = 0
foreach ($class in $materials.classes.PSObject.Properties) {
	foreach ($map in $class.Value.maps.PSObject.Properties) {
		$path = Join-Path $Directory "$($class.Name)_$($map.Name).jpg"
		$hash = { (Get-FileHash $path -Algorithm MD5).Hash.ToLower() }
		if ((Test-Path $path) -and ((& $hash) -eq $map.Value.md5)) { continue }
		Invoke-WebRequest -Uri $map.Value.url -OutFile $path -UseBasicParsing
		$downloaded += (Get-Item $path).Length
		if ((& $hash) -ne $map.Value.md5) {
			Move-Item $path "$path.bad" -Force
			throw "$($map.Value.url) does not match its recorded hash"
		}
	}
}
"downloaded $([math]::Round($downloaded / 1MB, 2)) MB into $Directory"
