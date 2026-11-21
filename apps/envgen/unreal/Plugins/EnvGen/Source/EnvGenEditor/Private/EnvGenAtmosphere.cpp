#include "EnvGenAtmosphere.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/VolumetricCloudComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/ExponentialHeightFog.h"
#include "Engine/PostProcessVolume.h"
#include "Engine/Texture2D.h"
#include "Engine/SkyLight.h"
#include "Engine/World.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialInstanceConstant.h"
#include "UObject/Package.h"

bool AddEnvGenAtmosphere(UWorld* World, const FEnvGenLighting& Lighting, TArray<UPackage*>& Packages, FString& Error)
{
	UMaterialInterface* CloudMaterial = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/EngineSky/VolumetricClouds/m_SimpleVolumetricCloud_Inst.m_SimpleVolumetricCloud_Inst"));
	UTexture2D* GrainTexture = LoadObject<UTexture2D>(nullptr, TEXT("/Engine/EngineResources/FilmGrains/Marcie_Grain_v3_128_M2_000.Marcie_Grain_v3_128_M2_000"));
	if (!CloudMaterial || !GrainTexture)
	{
		Error = TEXT("the engine's volumetric cloud material or film grain texture is missing");
		return false;
	}

	// +X is grid north, +Y east; light travels away from the measured sun bearing.
	ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>();
	Sun->SetActorLabel(TEXT("EnvGenSun"));
	Sun->SetActorLocation(FVector(0, 0, 20000));
	// SpawnActor combines the requested transform with the light actor's default root rotation.
	const FRotator BeamRotation(-Lighting.ElevationDeg, Lighting.GridAzimuthDeg + 180.0, 0);
	Sun->SetActorRotation(BeamRotation);
	UDirectionalLightComponent* Beam = CastChecked<UDirectionalLightComponent>(Sun->GetLightComponent());
	Beam->SetMobility(EComponentMobility::Movable);
	Beam->SetAtmosphereSunLight(true);
	Beam->SetLightSourceAngle(0.5357f);
	Beam->ContactShadowLength = 0.02f;
	Beam->bCastCloudShadows = true;
	Beam->CloudShadowExtent = 8.0f;
	Beam->CloudShadowMapResolutionScale = 0.5f;
	Beam->CloudShadowRaySampleCountScale = 0.5f;
	Beam->CloudShadowOnSurfaceStrength = 0.35f;

	ASkyAtmosphere* Atmosphere = World->SpawnActor<ASkyAtmosphere>();
	Atmosphere->SetActorLabel(TEXT("EnvGenSkyAtmosphere"));
	USkyAtmosphereComponent* Air = Atmosphere->GetComponent();
	// This property is an extinction coefficient, not a unitless multiplier.
	Air->SetMieScatteringScale(Air->MieScatteringScale * 1.2f);
	Air->SetAerialPespectiveViewDistanceScale(1.0f);
	// The manifest gives illuminance after atmospheric attenuation, while the component expects outer-space lux.
	Beam->SetIntensity(Air->GetAtmosphericLightToMatchIlluminanceOnGround(-Beam->GetForwardVector(), float(Lighting.SunLux)));
	if (!Beam->GetForwardVector().Equals(BeamRotation.Vector(), 1.e-4))
	{
		Error = TEXT("the generated sun direction does not match the manifest");
		return false;
	}
	UE_LOG(LogTemp, Display, TEXT("EnvGen atmosphere: elevation=%.3f grid_azimuth=%.3f mie_coefficient=%.6f ground_lux=%.1f outer_lux=%.1f"),
		Lighting.ElevationDeg, Lighting.GridAzimuthDeg, Air->MieScatteringScale, Lighting.SunLux, Beam->Intensity);

	UPackage* CloudPackage = CreatePackage(TEXT("/Game/EnvGen/Generated/M_AtmosphereClouds"));
	UMaterialInstanceConstant* FairWeather = NewObject<UMaterialInstanceConstant>(CloudPackage, TEXT("M_AtmosphereClouds"), RF_Public | RF_Standalone);
	FAssetRegistryModule::AssetCreated(FairWeather);
	FairWeather->SetParentEditorOnly(CloudMaterial);
	FairWeather->SetScalarParameterValueEditorOnly(FMaterialParameterInfo(TEXT("Cloud_GlobalCoverage")), 0.25f);
	FairWeather->SetScalarParameterValueEditorOnly(FMaterialParameterInfo(TEXT("Cloud_GlobalDensity")), 0.3f);
	FairWeather->PostEditChange();
	CloudPackage->MarkPackageDirty();
	Packages.Add(CloudPackage);

	AVolumetricCloud* Clouds = World->SpawnActor<AVolumetricCloud>();
	Clouds->SetActorLabel(TEXT("EnvGenVolumetricCloud"));
	UVolumetricCloudComponent* Volume = Clouds->FindComponentByClass<UVolumetricCloudComponent>();
	Volume->SetMaterial(FairWeather);
	Volume->SetLayerBottomAltitude(1.8f);
	Volume->SetLayerHeight(2.0f);
	Volume->SetTracingMaxDistance(30.0f);
	Volume->SetViewSampleCountScale(0.5f);
	Volume->SetReflectionViewSampleCountScale(0.25f);
	Volume->SetShadowViewSampleCountScale(0.5f);
	Volume->SetShadowReflectionViewSampleCountScale(0.25f);
	Volume->SetGroundAlbedo(FColor(90, 95, 75));

	ASkyLight* Sky = World->SpawnActor<ASkyLight>(FVector(0, 0, 20000), FRotator::ZeroRotator);
	Sky->SetActorLabel(TEXT("EnvGenSkyLight"));
	Sky->GetLightComponent()->SetMobility(EComponentMobility::Movable);
	Sky->GetLightComponent()->SetRealTimeCapture(true);

	AExponentialHeightFog* Fog = World->SpawnActor<AExponentialHeightFog>();
	Fog->SetActorLabel(TEXT("EnvGenHeightFog"));
	UExponentialHeightFogComponent* Haze = Fog->GetComponent();
	Haze->SetFogDensity(0.05f);
	Haze->SetFogHeightFalloff(0.2f);
	// Keep the first 100 m clear and blend the coarse context into the horizon.
	Haze->SetStartDistance(10000.0f);
	Haze->SetFogMaxOpacity(0.85f);
	// SkyAtmosphere supplies the scattering colour; a second coloured fog would double the tint.
	Haze->SetFogInscatteringColor(FLinearColor::Black);
	Haze->SetDirectionalInscatteringColor(FLinearColor::Black);
	Haze->SetVolumetricFog(false);

	APostProcessVolume* Post = World->SpawnActor<APostProcessVolume>();
	Post->SetActorLabel(TEXT("EnvGenExposure"));
	Post->bUnbound = true;
	FPostProcessSettings& Settings = Post->Settings;
	Settings.bOverride_AutoExposureMinBrightness = true;
	Settings.bOverride_AutoExposureMaxBrightness = true;
	Settings.AutoExposureMinBrightness = float(Lighting.ExposureEv100);
	Settings.AutoExposureMaxBrightness = float(Lighting.ExposureEv100);
	Settings.bOverride_AutoExposureBias = true;
	Settings.AutoExposureBias = 1.0f;
	Settings.bOverride_DynamicGlobalIlluminationMethod = true;
	Settings.DynamicGlobalIlluminationMethod = EDynamicGlobalIlluminationMethod::Lumen;
	Settings.bOverride_ReflectionMethod = true;
	Settings.ReflectionMethod = EReflectionMethod::Lumen;
	Settings.bOverride_LumenSceneViewDistance = true;
	Settings.LumenSceneViewDistance = 20000.0f;
	Settings.bOverride_LumenMaxTraceDistance = true;
	Settings.LumenMaxTraceDistance = 20000.0f;
	Settings.bOverride_LumenFinalGatherQuality = true;
	Settings.LumenFinalGatherQuality = 1.0f;
	Settings.bOverride_LumenReflectionQuality = true;
	Settings.LumenReflectionQuality = 0.5f;
	Settings.bOverride_ColorSaturation = true;
	Settings.ColorSaturation = FVector4(0.98f, 0.98f, 0.98f, 1.0f);
	Settings.bOverride_VignetteIntensity = true;
	Settings.VignetteIntensity = 0.12f;
	Settings.bOverride_FilmGrainIntensity = true;
	Settings.FilmGrainIntensity = 0.06f;
	Settings.bOverride_FilmGrainTexture = true;
	Settings.FilmGrainTexture = GrainTexture;
	Settings.bOverride_BloomIntensity = true;
	Settings.BloomIntensity = 0.1f;
	Settings.bOverride_MotionBlurAmount = true;
	Settings.MotionBlurAmount = 0.0f;
	return true;
}
