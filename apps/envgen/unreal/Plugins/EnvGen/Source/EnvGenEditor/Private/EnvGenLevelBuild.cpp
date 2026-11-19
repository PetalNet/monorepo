#include "EnvGenLevelBuild.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/DirectionalLight.h"
#include "Engine/ExponentialHeightFog.h"
#include "Engine/PostProcessVolume.h"
#include "Engine/SkyLight.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "EnvGenGameMode.h"
#include "EnvGenSiteInfo.h"
#include "FileHelpers.h"
#include "GameFramework/PlayerStart.h"
#include "GameFramework/WorldSettings.h"
#include "HAL/FileManager.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Landscape.h"
#include "LandscapeEdit.h"
#include "LandscapeInfo.h"
#include "LandscapeLayerInfoObject.h"
#include "LandscapeProxy.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionLandscapeLayerBlend.h"
#include "Materials/MaterialExpressionLandscapeLayerCoords.h"
#include "Materials/MaterialExpressionLinearInterpolate.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Materials/MaterialExpressionTextureSample.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Package.h"

DEFINE_LOG_CATEGORY_STATIC(LogEnvGen, Log, All);

namespace
{
	const TCHAR* OwnedPath = TEXT("/Game/EnvGen/");
	const TCHAR* GeneratedPath = TEXT("/Game/EnvGen/Generated");
	const TCHAR* DefaultMapPath = TEXT("/Game/EnvGen/Maps/Site");
	const FName GrassLayer(TEXT("Grass"));
	constexpr int32 DetailPixels = 256;
	constexpr float PhotoToAlbedo = 0.6f;
	// How far a traced surface point may sit from the height the manifest says it should have.
	constexpr double SurfaceToleranceCm = 5.0;
	// The engine merges Landscape edit layers over several frames after an import.
	constexpr int32 MinMergeFrames = 10;
	constexpr float MergeTimeoutSeconds = 300;

	struct FManifest
	{
		FString Directory;
		FString HeightmapFile;
		FString MacroColourFile;
		int32 Vertices = 0;
		int32 SectionQuads = 0;
		int32 SectionsPerComponent = 0;
		FVector LocationCm = FVector::ZeroVector;
		FVector Scale = FVector::OneVector;
		double TileSizeCm = 0;
		TSharedPtr<FJsonObject> Georeference;
		TSharedPtr<FJsonObject> StencilClasses;
	};

	FVector ReadVector(const TArray<TSharedPtr<FJsonValue>>& Values)
	{
		return FVector(Values[0]->AsNumber(), Values[1]->AsNumber(), Values[2]->AsNumber());
	}

	bool LoadManifest(const FString& Path, FManifest& Out, FString& Error)
	{
		FString Text;
		TSharedPtr<FJsonObject> Root;
		if (!FFileHelper::LoadFileToString(Text, *Path) || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root)
		{
			Error = FString::Printf(TEXT("cannot read %s as JSON"), *Path);
			return false;
		}
		const TSharedPtr<FJsonObject>* Landscape = nullptr;
		const TSharedPtr<FJsonObject>* Macro = nullptr;
		const TSharedPtr<FJsonObject>* Tile = nullptr;
		const TSharedPtr<FJsonObject>* Geo = nullptr;
		const TSharedPtr<FJsonObject>* Stencil = nullptr;
		if (!Root->TryGetObjectField(TEXT("landscape"), Landscape) || !Root->TryGetObjectField(TEXT("macro_colour"), Macro) ||
			!Root->TryGetObjectField(TEXT("tile"), Tile) || !Root->TryGetObjectField(TEXT("georeference"), Geo) ||
			!Root->TryGetObjectField(TEXT("stencil_classes"), Stencil))
		{
			Error = TEXT("the manifest needs landscape, macro_colour, tile, georeference and stencil_classes");
			return false;
		}
		Out.Directory = FPaths::GetPath(Path);
		Out.HeightmapFile = (*Landscape)->GetStringField(TEXT("heightmap"));
		Out.MacroColourFile = (*Macro)->GetStringField(TEXT("file"));
		Out.Vertices = (*Landscape)->GetIntegerField(TEXT("vertices"));
		Out.SectionQuads = (*Landscape)->GetIntegerField(TEXT("section_quads"));
		Out.SectionsPerComponent = (*Landscape)->GetIntegerField(TEXT("sections_per_component"));
		Out.LocationCm = ReadVector((*Landscape)->GetArrayField(TEXT("location_cm")));
		Out.Scale = ReadVector((*Landscape)->GetArrayField(TEXT("scale")));
		Out.TileSizeCm = (*Tile)->GetNumberField(TEXT("size_m")) * 100;
		Out.Georeference = *Geo;
		Out.StencilClasses = *Stencil;
		return true;
	}

	bool DecodePng(const FString& Path, ERGBFormat Format, int32 BitDepth, TArray64<uint8>& Raw, int32& Width, int32& Height)
	{
		TArray64<uint8> Compressed;
		if (!FFileHelper::LoadFileToArray(Compressed, *Path))
		{
			return false;
		}
		IImageWrapperModule& Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
		const TSharedPtr<IImageWrapper> Wrapper = Module.CreateImageWrapper(EImageFormat::PNG);
		if (!Wrapper || !Wrapper->SetCompressed(Compressed.GetData(), Compressed.Num()) || !Wrapper->GetRaw(Format, BitDepth, Raw))
		{
			return false;
		}
		Width = Wrapper->GetWidth();
		Height = Wrapper->GetHeight();
		return true;
	}

	template <typename T>
	T* NewAsset(const FString& Name, TArray<UPackage*>& Packages)
	{
		UPackage* Package = CreatePackage(*(FString(GeneratedPath) / Name));
		T* Asset = NewObject<T>(Package, *Name, RF_Public | RF_Standalone);
		FAssetRegistryModule::AssetCreated(Asset);
		Package->MarkPackageDirty();
		Packages.Add(Package);
		return Asset;
	}

	UTexture2D* MakeTexture(const FString& Name, int32 Width, int32 Height, ETextureSourceFormat Format, const uint8* Pixels, bool bSrgb, TArray<UPackage*>& Packages)
	{
		UTexture2D* Texture = NewAsset<UTexture2D>(Name, Packages);
		Texture->Source.Init(Width, Height, 1, 1, Format, Pixels);
		Texture->SRGB = bSrgb;
		Texture->CompressionSettings = Format == TSF_G8 ? TC_Grayscale : TC_Default;
		Texture->LODGroup = TEXTUREGROUP_World;
		Texture->PostEditChange();
		return Texture;
	}

	/** Tileable grey noise: a few octaves of value noise on a lattice that wraps at the texture edge. */
	TArray<uint8> DetailNoise()
	{
		const auto Lattice = [](int32 X, int32 Y, int32 Period, int32 Octave)
		{
			const uint32 Hash = HashCombine(HashCombine(GetTypeHash(((X % Period) + Period) % Period), GetTypeHash(((Y % Period) + Period) % Period)), GetTypeHash(Octave));
			return (Hash & 0xffff) / 65535.f;
		};
		TArray<uint8> Pixels;
		Pixels.SetNumUninitialized(DetailPixels * DetailPixels);
		for (int32 Y = 0; Y < DetailPixels; ++Y)
		{
			for (int32 X = 0; X < DetailPixels; ++X)
			{
				float Value = 0, Weight = 0;
				for (int32 Octave = 0; Octave < 5; ++Octave)
				{
					const int32 Period = 4 << Octave;
					const float Fx = float(X) * Period / DetailPixels, Fy = float(Y) * Period / DetailPixels;
					const int32 X0 = FMath::FloorToInt32(Fx), Y0 = FMath::FloorToInt32(Fy);
					const float Tx = FMath::SmoothStep(0.f, 1.f, Fx - X0), Ty = FMath::SmoothStep(0.f, 1.f, Fy - Y0);
					const float Sample = FMath::Lerp(
						FMath::Lerp(Lattice(X0, Y0, Period, Octave), Lattice(X0 + 1, Y0, Period, Octave), Tx),
						FMath::Lerp(Lattice(X0, Y0 + 1, Period, Octave), Lattice(X0 + 1, Y0 + 1, Period, Octave), Tx), Ty);
					const float Amplitude = 1.f / (1 + Octave);
					Value += Sample * Amplitude;
					Weight += Amplitude;
				}
				Pixels[Y * DetailPixels + X] = uint8(FMath::Clamp(Value / Weight, 0.f, 1.f) * 255);
			}
		}
		return Pixels;
	}

	template <typename T>
	T* Node(UMaterial* Material, int32 X, int32 Y)
	{
		return Cast<T>(UMaterialEditingLibrary::CreateMaterialExpression(Material, T::StaticClass(), X, Y));
	}

	UMaterialExpressionTextureSample* Sample(UMaterial* Material, UTexture2D* Texture, float QuadsPerRepeat, EMaterialSamplerType Sampler, int32 Y)
	{
		// LandscapeLayerCoords divides the vertex index by MappingScale, so one repeat spans MappingScale quads.
		UMaterialExpressionLandscapeLayerCoords* Coords = Node<UMaterialExpressionLandscapeLayerCoords>(Material, -1100, Y);
		Coords->MappingScale = QuadsPerRepeat;
		UMaterialExpressionTextureSample* Out = Node<UMaterialExpressionTextureSample>(Material, -800, Y);
		Out->Texture = Texture;
		Out->SamplerType = Sampler;
		Out->Coordinates.Connect(0, Coords);
		return Out;
	}

	/**
	 * One grass layer: the macro colour map across the whole tile, modulated by tiling grey detail at two
	 * scales. Colour that varies over tens of metres comes from evidence; everything finer is generated.
	 */
	UMaterial* MakeGroundMaterial(UTexture2D* Macro, UTexture2D* Detail, int32 Quads, double QuadCm, TArray<UPackage*>& Packages)
	{
		UMaterial* Material = NewAsset<UMaterial>(TEXT("M_Ground"), Packages);
		const float FineRepeatQuads = 70.0 / QuadCm;
		const float BroadRepeatQuads = 1100.0 / QuadCm;
		UMaterialExpressionTextureSample* MacroSample = Sample(Material, Macro, Quads, SAMPLERTYPE_Color, 0);
		UMaterialExpressionTextureSample* Fine = Sample(Material, Detail, FineRepeatQuads, SAMPLERTYPE_LinearGrayscale, 250);
		UMaterialExpressionTextureSample* Broad = Sample(Material, Detail, BroadRepeatQuads, SAMPLERTYPE_LinearGrayscale, 500);

		const auto Modulate = [Material](UMaterialExpression* Colour, UMaterialExpressionTextureSample* Grey, float Low, float High, int32 Y)
		{
			UMaterialExpressionLinearInterpolate* Range = Node<UMaterialExpressionLinearInterpolate>(Material, -500, Y);
			Range->ConstA = Low;
			Range->ConstB = High;
			Range->Alpha.Connect(1, Grey);
			UMaterialExpressionMultiply* Out = Node<UMaterialExpressionMultiply>(Material, -300, Y);
			Out->A.Connect(0, Colour);
			Out->B.Connect(0, Range);
			return Out;
		};
		UMaterialExpression* Modulated = Modulate(Modulate(MacroSample, Fine, 0.85f, 1.15f, 250), Broad, 0.85f, 1.15f, 500);
		// An aerial photo records sunlit ground, so as albedo it is too bright until the pipeline delights it.
		UMaterialExpressionMultiply* Colour = Node<UMaterialExpressionMultiply>(Material, -200, 100);
		Colour->A.Connect(0, Modulated);
		Colour->ConstB = PhotoToAlbedo;

		UMaterialExpressionLandscapeLayerBlend* Blend = Node<UMaterialExpressionLandscapeLayerBlend>(Material, -100, 0);
		FLayerBlendInput& Layer = Blend->Layers.AddDefaulted_GetRef();
		Layer.LayerName = GrassLayer;
		Layer.BlendType = LB_WeightBlend;
		Layer.PreviewWeight = 1;
		Layer.LayerInput.Connect(0, Colour);
		UMaterialEditingLibrary::ConnectMaterialProperty(Blend, TEXT(""), MP_BaseColor);

		UMaterialExpressionConstant* Roughness = Node<UMaterialExpressionConstant>(Material, -100, 300);
		Roughness->R = 0.9f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Roughness, TEXT(""), MP_Roughness);
		UMaterialExpressionConstant* Specular = Node<UMaterialExpressionConstant>(Material, -100, 400);
		Specular->R = 0.2f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Specular, TEXT(""), MP_Specular);

		UMaterialEditingLibrary::RecompileMaterial(Material);
		return Material;
	}

	ALandscape* ImportLandscape(UWorld* World, const FManifest& Manifest, const TArray64<uint8>& HeightBytes, UMaterial* Material, int32 GroundStencil, TArray<UPackage*>& Packages)
	{
		const int32 Vertices = Manifest.Vertices;
		TArray<uint16> Heights;
		Heights.SetNumUninitialized(Vertices * Vertices);
		FMemory::Memcpy(Heights.GetData(), HeightBytes.GetData(), Heights.Num() * sizeof(uint16));

		ULandscapeLayerInfoObject* LayerInfo = NewAsset<ULandscapeLayerInfoObject>(TEXT("LI_Grass"), Packages);
		LayerInfo->SetLayerName(GrassLayer, false);
		FLandscapeImportLayerInfo GrassImport(GrassLayer);
		GrassImport.LayerInfo = LayerInfo;
		GrassImport.LayerData.Init(255, Vertices * Vertices);

		TMap<FGuid, TArray<uint16>> HeightsPerLayer;
		HeightsPerLayer.Add(FGuid(), MoveTemp(Heights));
		TMap<FGuid, TArray<FLandscapeImportLayerInfo>> WeightsPerLayer;
		WeightsPerLayer.Add(FGuid(), {GrassImport});

		ALandscape* Landscape = World->SpawnActor<ALandscape>(Manifest.LocationCm, FRotator::ZeroRotator);
		Landscape->SetActorLabel(TEXT("EnvGenLandscape"));
		Landscape->SetActorRelativeScale3D(Manifest.Scale);
		Landscape->LandscapeMaterial = Material;
		Landscape->bRenderCustomDepth = true;
		Landscape->CustomDepthStencilValue = GroundStencil;
		// A weightmap for a layer the Landscape does not list as a target is dropped on import.
		Landscape->AddTargetLayer(GrassLayer, FLandscapeTargetLayerSettings(LayerInfo), false);
		Landscape->Import(FGuid::NewGuid(), 0, 0, Vertices - 1, Vertices - 1, Manifest.SectionsPerComponent, Manifest.SectionQuads, HeightsPerLayer, nullptr,
			WeightsPerLayer, ELandscapeImportAlphamapType::Additive, TArrayView<const FLandscapeLayer>());

		ULandscapeInfo* Info = Landscape->GetLandscapeInfo();
		check(Info);
		Info->UpdateLayerInfoMap(Landscape);
		Landscape->RegisterAllComponents();
		return Landscape;
	}

	void AddSkyAndSun(UWorld* World)
	{
		// Sun in the south-east, about 48 degrees up. World +X is north and +Y is east, so the light travels north-west.
		ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector(0, 0, 20000), FRotator(-48, -45, 0));
		Sun->SetActorLabel(TEXT("EnvGenSun"));
		Sun->GetLightComponent()->SetMobility(EComponentMobility::Movable);
		Sun->GetLightComponent()->SetIntensity(10);
		Cast<UDirectionalLightComponent>(Sun->GetLightComponent())->SetAtmosphereSunLight(true);

		AActor* Atmosphere = World->SpawnActor<AActor>(ASkyAtmosphere::StaticClass(), FTransform::Identity);
		Atmosphere->SetActorLabel(TEXT("EnvGenSkyAtmosphere"));

		ASkyLight* Sky = World->SpawnActor<ASkyLight>(FVector(0, 0, 20000), FRotator::ZeroRotator);
		Sky->SetActorLabel(TEXT("EnvGenSkyLight"));
		Sky->GetLightComponent()->SetMobility(EComponentMobility::Movable);
		Sky->GetLightComponent()->SetRealTimeCapture(true);

		AExponentialHeightFog* Fog = World->SpawnActor<AExponentialHeightFog>(FVector::ZeroVector, FRotator::ZeroRotator);
		Fog->SetActorLabel(TEXT("EnvGenFog"));
		Fog->GetComponent()->SetFogDensity(0.005f);

		// Exposure may adapt only inside a narrow band (EV100), so a camera never whites out.
		APostProcessVolume* Exposure = World->SpawnActor<APostProcessVolume>(FVector::ZeroVector, FRotator::ZeroRotator);
		Exposure->SetActorLabel(TEXT("EnvGenExposure"));
		Exposure->bUnbound = true;
		Exposure->Settings.bOverride_AutoExposureMinBrightness = true;
		Exposure->Settings.bOverride_AutoExposureMaxBrightness = true;
		Exposure->Settings.AutoExposureMinBrightness = 2.0f;
		Exposure->Settings.AutoExposureMaxBrightness = 3.5f;
		// Sharp frames matter more than cinematic blur for inspection and for simulated cameras.
		Exposure->Settings.bOverride_MotionBlurAmount = true;
		Exposure->Settings.MotionBlurAmount = 0;
	}

	void AddSiteInfo(UWorld* World, const FManifest& Manifest)
	{
		AEnvGenSiteInfo* Site = World->SpawnActor<AEnvGenSiteInfo>();
		Site->SetActorLabel(TEXT("EnvGenSiteInfo"));
		const FJsonObject& Geo = *Manifest.Georeference;
		Site->ProjectedCrs = Geo.GetStringField(TEXT("crs"));
		Site->OriginEastingM = Geo.GetNumberField(TEXT("origin_easting_m"));
		Site->OriginNorthingM = Geo.GetNumberField(TEXT("origin_northing_m"));
		Site->OriginLatitudeDeg = Geo.GetNumberField(TEXT("origin_latitude_deg"));
		Site->OriginLongitudeDeg = Geo.GetNumberField(TEXT("origin_longitude_deg"));
		Site->OriginHeightM = Geo.GetNumberField(TEXT("origin_height_m"));
		Site->VerticalDatum = Geo.GetStringField(TEXT("vertical_datum"));
		Site->TrueNorthFromGridNorthDeg = Geo.GetNumberField(TEXT("true_north_from_grid_north_deg"));
		Site->TileSizeCm = Manifest.TileSizeCm;
		for (const auto& Class : Manifest.StencilClasses->Values)
		{
			Site->StencilClasses.Add(FName(*Class.Key), int32(Class.Value->AsNumber()));
		}
	}

	/**
	 * Trace the collision surface at vertices spread unevenly over the tile and compare with the heights
	 * that were imported. A transposed or mirrored import fails this; so does missing collision.
	 */
	double WorstSurfaceErrorCm(UWorld* World, const FManifest& Manifest, const TArray64<uint8>& HeightBytes, int32& Missed)
	{
		const uint16* Heights = reinterpret_cast<const uint16*>(HeightBytes.GetData());
		const int32 Last = Manifest.Vertices - 1;
		const double Fractions[][2] = {{0.5, 0.5}, {0.1, 0.2}, {0.9, 0.2}, {0.15, 0.85}, {0.8, 0.9}, {0.33, 0.61}, {0.72, 0.41}, {0.05, 0.5}, {0.5, 0.95}};
		double Worst = 0;
		Missed = 0;
		for (const double* Fraction : Fractions)
		{
			const int32 NorthIndex = FMath::RoundToInt32(Fraction[0] * Last);
			const int32 EastIndex = FMath::RoundToInt32(Fraction[1] * Last);
			const double Expected = Manifest.LocationCm.Z + (double(Heights[EastIndex * Manifest.Vertices + NorthIndex]) - 32768.0) * Manifest.Scale.Z / 128.0;
			const FVector At(Manifest.LocationCm.X + NorthIndex * Manifest.Scale.X, Manifest.LocationCm.Y + EastIndex * Manifest.Scale.Y, 0);
			FHitResult Hit;
			if (!World->LineTraceSingleByChannel(Hit, At + FVector(0, 0, 200000), At - FVector(0, 0, 200000), ECC_WorldStatic))
			{
				++Missed;
				continue;
			}
			Worst = FMath::Max(Worst, FMath::Abs(Hit.Location.Z - Expected));
		}
		return Worst;
	}
	/** The merged weight of the grass layer at the middle of the Landscape, 0 to 1, or -1 if unreadable. */
	float GrassWeightAtCentre(ALandscape* Landscape)
	{
		ULandscapeInfo* Info = Landscape->GetLandscapeInfo();
		ULandscapeLayerInfoObject* Layer = Info->GetLayerInfoByName(GrassLayer);
		int32 MinX, MinY, MaxX, MaxY;
		if (!Layer || !Info->GetLandscapeExtent(MinX, MinY, MaxX, MaxY))
		{
			return -1;
		}
		int32 X1 = (MinX + MaxX) / 2, Y1 = (MinY + MaxY) / 2, X2 = X1, Y2 = Y1;
		uint8 Weight = 0;
		FLandscapeEditDataInterface Edit(Info);
		Edit.GetWeightDataFast(Layer, X1, Y1, X2, Y2, &Weight, 0);
		return Weight / 255.f;
	}
}

struct FEnvGenLevelBuild::FState
{
	FManifest Manifest;
	FString MapPath;
	TArray64<uint8> HeightBytes;
	TArray<UPackage*> Packages;
	UWorld* World = nullptr;
	ALandscape* Landscape = nullptr;
	float Waited = 0;
	int32 Frames = 0;
};

bool FEnvGenLevelBuild::Start(const FString& ManifestPath, const FString& MapPath)
{
	State = MakeShared<FState>();
	State->MapPath = MapPath.IsEmpty() ? FString(DefaultMapPath) : MapPath;
	// The target map is deleted and rewritten, so it may only be one of ours.
	if (!State->MapPath.StartsWith(OwnedPath))
	{
		UE_LOG(LogEnvGen, Error, TEXT("the map must be under %s, got %s"), OwnedPath, *State->MapPath);
		return false;
	}
	FManifest& Manifest = State->Manifest;
	FString Error;
	if (!LoadManifest(ManifestPath, Manifest, Error))
	{
		UE_LOG(LogEnvGen, Error, TEXT("%s"), *Error);
		return false;
	}

	TArray64<uint8> MacroBytes;
	int32 Width = 0, Height = 0, MacroWidth = 0, MacroHeight = 0;
	if (!DecodePng(Manifest.Directory / Manifest.HeightmapFile, ERGBFormat::Gray, 16, State->HeightBytes, Width, Height) || Width != Manifest.Vertices ||
		Height != Manifest.Vertices)
	{
		UE_LOG(LogEnvGen, Error, TEXT("%s is not a %dx%d 16-bit grey PNG"), *Manifest.HeightmapFile, Manifest.Vertices, Manifest.Vertices);
		return false;
	}
	if (!DecodePng(Manifest.Directory / Manifest.MacroColourFile, ERGBFormat::BGRA, 8, MacroBytes, MacroWidth, MacroHeight))
	{
		UE_LOG(LogEnvGen, Error, TEXT("cannot decode %s"), *Manifest.MacroColourFile);
		return false;
	}

	// From scratch: nothing generated by an earlier run survives. The editor starts on a blank map first,
	// so the old level and its assets are not loaded when their files go.
	State->World = UEditorLoadingAndSavingUtils::NewBlankMap(false);
	if (!State->World)
	{
		UE_LOG(LogEnvGen, Error, TEXT("could not create a blank map"));
		return false;
	}
	FString GeneratedDirectory, MapFile;
	if (!FPackageName::TryConvertLongPackageNameToFilename(FString(GeneratedPath), GeneratedDirectory) ||
		!FPackageName::TryConvertLongPackageNameToFilename(State->MapPath, MapFile, FPackageName::GetMapPackageExtension()))
	{
		UE_LOG(LogEnvGen, Error, TEXT("cannot turn %s or %s into a file path"), GeneratedPath, *State->MapPath);
		return false;
	}
	IFileManager::Get().DeleteDirectory(*GeneratedDirectory, false, true);
	IFileManager::Get().Delete(*MapFile);

	UTexture2D* Macro = MakeTexture(TEXT("T_MacroColour"), MacroWidth, MacroHeight, TSF_BGRA8, MacroBytes.GetData(), true, State->Packages);
	const TArray<uint8> Noise = DetailNoise();
	UTexture2D* Detail = MakeTexture(TEXT("T_Detail"), DetailPixels, DetailPixels, TSF_G8, Noise.GetData(), false, State->Packages);
	UMaterial* Material = MakeGroundMaterial(Macro, Detail, Manifest.Vertices - 1, Manifest.Scale.X, State->Packages);

	const int32 GroundStencil = int32(Manifest.StencilClasses->GetNumberField(TEXT("ground")));
	State->Landscape = ImportLandscape(State->World, Manifest, State->HeightBytes, Material, GroundStencil, State->Packages);
	AddSkyAndSun(State->World);
	AddSiteInfo(State->World, Manifest);
	APlayerStart* PlayerStart = State->World->SpawnActor<APlayerStart>(FVector(0, 0, 150), FRotator::ZeroRotator);
	PlayerStart->SetActorLabel(TEXT("EnvGenPlayerStart"));
	State->World->GetWorldSettings()->DefaultGameMode = AEnvGenGameMode::StaticClass();
	return true;
}

bool FEnvGenLevelBuild::Finish(float DeltaSeconds, bool& bSucceeded)
{
	State->Waited += DeltaSeconds;
	++State->Frames;
	const bool bMerged = State->Frames > MinMergeFrames && State->Landscape->IsUpToDate();
	if (!bMerged && State->Waited < MergeTimeoutSeconds)
	{
		return false;
	}

	const FManifest& Manifest = State->Manifest;
	int32 Missed = 0;
	const double WorstCm = WorstSurfaceErrorCm(State->World, Manifest, State->HeightBytes, Missed);
	const int32 Components = State->Landscape->LandscapeComponents.Num();
	const int32 TargetLayers = State->Landscape->GetTargetLayers().Num();
	const float GrassWeight = GrassWeightAtCentre(State->Landscape);
	const bool bSurfaceOk = Missed == 0 && WorstCm <= SurfaceToleranceCm;
	const bool bWeightsOk = TargetLayers == 1 && GrassWeight > 0.99f;
	const bool bSaved = UEditorLoadingAndSavingUtils::SavePackages(State->Packages, false) && UEditorLoadingAndSavingUtils::SaveMap(State->World, State->MapPath);
	bSucceeded = bMerged && bSurfaceOk && bWeightsOk && bSaved;

	TSharedRef<FJsonObject> Receipt = MakeShared<FJsonObject>();
	Receipt->SetStringField(TEXT("map"), State->MapPath);
	Receipt->SetStringField(TEXT("engine"), FEngineVersion::Current().ToString());
	Receipt->SetNumberField(TEXT("landscape_components"), Components);
	Receipt->SetBoolField(TEXT("edit_layers_merged"), bMerged);
	Receipt->SetNumberField(TEXT("merge_seconds"), State->Waited);
	Receipt->SetNumberField(TEXT("surface_points_missed"), Missed);
	Receipt->SetNumberField(TEXT("surface_worst_error_cm"), WorstCm);
	Receipt->SetNumberField(TEXT("surface_tolerance_cm"), SurfaceToleranceCm);
	Receipt->SetBoolField(TEXT("surface_ok"), bSurfaceOk);
	Receipt->SetNumberField(TEXT("target_layers"), TargetLayers);
	Receipt->SetNumberField(TEXT("grass_weight_at_centre"), GrassWeight);
	Receipt->SetBoolField(TEXT("weights_ok"), bWeightsOk);
	Receipt->SetBoolField(TEXT("saved"), bSaved);
	Receipt->SetBoolField(TEXT("succeeded"), bSucceeded);
	FString Json;
	FJsonSerializer::Serialize(Receipt, TJsonWriterFactory<>::Create(&Json));
	FFileHelper::SaveStringToFile(Json, *(FPaths::ProjectSavedDir() / TEXT("EnvGen") / TEXT("build_receipt.json")));

	UE_LOG(LogEnvGen, Display, TEXT("%s: %d components, merged=%d, surface worst error %.2f cm (%d missed), grass weight %.2f, saved=%d"), *State->MapPath, Components,
		bMerged, WorstCm, Missed, GrassWeight, bSaved);
	if (!bSucceeded)
	{
		UE_LOG(LogEnvGen, Error, TEXT("the level build failed its checks; see Saved/EnvGen/build_receipt.json"));
	}
	return true;
}
