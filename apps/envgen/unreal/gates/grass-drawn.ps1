<#
.SYNOPSIS
Fails unless grass tufts are drawn, not only built, at a fixed point on the walk tour.

.DESCRIPTION
Runs the walk tour twice off-screen at a fixed time step, once as built and once with grass.Enable=0, and
compares the same frame of each. The tour's own tuft count cannot tell the two apart from a level whose tufts
are built and not drawn, which is how 5.8.4 treats a tuft mesh made with the fast build in a level without
Nanite foliage.

.EXAMPLE
./grass-drawn.ps1 -EngineRoot 'C:\Program Files\Epic Games\UE_5.8' -WorkDir C:\envgen\Host58
#>
param(
	[Parameter(Mandatory)] [string] $EngineRoot,
	[Parameter(Mandatory)] [string] $WorkDir,
	[int] $Frame = 600,
	# A pixel differs when any channel is off by more than this, out of 255.
	[int] $ChannelStep = 24,
	# Two runs of the same level differed on at most 0.3 % of pixels by that measure, and drawn tufts changed
	# 3.7 % or more, so the bar sits between them. Hand-set.
	[double] $MinShare = 0.01
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Get-Frame([string] $Name, [string[]] $Extra) {
	$dir = Join-Path $WorkDir "Saved\EnvGen\grass-drawn-$Name"
	Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
	New-Item -ItemType Directory -Force $dir | Out-Null
	$arguments = @('-nosound', '-RenderOffscreen', '-ForceRes', '-UseFixedTimeStep', '-FPS=30', "-EnvGenTourFrames=$dir", "-EnvGenTourFrameEvery=$Frame") + $Extra
	$summary = & (Join-Path $PSScriptRoot '..\run-tour.ps1') -EngineRoot $EngineRoot -WorkDir $WorkDir -Tour walk -Seconds ([int][math]::Ceiling($Frame / 30) + 1) -ExtraArgs $arguments | Out-String | ConvertFrom-Json
	$file = Join-Path $dir ('frame_{0:d5}.png' -f $Frame)
	if (-not (Test-Path $file)) { throw "the tour wrote no $file" }
	[pscustomobject]@{ File = $file; Built = $summary.grass_tufts_within_25m.median }
}

$with = Get-Frame 'on' @()
$without = Get-Frame 'off' @('-ini:Engine:[SystemSettings]:grass.Enable=0')
$a = [System.Drawing.Bitmap]::new($with.File)
$b = [System.Drawing.Bitmap]::new($without.File)
try {
	if ($a.Width -ne $b.Width -or $a.Height -ne $b.Height) { throw 'the two frames differ in size' }
	# Every fourth pixel each way is plenty for a share.
	$differ = 0; $seen = 0
	for ($y = 0; $y -lt $a.Height; $y += 4) {
		for ($x = 0; $x -lt $a.Width; $x += 4) {
			$p = $a.GetPixel($x, $y); $q = $b.GetPixel($x, $y)
			$seen++
			if ([math]::Max([math]::Max([math]::Abs($p.R - $q.R), [math]::Abs($p.G - $q.G)), [math]::Abs($p.B - $q.B)) -gt $ChannelStep) { $differ++ }
		}
	}
} finally { $a.Dispose(); $b.Dispose() }
$share = $differ / $seen
$ok = $share -ge $MinShare
[ordered]@{ grass_drawn_ok = $ok; frame = $Frame; share_of_pixels_grass_changes = [math]::Round($share, 4); min_share = $MinShare; tufts_built_within_25m_median = $with.Built } | ConvertTo-Json
if (-not $ok) { exit 1 }
