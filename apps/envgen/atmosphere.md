# Outdoor atmosphere

`EnvGenAtmosphere.cpp` owns the sun, sky, clouds, fog and post-process volume. The level builder calls it once. C++ is used because these are editor-generated Unreal components and saved engine assets.

The sun bearing, elevation, direct-normal illuminance in lux and fixed EV100 come from `build.json.lighting`. When a dated survey supplies an orthophoto, DSM and DTM in the site's metre-based CRS, `survey_light.py` fits contemporary cast shadows on open ground. It searches the date's solar path at 20 minute intervals, refines at 5 minutes, and records correlation, sample count and date uncertainty. It does not fit crown growth. The fitted solar time is applied to the requested target date, preserving the pipeline's seasonal-date contract. To reproduce the capture day, the site must request that date. `lighting.survey_fit` retains the fit on the acquisition date. Missing or weak evidence retains the existing NAIP/target-day sun. All three survey rasters and metadata participate in the stage cache key.

A date string that names several flights uses its first ISO date as an explicit prior. The fit is not recovered EXIF time, and one sun across a mosaic is an approximation. Without a survey fit, a target month still uses its 15th as a prior. The existing 0.95 EV engine calibration remains a prior. No weather observation or calibrated camera response is available.

The following are presentation priors, not measurements of the site:

| Setting                                        | Value                                 | Reason                                                                                           |
| ---------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Solar angular diameter                         | 0.5357 degrees                        | Earth daylight penumbra rather than a point light                                                |
| Contact shadows                                | 0.02 of screen width                  | Small contact detail without long screen-space shadows                                           |
| Mie scattering coefficient                     | 1.2 times the engine default          | Mild aerosol haze beyond the site; the component property is a coefficient, not a unitless scale |
| Aerial perspective scale                       | 1                                     | Physical distance rather than an artistic multiplier                                             |
| Cloud base / depth / trace distance            | 1.8 / 2 / 30 km                       | Fair-weather low cloud layer; weather is unknown                                                 |
| Cloud material                                 | Engine `m_SimpleVolumetricCloud_Inst` | Ships with Unreal; no separately licensed content                                                |
| Cloud coverage / density                       | 0.25 / 0.3                            | Broken fair-weather cloud, rather than the engine material's dense default                       |
| Cloud view / reflection samples                | 0.5 / 0.25 scale                      | Outdoor 3080 budget                                                                              |
| Cloud shadow view / reflection samples         | 0.5 / 0.25 scale                      | Outdoor 3080 budget                                                                              |
| Cloud shadow extent / map resolution / samples | 8 km / 0.5 / 0.5                      | Cover the site and surround with a bounded shadow map                                            |
| Cloud shadow strength on surface               | 0.35                                  | Preserve survey shadow readability with unknown cloud cover                                      |
| Cloud ground albedo                            | sRGB 90, 95, 75                       | Vegetated regional ground bounce; not calibrated from the ortho                                  |
| Fog density / height falloff                   | 0.05 / 0.2                            | Blend source-textured context into the horizon in matched fly captures                           |
| Analytic fog start / max opacity               | 100 m / 0.85                          | Keep nearby detail clear while softening the coarse context                                      |
| Volumetric fog                                 | Off                                   | Daylight haze uses the cheaper analytic and aerial-perspective paths                             |
| Lumen scene / maximum trace distance           | 200 m / 200 m                         | Nearby outdoor occlusion and bounce                                                              |
| Lumen gather / reflection quality              | 1 / 0.5                               | Rough outdoor surfaces rarely need expensive mirror traces                                       |
| Global saturation                              | 0.98                                  | Small reduction; no replacement of measured material colour                                      |
| Vignette / film grain / bloom                  | 0.12 / 0.06 / 0.1                     | Slight lens response; preserve fine detail                                                       |
| Exposure compensation / motion blur            | +1 EV / 0                             | Preserve the base branch's engine exposure bias, on which its EV100 calibration depends          |
| Playable camera                                | 73.74 degrees horizontal              | 24 mm lens equivalent on a 36 mm sensor                                                          |

Fixed walk, fly and overview tours retain their original 90 degree horizontal field of view and camera paths. Fixed-step captures are visual evidence only; performance uses separate non-fixed-step runs.

SkyAtmosphere contributes the fog colour through `r.SupportSkyAtmosphereAffectsHeightFog`; the fog's independent colour terms are black to avoid adding a second tint. A movable real-time skylight captures atmosphere and clouds for diffuse lighting. Lumen GI, reflections and virtual shadow maps remain enabled. Generated grass uses two-sided foliage shading and subsurface colour in `MakeBladeMaterial`; imported tree leaf materials retain their authored translucency.

The manifest's sun illuminance has already passed through a clear-sky model. `GetAtmosphericLightToMatchIlluminanceOnGround` converts it to the outer-space illuminance the engine expects, using the atmosphere's own transmittance. This prevents a second attenuation. Film grain uses the engine's 128-pixel grain texture explicitly, avoiding a missing default texture proxy on 5.8.4.

The light actor's rotation is set after spawning: its default root rotation otherwise combines with the requested spawn transform. Generation checks the outgoing light direction against the manifest and logs the Mie coefficient and ground/outer-space lux for inspection.

Engine references: [Sky Atmosphere](https://dev.epicgames.com/documentation/en-us/unreal-engine/sky-atmosphere-component-in-unreal-engine), [volumetric cloud properties](https://dev.epicgames.com/documentation/en-us/unreal-engine/volumetric-cloud-component-properties-in-unreal-engine), [physical lighting units](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-physical-lighting-units-in-unreal-engine). The implementation was checked against the installed 5.8.4 headers; current web documentation may describe a newer release.
