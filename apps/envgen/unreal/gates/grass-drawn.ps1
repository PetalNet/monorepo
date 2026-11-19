<#
.SYNOPSIS
Fails unless grass tufts are drawn, not only built, where a walker stands on grass.

.DESCRIPTION
Runs the walk tour twice off-screen at a fixed time step, once as built and once with grass.Enable=0, and compares the
same frame of each over the ground the walker sees nearby: the lower part of the frame, below the horizon and within
the tufts' draw distance. The tour's own tuft count cannot tell the two apart from a level whose tufts are built and
not drawn, which is how 5.8.4 treats a tuft mesh made with the fast build in a level without Nanite foliage.

The gate measures nothing useful where the walker is not on grass, so it refuses such a frame: it reads the grass
weight of the build at the camera and at 4 m and 8 m along the path, and every one must be the full weight. The frame
therefore has to be chosen on grass (the default is). With -Noise it also runs the grass-on tour a second time and
reports how much two identical runs differ over the same ground, the floor the bar has to clear.

The nearest variety is only drawn close by, and the lower part of the frame is all its own. So the same two frames are
compared over a second band as well: the ground between where the nearest variety ends and where the farthest ends,
which only the far varieties (the clump and the tall tuft) can change. The band's rows come from the manifest's draw
distances, the tour's eye height and the frame's own shape, for level ground and a level camera.

.EXAMPLE
./grass-drawn.ps1 -EngineRoot 'C:\Program Files\Epic Games\UE_5.8' -WorkDir C:\envgen\Host58 -BuildDir C:\envgen\build\site
#>
param(
	[Parameter(Mandatory)] [string] $EngineRoot,
	[Parameter(Mandatory)] [string] $WorkDir,
	# The folder of the build the level was made from: its manifest and surface weights say where the grass is.
	[Parameter(Mandatory)] [string] $BuildDir,
	# A walk frame on full grass weight with the camera heading along grass: found by reading the walk path over the
	# build's grass weight. Frame 600, the walk's station, stands on a class edge and shows paving and sky as well.
	[int] $Frame = 840,
	# A pixel differs when any channel is off by more than this, out of 255. Two runs of the same level at a fixed time
	# step were identical (0 pixels differ, -Noise reports it), so any step above rounding sees a real change; blades that
	# are lit and coloured as the ground under them move a pixel by 10 to 20, which the earlier step of 24 missed.
	[int] $ChannelStep = 8,
	# The top of the ground that counts, as a share of the frame's height from the top: below the horizon of a level
	# walker, so the sky, which grass cannot change, is not in the denominator.
	[double] $GroundTop = 0.6,
	# Of the ground pixels below $GroundTop, the share that grass must change. Held at 1 %, the earlier bar. Drawn
	# tufts changed 3.7 % of a whole frame (step 24) when they were black; the lit tufts changed 0.7 % of the grass-only
	# ground at step 24, which is why the step is lower and the bar is not.
	[double] $MinShare = 0.01,
	# Of the far band's pixels, the share the far varieties must change. Their blades are a pixel or two wide there, so
	# they move fewer pixels past the step than the near ones; two identical runs differed on none of the band.
	[double] $MinFarShare = 0.01,
	[switch] $Noise
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Get-Frame([string] $Name, [string[]] $Extra) {
	$dir = Join-Path $WorkDir "Saved\EnvGen\grass-drawn-$Name"
	Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
	New-Item -ItemType Directory -Force $dir | Out-Null
	$arguments = @('-nosound', '-RenderOffscreen', '-ForceRes', '-UseFixedTimeStep', '-FPS=30', "-EnvGenTourFrames=$dir", "-EnvGenTourFrameEvery=$Frame") + $Extra
	$summary = & (Join-Path $PSScriptRoot '..\run-tour.ps1') -EngineRoot $EngineRoot -WorkDir $WorkDir -Tour walk -Seconds ([int][math]::Ceiling($Frame / 30) + 3) -ExtraArgs $arguments | Out-String | ConvertFrom-Json
	$file = Join-Path $dir ('frame_{0:d5}.png' -f $Frame)
	if (-not (Test-Path $file)) { throw "the tour wrote no $file" }
	Copy-Item (Join-Path $WorkDir 'Saved\EnvGen\tour_walk.csv') (Join-Path $dir 'tour.csv')
	[pscustomobject]@{ File = $file; Csv = (Join-Path $dir 'tour.csv'); Built = $summary.grass_tufts_within_25m.median; EyeM = $summary.height_above_ground_m }
}

# The share of the pixels between two heights of the frame (shares of its height from the top), every fourth each way,
# on which two frames differ by more than $ChannelStep.
function Get-Share([string] $First, [string] $Second, [double] $Top, [double] $Bottom) {
	$a = [System.Drawing.Bitmap]::new($First)
	$b = [System.Drawing.Bitmap]::new($Second)
	try {
		if ($a.Width -ne $b.Width -or $a.Height -ne $b.Height) { throw 'the two frames differ in size' }
		$differ = 0; $seen = 0; $sum = 0
		for ($y = [int]($a.Height * $Top); $y -lt [int]($a.Height * $Bottom); $y += 4) {
			for ($x = 0; $x -lt $a.Width; $x += 4) {
				$p = $a.GetPixel($x, $y); $q = $b.GetPixel($x, $y)
				$seen++
				$sum += ([math]::Abs($p.R - $q.R) + [math]::Abs($p.G - $q.G) + [math]::Abs($p.B - $q.B)) / 3
				if ([math]::Max([math]::Max([math]::Abs($p.R - $q.R), [math]::Abs($p.G - $q.G)), [math]::Abs($p.B - $q.B)) -gt $ChannelStep) { $differ++ }
			}
		}
		[pscustomobject]@{ Share = $differ / $seen; Mean = $sum / $seen }
	} finally { $a.Dispose(); $b.Dispose() }
}

# The grass weight of the build, out of 255, at a place given in centimetres from the tile centre. The weight image is
# indexed [east, north] (rows east, columns north), a pixel to a quad, from the tile's south-west corner.
function Get-GrassWeight($Manifest, [System.Drawing.Bitmap] $Weights, [double] $NorthCm, [double] $EastCm) {
	$north = [int][math]::Round(($NorthCm - $Manifest.landscape.location_cm[0]) / $Manifest.landscape.scale[0])
	$east = [int][math]::Round(($EastCm - $Manifest.landscape.location_cm[1]) / $Manifest.landscape.scale[1])
	if ($east -lt 0 -or $north -lt 0 -or $north -ge $Weights.Width -or $east -ge $Weights.Height) { return 0 }
	$Weights.GetPixel($north, $east).R
}

$with = Get-Frame 'on' @()
$manifest = Get-Content (Join-Path $BuildDir 'build.json') -Raw | ConvertFrom-Json
$grassFile = ($manifest.surface.layers | Where-Object { $_.name -eq 'grass' }).file
if (-not $grassFile) { throw 'the build has no grass class' }
$weights = [System.Drawing.Bitmap]::new((Join-Path $BuildDir $grassFile))
try {
	$rows = Import-Csv $with.Csv
	# One second is 4 m of walking: the camera, then 4 m and 8 m ahead.
	$lowest = 255
	foreach ($row in $Frame, ($Frame + 30), ($Frame + 60)) {
		$lowest = [math]::Min($lowest, (Get-GrassWeight $manifest $weights ([double]$rows[$row].x_cm) ([double]$rows[$row].y_cm)))
	}
} finally { $weights.Dispose() }
$without = Get-Frame 'off' @('-ini:Engine:[SystemSettings]:grass.Enable=0')
$measured = Get-Share $with.File $without.File $GroundTop 1.0
$share = $measured.Share
# Level ground at a distance sits below the horizon by the eye height over the distance, as a share of the frame's
# height: the frame is as tall as its width times the tangent of half its 90 degree lens, times height over width.
$varieties = @($manifest.turf.varieties)
$nearEndCm = ($varieties | Sort-Object end_cull_cm)[0].end_cull_cm
$farEndCm = ($varieties | Sort-Object end_cull_cm)[-1].end_cull_cm
$size = [System.Drawing.Bitmap]::new($with.File)
try { $halfHeight = $size.Height / $size.Width } finally { $size.Dispose() }
$rowAt = { param($cm) 0.5 + ($with.EyeM * 100 / $cm) / (2 * $halfHeight) }
$farTop = & $rowAt $farEndCm
$farBottom = & $rowAt $nearEndCm
$far = Get-Share $with.File $without.File $farTop $farBottom
$result = [ordered]@{ frame = $Frame }
if ($Noise) {
	$again = Get-Frame 'on2' @()
	$twin = Get-Share $with.File $again.File $GroundTop 1.0
	$farTwin = Get-Share $with.File $again.File $farTop $farBottom
	$result.share_two_identical_runs_differ = [math]::Round($twin.Share, 4)
	$result.mean_abs_diff_two_identical_runs = [math]::Round($twin.Mean, 3)
	$result.far_share_two_identical_runs_differ = [math]::Round($farTwin.Share, 4)
}
$farOk = $varieties.Count -lt 2 -or $far.Share -ge $MinFarShare
$ok = $share -ge $MinShare -and $farOk -and $lowest -ge 250
$result.grass_drawn_ok = $ok
$result.far_varieties_drawn_ok = $farOk
$result.far_band_rows = @([math]::Round($farTop, 3), [math]::Round($farBottom, 3))
$result.share_of_far_band_pixels_grass_changes = [math]::Round($far.Share, 4)
$result.min_far_share = $MinFarShare
$result.share_of_near_ground_pixels_grass_changes = [math]::Round($share, 4)
$result.mean_abs_diff_grass_on_off = [math]::Round($measured.Mean, 3)
$result.min_share = $MinShare
$result.lowest_grass_weight_at_camera_and_ahead = $lowest
$result.tufts_built_within_25m_median = $with.Built
$result | ConvertTo-Json
if ($lowest -lt 250) { Write-Error "frame $Frame is not on full grass weight ($lowest of 255): choose a frame where the walker stands on grass" }
if (-not $ok) { exit 1 }
