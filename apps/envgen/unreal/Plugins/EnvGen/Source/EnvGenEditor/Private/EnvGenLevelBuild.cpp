#include "EnvGenLevelBuild.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/InstancedSkinnedMeshComponent.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/DirectionalLight.h"
#include "Engine/PostProcessVolume.h"
#include "Engine/SkinnedAsset.h"
#include "Engine/SkyLight.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/StaticMesh.h"
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
#include "LandscapeGrassType.h"
#include "LandscapeEdit.h"
#include "LandscapeInfo.h"
#include "LandscapeLayerInfoObject.h"
#include "LandscapeProxy.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionAdd.h"
#include "Materials/MaterialExpressionAppendVector.h"
#include "Materials/MaterialExpressionCameraPositionWS.h"
#include "Materials/MaterialExpressionDistance.h"
#include "Materials/MaterialExpressionSaturate.h"
#include "Materials/MaterialExpressionSubtract.h"
#include "Materials/MaterialExpressionTransformPosition.h"
#include "Materials/MaterialExpressionComponentMask.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionDivide.h"
#include "Materials/MaterialExpressionLandscapeLayerBlend.h"
#include "Materials/MaterialExpressionLandscapeGrassOutput.h"
#include "Materials/MaterialExpressionLandscapeLayerCoords.h"
#include "Materials/MaterialExpressionLandscapeLayerSample.h"
#include "Materials/MaterialExpressionLinearInterpolate.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Materials/MaterialExpressionMin.h"
#include "Materials/MaterialExpressionOneMinus.h"
#include "Materials/MaterialExpressionAbs.h"
#include "Materials/MaterialExpressionFloor.h"
#include "Materials/MaterialExpressionObjectPositionWS.h"
#include "Materials/MaterialExpressionPerInstanceRandom.h"
#include "Materials/MaterialExpressionPower.h"
#include "Materials/MaterialExpressionSmoothStep.h"
#include "Materials/MaterialExpressionVertexColor.h"
#include "Materials/MaterialExpressionWorldPosition.h"
#include "Materials/MaterialExpressionVertexNormalWS.h"
#include "Materials/MaterialExpressionTextureCoordinate.h"
#include "Materials/MaterialExpressionTextureObject.h"
#include "Materials/MaterialExpressionTime.h"
#include "PhysicsEngine/BodySetup.h"
#include "StaticMeshCompiler.h"
#include "Materials/MaterialExpressionTextureSample.h"
#include "MeshDescription.h"
#include "Misc/FileHelper.h"
#include "RHIGlobals.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "StaticMeshAttributes.h"
#include "UObject/Package.h"
#include "UObject/UObjectIterator.h"

DEFINE_LOG_CATEGORY_STATIC(LogEnvGen, Log, All);

namespace
{
	const TCHAR* OwnedPath = TEXT("/Game/EnvGen/");
	const TCHAR* GeneratedPath = TEXT("/Game/EnvGen/Generated");
	const TCHAR* DefaultMapPath = TEXT("/Game/EnvGen/Maps/Site");
	const FName GrassLayer(TEXT("grass"));
	const FName PavedLayer(TEXT("paved"));
	const FName SoilLayer(TEXT("soil"));
	constexpr int32 DetailPixels = 256;
	// A class edge between two weightmap vertices is a straight ramp, which at the camera's distance reads as a blur
	// several metres wide. The material cuts the ramp to this fraction either side of 0.5 and lets the relief map
	// move the cut a little: a look, not a measurement.
	constexpr float EdgeSharpness = 0.35f;
	constexpr float ReliefInfluence = 0.15f;
	// How far a traced surface point may sit from the height the manifest says it should have.
	constexpr double SurfaceToleranceCm = 5.0;
	// The engine merges Landscape edit layers over several frames after an import.
	constexpr int32 MinMergeFrames = 10;
	constexpr float MergeTimeoutSeconds = 300;
	// How far a merged layer weight may sit from the imported one, out of 255.
	constexpr int32 WeightTolerance = 2;
	// How many trees, spread through the inventory, the build traces down onto to check their collision.
	constexpr int32 TreeChecks = 25;
	// The ground beyond the outermost surface: a flat plane this wide, this far under that surface's lowest point.
	constexpr double HorizonSizeCm = 5.0e6;
	constexpr double HorizonSinkCm = 100;
	// Where the build checks the surface and the layer weights: fractions of the tile along north and east, spread unevenly.
	const double CheckPoints[][2] = {{0.5, 0.5}, {0.1, 0.2}, {0.9, 0.2}, {0.15, 0.85}, {0.8, 0.9}, {0.33, 0.61}, {0.72, 0.41}, {0.05, 0.5}, {0.5, 0.95}};

	/** The sun and exposure of the target day, from the manifest. */
	struct FLighting
	{
		double GridAzimuthDeg = 0;
		double ElevationDeg = 0;
		double SunLux = 0;
		double ExposureEv100 = 0;
	};

	/** A scanned ground material for one class: four maps and how much ground one repeat covers. */
	struct FScan
	{
		double SizeCm = 0;
		int32 Width = 0, Height = 0;
		TArray64<uint8> Colour, Normal, Rough, Relief;
		FLinearColor MeanColour = FLinearColor::Black;
	};

	/** One surface class: its weightmap, indexed like the heightmap. */
	struct FLayer
	{
		FName Name;
		FString File;
		TArray64<uint8> Weights;
		ULandscapeLayerInfoObject* Info = nullptr;
		FScan Scan;
		// The class's average photo colour in linear light, from the manifest.
		FLinearColor MeanColour = FLinearColor::Gray;
		TOptional<FLinearColor> OrthoMean;
		UTexture2D* Colour = nullptr;
		UTexture2D* Normal = nullptr;
		UTexture2D* Rough = nullptr;
		UTexture2D* Relief = nullptr;
	};

	/** A Landscape vertex where the manifest says what each class weighs, worked out from the weightmaps by position. */
	struct FCheckPoint
	{
		int32 East = 0;
		int32 North = 0;
		TMap<FName, int32> Weights;
	};

	/** One Landscape to import: the detailed tile, or the coarse surround. */
	struct FSurface
	{
		FString HeightmapFile;
		FString ColourFile;
		int32 Vertices = 0;
		int32 SectionQuads = 0;
		int32 SectionsPerComponent = 0;
		FVector LocationCm = FVector::ZeroVector;
		FVector Scale = FVector::OneVector;
	};

	/** One kind of tuft, from the manifest's `turf`: its size, how many per 100 square metres, and how far out it is drawn. */
	struct FTuftVariety
	{
		FName Name;
		int32 Blades = 0;
		float RadiusCm = 0, HeightMinCm = 0, HeightMaxCm = 0, WidthMinCm = 0, WidthMaxCm = 0, DensityPer100M2 = 0, ScaleMin = 1, ScaleMax = 1;
		int32 StartCullCm = 0, EndCullCm = 0;
		// The tuft grows in from nothing to full size between these distances from the camera; both 0 for always full.
		float AppearFromCm = 0, AppearFullCm = 0;
		bool bCastsShadow = true;
	};

	struct FTurf
	{
		TArray<FTuftVariety> Varieties;
		FString GrowthFile;
		float RootShade = 1, TipShade = 1;
		// What a single blade's colour is, as multipliers of the ground's colour under it, each as likely as the next:
		// measured with the grain. One white entry when the build has no grain.
		TArray<FLinearColor> BladeColours;
	};

	/** One tree of the inventory: where it stands from the tile centre, and its measured size. */
	struct FTree
	{
		double EastM = 0, NorthM = 0, HeightM = 0, CrownRadiusM = 0, YawDeg = 0;
		// From the species' inventory records; without them the trunk and crown have no collision.
		double TrunkDiameterM = 0, CrownRatio = 0;
		FName Kind;
	};

	/** One building of the inventory: its footprint rings in metres from the tile centre, and what the pipeline measured. */
	struct FBuilding
	{
		double EastM = 0, NorthM = 0, HeightM = 0;
		FLinearColor RoofAlbedo = FLinearColor::Black;
		// Outer ring first, then holes; each point is (east, north). Triangles index the rings' points in order.
		TArray<TArray<FVector2D>> Rings;
		TArray<FIntVector> RoofTriangles;
		// Where the roof stands once placed, in centimetres, for the build's own check.
		double TopCm = 0;
	};

	/** A tree mesh the engine ships, with the size it has before scaling, read from its bounds. */
	struct FTreeMesh
	{
		FName Kind;
		USkinnedAsset* Asset = nullptr;
		double HeightCm = 0, RadiusCm = 0;
		UInstancedSkinnedMeshComponent* Instances = nullptr;
	};

	struct FManifest
	{
		FString Directory;
		// The tree inventory's file, when the build has one.
		FString TreesFile;
		// The building inventory's file, the albedo every wall has, and the roughness of walls and roofs.
		FString BuildingsFile;
		float WallAlbedo = 0.25f, RoofRoughness = 0.85f;
		// The photo's fine detail as a ratio to the macro colour: file, and how 8 bits map to a power of two.
		FString RatioFile;
		double RatioLog2Range = 1, RatioZero = 127;
		// The centimetre-scale grain of grass, measured from a survey orthophoto: file, how 8 bits map to a power of two,
		// and how much ground one repeat covers.
		FString GrainFile;
		double GrainLog2Range = 1, GrainZero = 127, GrainRepeatCm = 0, GrainSharpCm = 0, GrainNearShare = 1;
		// How each of red, green and blue goes with the grain's luminance, as a slope in logarithms: the grain's colour.
		FLinearColor GrainTint = FLinearColor(1, 1, 1);
		// The survey orthophoto's ratio at its own pixel size, one channel, where its footprint is: file, how 8 bits map to
		// a power of two, and where the file lies in the tile in metres from its south-west corner.
		FString SurveyFile;
		double SurveyLog2Range = 1, SurveyZero = 127, SurveyWestM = 0, SurveySouthM = 0, SurveyEastM = 1, SurveyNorthM = 1;
		FString OrthoMasksFile, OrthoColourFile;
		FString FallbackWeightsFile;
		double OrthoWestM = 0, OrthoSouthM = 0, OrthoEastM = 1, OrthoNorthM = 1;
		FTurf Turf;
		FSurface Tile;
		TOptional<FSurface> Surround;
		TArray<FLayer> Layers;
		TArray<FCheckPoint> CheckPoints;
		FLighting Lighting;
		// Photo colour in linear light times this is albedo; fitted to surfaces of known reflectance.
		float AlbedoScale = 0.5f;
		double TileSizeCm = 0;
		TSharedPtr<FJsonObject> Georeference;
		TSharedPtr<FJsonObject> StencilClasses;
	};

	FVector ReadVector(const TArray<TSharedPtr<FJsonValue>>& Values)
	{
		return FVector(Values[0]->AsNumber(), Values[1]->AsNumber(), Values[2]->AsNumber());
	}

	FSurface ReadSurface(const FJsonObject& Block, const FString& ColourFile)
	{
		FSurface Out;
		Out.HeightmapFile = Block.GetStringField(TEXT("heightmap"));
		Out.ColourFile = ColourFile;
		Out.Vertices = Block.GetIntegerField(TEXT("vertices"));
		Out.SectionQuads = Block.GetIntegerField(TEXT("section_quads"));
		Out.SectionsPerComponent = Block.GetIntegerField(TEXT("sections_per_component"));
		Out.LocationCm = ReadVector(Block.GetArrayField(TEXT("location_cm")));
		Out.Scale = ReadVector(Block.GetArrayField(TEXT("scale")));
		return Out;
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
		const TSharedPtr<FJsonObject>* Surface = nullptr;
		const TArray<TSharedPtr<FJsonValue>>* Layers = nullptr;
		if (!Root->TryGetObjectField(TEXT("surface"), Surface) || !(*Surface)->TryGetArrayField(TEXT("layers"), Layers) || Layers->IsEmpty())
		{
			Error = TEXT("the manifest needs surface.layers, one weightmap per surface class");
			return false;
		}
		const TArray<TSharedPtr<FJsonValue>>* Points = nullptr;
		(*Surface)->TryGetStringField(TEXT("fallback_weights"), Out.FallbackWeightsFile);
		if (!(*Surface)->TryGetArrayField(TEXT("check_points"), Points) || Points->IsEmpty())
		{
			Error = TEXT("the manifest needs surface.check_points, where each class should be found");
			return false;
		}
		for (const TSharedPtr<FJsonValue>& Value : *Points)
		{
			FCheckPoint& Point = Out.CheckPoints.AddDefaulted_GetRef();
			Point.East = Value->AsObject()->GetIntegerField(TEXT("east"));
			Point.North = Value->AsObject()->GetIntegerField(TEXT("north"));
			for (const auto& Weight : Value->AsObject()->GetObjectField(TEXT("weights"))->Values)
			{
				Point.Weights.Add(FName(*Weight.Key), int32(Weight.Value->AsNumber()));
			}
		}
		for (const TSharedPtr<FJsonValue>& Value : *Layers)
		{
			FLayer& Layer = Out.Layers.AddDefaulted_GetRef();
			Layer.Name = FName(*Value->AsObject()->GetStringField(TEXT("name")));
			Layer.File = Value->AsObject()->GetStringField(TEXT("file"));
			const TArray<TSharedPtr<FJsonValue>>* Mean = nullptr;
			if (Value->AsObject()->TryGetArrayField(TEXT("mean_linear_rgb"), Mean) && Mean->Num() == 3)
			{
				Layer.MeanColour = FLinearColor(float((*Mean)[0]->AsNumber()), float((*Mean)[1]->AsNumber()), float((*Mean)[2]->AsNumber()));
			}
			if (Layer.Name != GrassLayer && Layer.Name != PavedLayer && Layer.Name != SoilLayer)
			{
				Error = FString::Printf(TEXT("surface layer '%s' has no look in the ground material; known layers are grass, paved and soil"), *Layer.Name.ToString());
				return false;
			}
		}
		if (!Root->TryGetObjectField(TEXT("landscape"), Landscape) || !Root->TryGetObjectField(TEXT("macro_colour"), Macro) ||
			!Root->TryGetObjectField(TEXT("tile"), Tile) || !Root->TryGetObjectField(TEXT("georeference"), Geo) ||
			!Root->TryGetObjectField(TEXT("stencil_classes"), Stencil))
		{
			Error = TEXT("the manifest needs landscape, macro_colour, tile, georeference and stencil_classes");
			return false;
		}
		Out.Directory = FPaths::GetPath(Path);
		Out.Tile = ReadSurface(**Landscape, (*Macro)->GetStringField(TEXT("file")));
		const TSharedPtr<FJsonObject>* Context = nullptr;
		if (Root->TryGetObjectField(TEXT("context"), Context))
		{
			Out.Surround = ReadSurface(**Context, (*Context)->GetStringField(TEXT("colour")));
		}
		Out.TileSizeCm = (*Tile)->GetNumberField(TEXT("size_m")) * 100;
		Out.Georeference = *Geo;
		Out.StencilClasses = *Stencil;
		const TSharedPtr<FJsonObject>* Albedo = nullptr;
		const TSharedPtr<FJsonObject>* Light = nullptr;
		if (!(*Surface)->TryGetObjectField(TEXT("albedo"), Albedo) || !Root->TryGetObjectField(TEXT("lighting"), Light))
		{
			Error = TEXT("the manifest needs surface.albedo and lighting");
			return false;
		}
		const TSharedPtr<FJsonObject>* Ratio = nullptr;
		if (Root->TryGetObjectField(TEXT("detail"), Ratio))
		{
			Out.RatioFile = (*Ratio)->GetStringField(TEXT("file"));
			Out.RatioLog2Range = (*Ratio)->GetNumberField(TEXT("log2_range"));
			Out.RatioZero = (*Ratio)->GetNumberField(TEXT("zero"));
		}
		const TSharedPtr<FJsonObject>* Survey = nullptr;
		if (Root->TryGetObjectField(TEXT("survey_detail"), Survey) && (*Survey)->HasField(TEXT("file")))
		{
			Out.SurveyFile = (*Survey)->GetStringField(TEXT("file"));
			Out.SurveyLog2Range = (*Survey)->GetNumberField(TEXT("log2_range"));
			Out.SurveyZero = (*Survey)->GetNumberField(TEXT("zero"));
			Out.SurveyWestM = (*Survey)->GetNumberField(TEXT("west_m"));
			Out.SurveySouthM = (*Survey)->GetNumberField(TEXT("south_m"));
			Out.SurveyEastM = (*Survey)->GetNumberField(TEXT("east_extent_m"));
			Out.SurveyNorthM = (*Survey)->GetNumberField(TEXT("north_extent_m"));
		}
		const TSharedPtr<FJsonObject>* Grain = nullptr;
		if (Root->TryGetObjectField(TEXT("grain"), Grain) && (*Grain)->HasField(TEXT("file")))
		{
			Out.GrainFile = (*Grain)->GetStringField(TEXT("file"));
			Out.GrainLog2Range = (*Grain)->GetNumberField(TEXT("log2_range"));
			Out.GrainZero = (*Grain)->GetNumberField(TEXT("zero"));
			Out.GrainRepeatCm = (*Grain)->GetNumberField(TEXT("repeat_m")) * 100;
			Out.GrainSharpCm = (*Grain)->GetNumberField(TEXT("sharp_distance_m")) * 100;
			Out.GrainNearShare = (*Grain)->GetNumberField(TEXT("near_share"));
			const TArray<TSharedPtr<FJsonValue>>& Tint = (*Grain)->GetArrayField(TEXT("tint"));
			Out.GrainTint = FLinearColor(float(Tint[0]->AsNumber()), float(Tint[1]->AsNumber()), float(Tint[2]->AsNumber()));
			for (const TSharedPtr<FJsonValue>& Value : (*Grain)->GetArrayField(TEXT("blade_colours")))
			{
				const TArray<TSharedPtr<FJsonValue>>& Colour = Value->AsArray();
				Out.Turf.BladeColours.Add(FLinearColor(float(Colour[0]->AsNumber()), float(Colour[1]->AsNumber()), float(Colour[2]->AsNumber())));
			}
		}
		const TSharedPtr<FJsonObject>* Turf = nullptr;
		const TSharedPtr<FJsonObject>* Ortho = nullptr;
		if (Root->TryGetObjectField(TEXT("orthophoto"), Ortho) && (*Ortho)->HasField(TEXT("file")))
		{
			Out.OrthoMasksFile = (*Ortho)->GetStringField(TEXT("file"));
			Out.OrthoColourFile = (*Ortho)->GetStringField(TEXT("colour"));
			Out.OrthoWestM = (*Ortho)->GetNumberField(TEXT("west_m"));
			Out.OrthoSouthM = (*Ortho)->GetNumberField(TEXT("south_m"));
			Out.OrthoEastM = (*Ortho)->GetNumberField(TEXT("east_extent_m"));
			Out.OrthoNorthM = (*Ortho)->GetNumberField(TEXT("north_extent_m"));
			const TSharedPtr<FJsonObject>* Means = nullptr;
			if ((*Ortho)->TryGetObjectField(TEXT("mean_linear_rgb"), Means))
			{
				for (FLayer& Layer : Out.Layers)
				{
					const TArray<TSharedPtr<FJsonValue>>* Mean = nullptr;
					if ((*Means)->TryGetArrayField(Layer.Name.ToString(), Mean) && Mean->Num() == 3)
					{
						Layer.OrthoMean = FLinearColor(float((*Mean)[0]->AsNumber()), float((*Mean)[1]->AsNumber()), float((*Mean)[2]->AsNumber()));
					}
				}
			}
		}
		if (Root->TryGetObjectField(TEXT("turf"), Turf))
		{
			const TSharedPtr<FJsonObject>* Growth = nullptr;
			if ((*Turf)->TryGetObjectField(TEXT("growth"), Growth))
			{
				Out.Turf.GrowthFile = (*Growth)->GetStringField(TEXT("file"));
			}
			Out.Turf.RootShade = float((*Turf)->GetNumberField(TEXT("root_shade")));
			Out.Turf.TipShade = float((*Turf)->GetNumberField(TEXT("tip_shade")));
			for (const TSharedPtr<FJsonValue>& Value : (*Turf)->GetArrayField(TEXT("varieties")))
			{
				const TSharedPtr<FJsonObject> Item = Value->AsObject();
				FTuftVariety& Variety = Out.Turf.Varieties.AddDefaulted_GetRef();
				Variety.Name = FName(*Item->GetStringField(TEXT("name")));
				Variety.Blades = Item->GetIntegerField(TEXT("blades"));
				Variety.RadiusCm = float(Item->GetNumberField(TEXT("radius_cm")));
				Variety.HeightMinCm = float(Item->GetArrayField(TEXT("height_cm"))[0]->AsNumber());
				Variety.HeightMaxCm = float(Item->GetArrayField(TEXT("height_cm"))[1]->AsNumber());
				Variety.WidthMinCm = float(Item->GetArrayField(TEXT("blade_width_cm"))[0]->AsNumber());
				Variety.WidthMaxCm = float(Item->GetArrayField(TEXT("blade_width_cm"))[1]->AsNumber());
				Variety.DensityPer100M2 = float(Item->GetNumberField(TEXT("density_per_100m2")));
				Variety.ScaleMin = float(Item->GetArrayField(TEXT("scale"))[0]->AsNumber());
				Variety.ScaleMax = float(Item->GetArrayField(TEXT("scale"))[1]->AsNumber());
				Variety.AppearFromCm = float(Item->GetArrayField(TEXT("appear_cm"))[0]->AsNumber());
				Variety.AppearFullCm = float(Item->GetArrayField(TEXT("appear_cm"))[1]->AsNumber());
				Variety.StartCullCm = Item->GetIntegerField(TEXT("start_cull_cm"));
				Variety.EndCullCm = Item->GetIntegerField(TEXT("end_cull_cm"));
				Variety.bCastsShadow = Item->GetBoolField(TEXT("casts_shadow"));
			}
		}
		const TSharedPtr<FJsonObject>* Trees = nullptr;
		if (Root->TryGetObjectField(TEXT("trees"), Trees))
		{
			Out.TreesFile = (*Trees)->GetStringField(TEXT("file"));
		}
		const TSharedPtr<FJsonObject>* Buildings = nullptr;
		if (Root->TryGetObjectField(TEXT("buildings"), Buildings))
		{
			Out.BuildingsFile = (*Buildings)->GetStringField(TEXT("file"));
			Out.WallAlbedo = float((*Buildings)->GetNumberField(TEXT("wall_albedo")));
			Out.RoofRoughness = float((*Buildings)->GetNumberField(TEXT("roof_roughness")));
		}
		Out.AlbedoScale = float((*Albedo)->GetNumberField(TEXT("scale")));
		Out.Lighting.GridAzimuthDeg = (*Light)->GetNumberField(TEXT("grid_azimuth_deg"));
		Out.Lighting.ElevationDeg = (*Light)->GetNumberField(TEXT("elevation_deg"));
		Out.Lighting.SunLux = (*Light)->GetNumberField(TEXT("sun_lux"));
		Out.Lighting.ExposureEv100 = (*Light)->GetNumberField(TEXT("exposure_ev100"));
		return true;
	}

	bool DecodePng(const FString& Path, ERGBFormat Format, int32 BitDepth, TArray64<uint8>& Raw, int32& Width, int32& Height, EImageFormat Container = EImageFormat::PNG)
	{
		TArray64<uint8> Compressed;
		if (!FFileHelper::LoadFileToArray(Compressed, *Path))
		{
			return false;
		}
		IImageWrapperModule& Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
		const TSharedPtr<IImageWrapper> Wrapper = Module.CreateImageWrapper(Container);
		if (!Wrapper || !Wrapper->SetCompressed(Compressed.GetData(), Compressed.Num()) || !Wrapper->GetRaw(Format, BitDepth, Raw))
		{
			return false;
		}
		Width = Wrapper->GetWidth();
		Height = Wrapper->GetHeight();
		return true;
	}

	/**
	 * Read each class's scanned material from the directory fetch-materials.ps1 filled: four JPEG maps, and the
	 * size of ground one repeat covers from materials.json. The normal map is OpenGL style and the engine reads
	 * DirectX style, so its green channel is flipped. Also measures the scan's mean colour in linear light, which
	 * the material divides out so the scan adds structure and never shifts the colour the evidence set.
	 */
	bool LoadScans(const FString& Directory, TArray<FLayer>& Layers, FString& Error)
	{
		FString Text;
		TSharedPtr<FJsonObject> Root;
		if (Directory.IsEmpty() || !FFileHelper::LoadFileToString(Text, *(Directory / TEXT("materials.json"))) || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root)
		{
			Error = TEXT("pass -EnvGenMaterials=<directory filled by fetch-materials.ps1>");
			return false;
		}
		const TSharedPtr<FJsonObject>* Classes = nullptr;
		if (!Root->TryGetObjectField(TEXT("classes"), Classes))
		{
			Error = TEXT("materials.json has no classes");
			return false;
		}
		for (FLayer& Layer : Layers)
		{
			const TSharedPtr<FJsonObject>* Entry = nullptr;
			if (!(*Classes)->TryGetObjectField(Layer.Name.ToString(), Entry))
			{
				Error = FString::Printf(TEXT("materials.json has no scan for class '%s'"), *Layer.Name.ToString());
				return false;
			}
			FScan& Scan = Layer.Scan;
			Scan.SizeCm = (*Entry)->GetNumberField(TEXT("size_cm"));
			int32 W = 0, H = 0, W2 = 0, H2 = 0, W3 = 0, H3 = 0, W4 = 0, H4 = 0;
			const FString Stem = Directory / Layer.Name.ToString() + TEXT("_");
			if (!DecodePng(Stem + TEXT("base_colour.jpg"), ERGBFormat::BGRA, 8, Scan.Colour, W, H, EImageFormat::JPEG) ||
				!DecodePng(Stem + TEXT("normal.jpg"), ERGBFormat::BGRA, 8, Scan.Normal, W2, H2, EImageFormat::JPEG) ||
				!DecodePng(Stem + TEXT("roughness.jpg"), ERGBFormat::Gray, 8, Scan.Rough, W3, H3, EImageFormat::JPEG) ||
				!DecodePng(Stem + TEXT("height.jpg"), ERGBFormat::Gray, 8, Scan.Relief, W4, H4, EImageFormat::JPEG))
			{
				Error = FString::Printf(TEXT("cannot decode the scan maps for '%s' in %s"), *Layer.Name.ToString(), *Directory);
				return false;
			}
			if (W != W2 || H != H2 || W != W3 || H != H3 || W != W4 || H != H4)
			{
				Error = FString::Printf(TEXT("the maps of '%s' differ in size"), *Layer.Name.ToString());
				return false;
			}
			Scan.Width = W;
			Scan.Height = H;
			FVector Sum = FVector::ZeroVector;
			const int64 Pixels = int64(W) * H;
			for (int64 Pixel = 0; Pixel < Pixels; ++Pixel)
			{
				Sum += FVector(FLinearColor(FColor(Scan.Colour[Pixel * 4 + 2], Scan.Colour[Pixel * 4 + 1], Scan.Colour[Pixel * 4])));
				Scan.Normal[Pixel * 4 + 1] = 255 - Scan.Normal[Pixel * 4 + 1];
			}
			Sum /= double(Pixels);
			Scan.MeanColour = FLinearColor(float(Sum.X), float(Sum.Y), float(Sum.Z));
		}
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

	UTexture2D* MakeTexture(const FString& Name, int32 Width, int32 Height, ETextureSourceFormat Format, const uint8* Pixels, bool bSrgb, TArray<UPackage*>& Packages,
		TextureCompressionSettings Compression = TC_MAX, bool bVirtual = false)
	{
		UTexture2D* Texture = NewAsset<UTexture2D>(Name, Packages);
		Texture->Source.Init(Width, Height, 1, 1, Format, Pixels);
		Texture->SRGB = bSrgb;
		Texture->CompressionSettings = Compression != TC_MAX ? Compression : (Format == TSF_G8 ? TC_Grayscale : TC_Default);
		Texture->LODGroup = TEXTUREGROUP_World;
		Texture->VirtualTextureStreaming = bVirtual;
		if (bVirtual)
		{
			Texture->PowerOfTwoMode = ETexturePowerOfTwoSetting::PadToPowerOfTwo;
			Texture->AddressX = TA_Clamp;
			Texture->AddressY = TA_Clamp;
		}
		Texture->PostEditChange();
		if (bVirtual)
		{
			UE_LOG(LogEnvGen, Display, TEXT("%s: virtual=%d, source=%dx%d, padding=%d"), *Name, Texture->VirtualTextureStreaming, Width, Height, int32(Texture->PowerOfTwoMode));
		}
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

	UMaterialExpression* PaddedUv(UMaterial* Material, UMaterialExpression* Uv, UTexture2D* Texture, int32 Y)
	{
		if (Texture->PowerOfTwoMode != ETexturePowerOfTwoSetting::PadToPowerOfTwo)
		{
			return Uv;
		}
		UMaterialExpressionCustom* Scaled = Node<UMaterialExpressionCustom>(Material, -850, Y);
		Scaled->OutputType = CMOT_Float2;
		Scaled->Inputs.Empty();
		FCustomInput& Input = Scaled->Inputs.AddDefaulted_GetRef();
		Input.InputName = TEXT("UV");
		Input.Input.Connect(0, Uv);
		const uint32 Width = uint32(Texture->Source.GetSizeX()), Height = uint32(Texture->Source.GetSizeY());
		Scaled->Code = FString::Printf(TEXT("return UV * float2(%.9f,%.9f);"),
			double(Width) / FMath::RoundUpToPowerOfTwo(Width), double(Height) / FMath::RoundUpToPowerOfTwo(Height));
		return Scaled;
	}

	UMaterialExpressionTextureSample* Sample(UMaterial* Material, UTexture2D* Texture, float QuadsPerRepeat, EMaterialSamplerType Sampler, int32 Y, float TurnDegrees = 0)
	{
		// LandscapeLayerCoords divides the vertex index by MappingScale, so one repeat spans MappingScale quads.
		UMaterialExpressionLandscapeLayerCoords* Coords = Node<UMaterialExpressionLandscapeLayerCoords>(Material, -1100, Y);
		Coords->MappingScale = QuadsPerRepeat;
		Coords->MappingRotation = TurnDegrees;
		UMaterialExpressionTextureSample* Out = Node<UMaterialExpressionTextureSample>(Material, -800, Y);
		Out->Texture = Texture;
		Out->SamplerType = Sampler;
		// One sampler for every texture: a material may bind only 16, and this one has several per class.
		Out->SamplerSource = SSM_Wrap_WorldGroupSettings;
		Out->Coordinates.Connect(0, Coords);
		return Out;
	}

	UMaterialExpression* BombColour(UMaterial* Material, UTexture2D* Texture, float Repeat, UMaterialExpression* Position, UMaterialExpression* Eye, int32 Y)
	{
		UMaterialExpressionLandscapeLayerCoords* Uv = Node<UMaterialExpressionLandscapeLayerCoords>(Material, -1400, Y);
		Uv->MappingScale = Repeat;
		UMaterialExpressionTextureObject* Scan = Node<UMaterialExpressionTextureObject>(Material, -1400, Y + 100);
		Scan->Texture = Texture;
		UMaterialExpressionCustom* Bomb = Node<UMaterialExpressionCustom>(Material, -1000, Y);
		Bomb->OutputType = CMOT_Float3;
		Bomb->Inputs.Empty();
		FCustomInput& Coordinates = Bomb->Inputs.AddDefaulted_GetRef();
		Coordinates.InputName = TEXT("UV");
		Coordinates.Input.Connect(0, Uv);
		FCustomInput& Image = Bomb->Inputs.AddDefaulted_GetRef();
		Image.InputName = TEXT("Scan");
		Image.Input.Connect(0, Scan);
		FCustomInput& Here = Bomb->Inputs.AddDefaulted_GetRef();
		Here.InputName = TEXT("Here");
		Here.Input.Connect(0, Position);
		FCustomInput& Camera = Bomb->Inputs.AddDefaulted_GetRef();
		Camera.InputName = TEXT("Eye");
		Camera.Input.Connect(0, Eye);
		// Close colour stays registered with the scan normal and relief. Offset cells hide distant repeats.
		Bomb->Code = TEXT(R"(
float2 dx=ddx(UV), dy=ddy(UV);
float blend=smoothstep(1500,3000,distance(Here,Eye));
[branch] if(blend<=0) return Texture2DSampleGrad(Scan,ScanSampler,UV,dx,dy).rgb;
float2 skew = float2(UV.x + UV.y*0.57735027, UV.y*1.15470054);
float2 cell = floor(skew), f = frac(skew);
float2 a, b, c; float3 w;
if(f.x+f.y < 1) { a=cell; b=cell+float2(1,0); c=cell+float2(0,1); w=float3(1-f.x-f.y,f.x,f.y); }
else { a=cell+1; b=cell+float2(0,1); c=cell+float2(1,0); w=float3(f.x+f.y-1,1-f.x,1-f.y); }
float2 ha=frac(sin(float2(dot(a,float2(127.1,311.7)),dot(a,float2(269.5,183.3))))*43758.5453);
float2 hb=frac(sin(float2(dot(b,float2(127.1,311.7)),dot(b,float2(269.5,183.3))))*43758.5453);
float2 hc=frac(sin(float2(dot(c,float2(127.1,311.7)),dot(c,float2(269.5,183.3))))*43758.5453);
w *= w; w *= w; w /= max(dot(w,1),0.00001);
float3 varied=Texture2DSampleGrad(Scan,ScanSampler,UV+ha,dx,dy).rgb*w.x
     + Texture2DSampleGrad(Scan,ScanSampler,UV+hb,dx,dy).rgb*w.y
     + Texture2DSampleGrad(Scan,ScanSampler,UV+hc,dx,dy).rgb*w.z;
[branch] if(blend>=1) return varied;
return lerp(Texture2DSampleGrad(Scan,ScanSampler,UV,dx,dy).rgb,varied,blend);
)");
		return Bomb;
	}

	/** The compile errors of a material, logged; the level build fails on any, because a material that does not compile draws nothing. */
	int32 CompileErrors(UMaterial* Material)
	{
		int32 Count = 0;
		if (const FMaterialResource* Resource = Material->GetMaterialResource(GMaxRHIShaderPlatform))
		{
			for (const FString& Error : Resource->GetCompileErrors())
			{
				UE_LOG(LogEnvGen, Error, TEXT("%s does not compile: %s"), *Material->GetName(), *Error);
				++Count;
			}
		}
		return Count;
	}

	/** A tuft of tapered, leaning blades, base at the origin, as geometry so it casts and takes light like turf. */
	UStaticMesh* MakeGrassTuft(UMaterial* Material, const FTuftVariety& Variety, const TArray<FLinearColor>& BladeColours, int32 Index, TArray<UPackage*>& Packages)
	{
		UStaticMesh* Mesh = NewAsset<UStaticMesh>(TEXT("SM_GrassTuft_") + Variety.Name.ToString(), Packages);
		FMeshDescription Description;
		FStaticMeshAttributes Attributes(Description);
		Attributes.Register();
		TVertexAttributesRef<FVector3f> Positions = Attributes.GetVertexPositions();
		TVertexInstanceAttributesRef<FVector3f> Normals = Attributes.GetVertexInstanceNormals();
		TVertexInstanceAttributesRef<FVector2f> Uvs = Attributes.GetVertexInstanceUVs();
		TVertexInstanceAttributesRef<FVector4f> Colours = Attributes.GetVertexInstanceColors();
		TPolygonGroupAttributesRef<FName> Slots = Attributes.GetPolygonGroupMaterialSlotNames();
		const FPolygonGroupID Group = Description.CreatePolygonGroup();
		Slots[Group] = FName(TEXT("Blade"));
		// The blade's own colour rides in the third and fourth UV channels (red and green, then blue): vertex colour is
		// 8 bits and holds how far up the blade a point is, and the mesh build writes its own unwrap into the second.
		Uvs.SetNumChannels(4);
		FRandomStream Random(7 + Index);
		constexpr int32 Segments = 3;
		if (Variety.Name == FName(TEXT("broadleaf")))
		{
			for (int32 Leaf = 0; Leaf < 3; ++Leaf)
			{
				const float Angle = Leaf * 2 * PI / 3;
				const FVector2f Direction(FMath::Cos(Angle), FMath::Sin(Angle));
				const FVector2f Across(-Direction.Y, Direction.X);
				const float Length = Variety.WidthMaxCm;
				const FVector2f Centre = Direction * Length;
				const auto Vertex = [&](const FVector2f& Point, float Height, float Shade)
				{
					const FVertexID Id = Description.CreateVertex();
					Positions[Id] = FVector3f(Point.X, Point.Y, Height);
					const FVertexInstanceID Instance = Description.CreateVertexInstance(Id);
					Normals[Instance] = FVector3f(0, 0, 1);
					Uvs.Set(Instance, 0, Point / (Length * 4) + FVector2f(0.5f));
					Uvs.Set(Instance, 1, FVector2f(0, 0));
					Uvs.Set(Instance, 2, FVector2f(0.85f, 1.05f));
					Uvs.Set(Instance, 3, FVector2f(0.8f, 0));
					Colours[Instance] = FVector4f(Shade, Shade, Shade, 1);
					return Instance;
				};
				const FVertexInstanceID Middle = Vertex(Centre, Variety.HeightMaxCm, 1);
				Description.CreatePolygon(Group, {Middle, Vertex(FVector2f(0, 0), 0, 0), Vertex(Centre + Across * 0.1f, Variety.HeightMaxCm, 0.8f)});
				for (int32 Edge = 0; Edge < 8; ++Edge)
				{
					const auto Rim = [&](int32 Step)
					{
						const float Around = Step * 2 * PI / 8;
						return Vertex(Centre + Direction * (Length * FMath::Cos(Around)) + Across * (Length * 0.65f * FMath::Sin(Around)), Variety.HeightMinCm, 0.5f);
					};
					Description.CreatePolygon(Group, {Middle, Rim(Edge), Rim(Edge + 1)});
				}
			}
		}
		for (int32 Blade = 0; Blade < Variety.Blades; ++Blade)
		{
			if (Variety.Name == FName(TEXT("broadleaf")))
			{
				break;
			}
			const float Around = Random.FRand() * 2 * PI;
			const FVector2f Root = FVector2f(FMath::Cos(Around), FMath::Sin(Around)) * Random.FRand() * Variety.RadiusCm;
			const float Facing = Random.FRand() * 2 * PI;
			const FVector2f Along(FMath::Cos(Facing), FMath::Sin(Facing)), Across(-Along.Y, Along.X);
			const float Height = Random.FRandRange(Variety.HeightMinCm, Variety.HeightMaxCm);
			const float Width = Random.FRandRange(Variety.WidthMinCm, Variety.WidthMaxCm) / 2;
			// Dealt in turn, so a tuft holds the colours in the equal shares they were measured in.
			FLinearColor Own = BladeColours.IsEmpty() ? FLinearColor::White : BladeColours[Blade % BladeColours.Num()];
			if (Blade % 13 == 0)
			{
				Own *= FLinearColor(1.10f, 0.94f, 0.72f);
			}
			const float Lean = Random.FRandRange(0.15f, 1.35f) * Height;
			const float Arch = Random.FRandRange(0.f, 0.55f);
			const float BladeSeed = Random.FRand();
			const float PeakT = Arch > 1.f / PI ? FMath::Acos(-1.f / (PI * Arch)) / PI : 1.f;
			const float Peak = PeakT + Arch * FMath::Sin(PI * PeakT);
			// Left and right edge vertices per level, and one at the tip.
			TArray<FVertexInstanceID> Left, Right;
			FVertexInstanceID Tip;
			const auto Add = [&](float T, float Side)
			{
				const FVector2f Plan = Root + Along * (Lean * T * T) + Across * (Side * Width * (1.f - T));
				const FVertexID Vertex = Description.CreateVertex();
				Positions[Vertex] = FVector3f(Plan.X, Plan.Y, Height * (T + Arch * FMath::Sin(PI * T)) / Peak);
				const FVertexInstanceID Instance = Description.CreateVertexInstance(Vertex);
				Normals[Instance] = FVector3f(Along.X * 0.6f + Across.X * Side * 0.4f,
					Along.Y * 0.6f + Across.Y * Side * 0.4f, 1.f).GetSafeNormal();
				Uvs.Set(Instance, 0, FVector2f(Side * 0.5f + 0.5f, T));
				Uvs.Set(Instance, 1, FVector2f(0.f, 0.f));
				Uvs.Set(Instance, 2, FVector2f(Own.R, Own.G));
				Uvs.Set(Instance, 3, FVector2f(Own.B, BladeSeed));
				Colours[Instance] = FVector4f(T, T, T, 1.f);
				return Instance;
			};
			for (int32 Level = 0; Level < Segments; ++Level)
			{
				Left.Add(Add(float(Level) / Segments, -1.f));
				Right.Add(Add(float(Level) / Segments, 1.f));
			}
			Tip = Add(1.f, 0.f);
			for (int32 Level = 0; Level < Segments - 1; ++Level)
			{
				Description.CreatePolygon(Group, {Left[Level], Right[Level], Right[Level + 1]});
				Description.CreatePolygon(Group, {Left[Level], Right[Level + 1], Left[Level + 1]});
			}
			Description.CreatePolygon(Group, {Left[Segments - 1], Right[Segments - 1], Tip});
		}
		Mesh->GetStaticMaterials().Add(FStaticMaterial(Material, FName(TEXT("Blade"))));
		UStaticMesh::FBuildMeshDescriptionsParams Params;
		Params.bBuildSimpleCollision = false;
		// A full build, not a fast one: on 5.8.4 the engine builds a fast-built tuft's instances and draws none of
		// them in a level without Nanite foliage (gates/grass-drawn.ps1). What the fast build leaves out is not known.
		Params.bFastBuild = false;
		Mesh->BuildFromMeshDescriptions({&Description}, Params);
		return Mesh;
	}

	/**
	 * The blade's material: the grass class's own colour (its mean photo colour times the albedo scale), darker at the
	 * root and lighter at the tip, and a little different from tuft to tuft.
	 */
	UMaterial* MakeBladeMaterial(UTexture2D* Macro, UTexture2D* Growth, const FManifest& Manifest, const FTuftVariety& Variety, TArray<UPackage*>& Packages)
	{
		UMaterial* Material = NewAsset<UMaterial>(TEXT("M_GrassBlade_") + Variety.Name.ToString(), Packages);
		Material->TwoSided = true;
		Material->bUsedWithInstancedStaticMeshes = true;
		// The ground's own colour under the blade: the macro map read at the blade's place, as the ground reads it. Along
		// the landscape's axes (north, east) one tile is one repeat, from its south-west corner.
		UMaterialExpressionWorldPosition* Place = Node<UMaterialExpressionWorldPosition>(Material, -1100, -100);
		Place->WorldPositionShaderOffset = WPT_ExcludeAllShaderOffsets;
		UMaterialExpressionComponentMask* Plan = Node<UMaterialExpressionComponentMask>(Material, -950, -100);
		Plan->Input.Connect(0, Place);
		Plan->R = true;
		Plan->G = true;
		Plan->B = false;
		Plan->A = false;
		UMaterialExpressionAdd* FromCorner = Node<UMaterialExpressionAdd>(Material, -800, -100);
		FromCorner->A.Connect(0, Plan);
		FromCorner->ConstB = float(Manifest.TileSizeCm / 2);
		UMaterialExpressionMultiply* Coords = Node<UMaterialExpressionMultiply>(Material, -650, -100);
		Coords->A.Connect(0, FromCorner);
		Coords->ConstB = float(1.0 / Manifest.TileSizeCm);
		UMaterialExpressionTextureSample* Ground = Node<UMaterialExpressionTextureSample>(Material, -500, -100);
		Ground->Texture = Macro;
		Ground->SamplerType = SAMPLERTYPE_Color;
		Ground->SamplerSource = SSM_Wrap_WorldGroupSettings;
		Ground->Coordinates.Connect(0, Coords);
		UMaterialExpressionMultiply* Albedo = Node<UMaterialExpressionMultiply>(Material, -350, -100);
		Albedo->A.Connect(0, Ground);
		Albedo->ConstB = Manifest.AlbedoScale;

		// The mesh's vertex colour is how far up the blade the point is: 0 at the root, 1 at the tip.
		UMaterialExpressionVertexColor* Along = Node<UMaterialExpressionVertexColor>(Material, -800, 400);
		UMaterialExpressionLinearInterpolate* Shade = Node<UMaterialExpressionLinearInterpolate>(Material, -650, 400);
		Shade->ConstA = Manifest.Turf.RootShade;
		Shade->ConstB = Manifest.Turf.TipShade;
		Shade->Alpha.Connect(1, Along);
		UMaterialExpressionPerInstanceRandom* Random = Node<UMaterialExpressionPerInstanceRandom>(Material, -800, 550);
		UMaterialExpressionLinearInterpolate* Tuft = Node<UMaterialExpressionLinearInterpolate>(Material, -650, 550);
		Tuft->ConstA = 0.85f;
		Tuft->ConstB = 1.15f;
		Tuft->Alpha.Connect(0, Random);
		UMaterialExpressionMultiply* Lit = Node<UMaterialExpressionMultiply>(Material, -350, 100);
		Lit->A.Connect(0, Albedo);
		Lit->B.Connect(0, Shade);
		UMaterialExpressionMultiply* OfTuft = Node<UMaterialExpressionMultiply>(Material, -200, 100);
		OfTuft->A.Connect(0, Lit);
		OfTuft->B.Connect(0, Tuft);
		// The blade's own colour, from the mesh: red and green in the third UV channel, blue and a stable blade seed in the fourth.
		UMaterialExpressionTextureCoordinate* RedGreen = Node<UMaterialExpressionTextureCoordinate>(Material, -500, 650);
		RedGreen->CoordinateIndex = 2;
		UMaterialExpressionTextureCoordinate* BlueUv = Node<UMaterialExpressionTextureCoordinate>(Material, -500, 750);
		BlueUv->CoordinateIndex = 3;
		UMaterialExpressionComponentMask* Blue = Node<UMaterialExpressionComponentMask>(Material, -350, 750);
		Blue->Input.Connect(0, BlueUv);
		Blue->R = true;
		Blue->G = false;
		Blue->B = false;
		Blue->A = false;
		UMaterialExpressionAppendVector* Own = Node<UMaterialExpressionAppendVector>(Material, -200, 700);
		Own->A.Connect(0, RedGreen);
		Own->B.Connect(0, Blue);
		UMaterialExpressionMultiply* Colour = Node<UMaterialExpressionMultiply>(Material, -50, 100);
		Colour->A.Connect(0, OfTuft);
		Colour->B.Connect(0, Own);
		// Thin blades pass light: lit from behind they glow with their own colour rather than going black.
		Material->SetShadingModel(MSM_TwoSidedFoliage);
		UMaterialEditingLibrary::ConnectMaterialProperty(Colour, TEXT(""), MP_BaseColor);
		UMaterialExpressionMultiply* Transmitted = Node<UMaterialExpressionMultiply>(Material, 100, 150);
		Transmitted->A.Connect(0, Colour);
		Transmitted->ConstB = 0.45f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Transmitted, TEXT(""), MP_SubsurfaceColor);
		UMaterialExpressionLinearInterpolate* Occlusion = Node<UMaterialExpressionLinearInterpolate>(Material, 100, 250);
		Occlusion->ConstA = 0.55f;
		Occlusion->ConstB = 1.f;
		Occlusion->Alpha.Connect(1, Along);
		UMaterialEditingLibrary::ConnectMaterialProperty(Occlusion, TEXT(""), MP_AmbientOcclusion);
		UMaterialExpressionConstant* Specular = Node<UMaterialExpressionConstant>(Material, 100, 350);
		Specular->R = 0.25f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Specular, TEXT(""), MP_Specular);
		Material->bTangentSpaceNormal = false;
		UMaterialExpressionVertexNormalWS* BladeNormal = Node<UMaterialExpressionVertexNormalWS>(Material, -500, 200);
		UMaterialExpressionCustom* RoundedNormal = Node<UMaterialExpressionCustom>(Material, -200, 200);
		RoundedNormal->OutputType = CMOT_Float3;
		RoundedNormal->Inputs.Empty();
		FCustomInput& VertexNormal = RoundedNormal->Inputs.AddDefaulted_GetRef();
		VertexNormal.InputName = TEXT("N");
		VertexNormal.Input.Connect(0, BladeNormal);
		RoundedNormal->Code = TEXT("float3 n=normalize(N); n.z=abs(n.z); return normalize(lerp(float3(0,0,1),n,0.45));");
		UMaterialEditingLibrary::ConnectMaterialProperty(RoundedNormal, TEXT(""), MP_Normal);
		UMaterialExpressionConstant* Roughness = Node<UMaterialExpressionConstant>(Material, -200, 300);
		Roughness->R = 0.6f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Roughness, TEXT(""), MP_Roughness);
		if (Growth)
		{
			UMaterialExpressionWorldPosition* Here = Node<UMaterialExpressionWorldPosition>(Material, -1100, 900);
			Here->WorldPositionShaderOffset = WPT_ExcludeAllShaderOffsets;
			UMaterialExpressionCameraPositionWS* Eye = Node<UMaterialExpressionCameraPositionWS>(Material, -1100, 1000);
			UMaterialExpressionConstant3Vector* Origin = Node<UMaterialExpressionConstant3Vector>(Material, -1100, 1150);
			Origin->Constant = FLinearColor(0, 0, 0);
			UMaterialExpressionTransformPosition* Root = Node<UMaterialExpressionTransformPosition>(Material, -900, 1150);
			Root->Input.Connect(0, Origin);
			Root->TransformSourceType = TRANSFORMPOSSOURCE_Local;
			Root->TransformType = TRANSFORMPOSSOURCE_World;
			UMaterialExpressionTextureSample* GrowthAt = Node<UMaterialExpressionTextureSample>(Material, -900, 1300);
			GrowthAt->Texture = Growth;
			GrowthAt->SamplerType = SAMPLERTYPE_LinearColor;
			GrowthAt->Coordinates.Connect(0, Coords);
			GrowthAt->MipValueMode = TMVM_MipLevel;
			GrowthAt->ConstMipValue = 0;
			UMaterialExpressionCustom* Offset = Node<UMaterialExpressionCustom>(Material, -200, 1050);
			Offset->OutputType = CMOT_Float3;
			const auto Input = [&](const TCHAR* Name, UMaterialExpression* Expression)
			{
				FCustomInput& In = Offset->Inputs.AddDefaulted_GetRef();
				In.InputName = Name;
				In.Input.Connect(0, Expression);
			};
			Offset->Inputs.Empty();
			Input(TEXT("Here"), Here);
			Input(TEXT("Root"), Root);
			Input(TEXT("Eye"), Eye);
			Input(TEXT("Growth"), GrowthAt);
			Input(TEXT("Along"), Along);
			Input(TEXT("Random"), Random);
			Input(TEXT("Seed"), BlueUv);
			Input(TEXT("Time"), Node<UMaterialExpressionTime>(Material, -1100, 1500));
			const FString Fade = Variety.AppearFullCm > Variety.AppearFromCm
				? FString::Printf(TEXT("saturate((distance(Here, Eye) - %.3f) / %.3f)"), Variety.AppearFromCm, Variety.AppearFullCm - Variety.AppearFromCm)
				: TEXT("1.0");
			const FString StatureSpread = Variety.Name == FName(TEXT("broadleaf"))
				? TEXT("lerp(0.75,1.25,Random)")
				: TEXT("lerp(0.55,1.55,frac(Seed.g+Random*1.61803399))");
			Offset->Code = TEXT("float fade = ") + Fade + TEXT("; float spread = ") + StatureSpread + TEXT(R"(;
float2 p = Root.xy;
float relief = 0.65*sin(p.x*0.027+p.y*0.013)*sin(p.y*0.039-p.x*0.011);
float reach=distance(Root,Eye), sway=0;
[branch] if(reach < 2200) {
  float gust=0.55+0.25*sin(dot(p,float2(0.0008,0.0013))-Time*0.71)+0.2*sin(dot(p,float2(0.0031,-0.0017))+Time*1.13);
  sway=sin(dot(p,float2(0.012,0.009))-Time*2.3)*gust*(1-smoothstep(1200,2200,reach));
}
float tip = Along.r*Along.r;
float2 lean=2.0*(0.5+Random)*float2(sin(dot(p,float2(0.003,0.005))),cos(dot(p,float2(-0.004,0.002))));
float stature=clamp(Growth.b*2*spread,0.45,1.8);
return ((float3((float2(1.6,0.65)*sway+lean)*tip,0) + float3(0,0,(Here.z-Root.z)*(stature-1)+relief))*fade + (Root-Here)*(1-fade))*(1-smoothstep(2200,2500,reach));
)");
			UMaterialEditingLibrary::ConnectMaterialProperty(Offset, TEXT(""), MP_WorldPositionOffset);
		}

		UMaterialEditingLibrary::RecompileMaterial(Material);
		return Material;
	}

	/**
	 * The ground: per class a scanned material, blended where classes meet. Evidence sets the colour that varies
	 * over tens of metres (the macro colour map times the fitted albedo scale) and, when the build has one, what the
	 * photo shows finer than that (the ratio map: rows, tracks, markings, patches). The scan adds everything finer
	 * still: its colour divided by its own mean, so it never shifts the colour. Close scan maps use the same
	 * physical coordinates; distant colour mixes scales or offsets to hide repeats. The class weights are cut to a sharp
	 * edge where they cross one half, so an edge is as crisp as the photo's rather than as wide as a weightmap texel.
	 */
	UMaterial* MakeGroundMaterial(UTexture2D* Macro, UTexture2D* Ratio, UTexture2D* Survey, UTexture2D* OrthoMasks, UTexture2D* OrthoColour, UTexture2D* FallbackWeights, UTexture2D* Grain, const FManifest& Manifest, UTexture2D* Detail, UTexture2D* Growth, int32 Quads, double QuadCm, float AlbedoScale,
		const TArray<FLayer>& Layers, const TArray<ULandscapeGrassType*>& GrassTypes, TArray<UPackage*>& Packages)
	{
		UMaterial* Material = NewAsset<UMaterial>(TEXT("M_Ground"), Packages);
		UMaterialExpressionWorldPosition* GroundPosition = Node<UMaterialExpressionWorldPosition>(Material, -1500, 300);
		GroundPosition->WorldPositionShaderOffset = WPT_ExcludeAllShaderOffsets;
		UMaterialExpressionCameraPositionWS* GroundEye = Node<UMaterialExpressionCameraPositionWS>(Material, -1500, 400);
		UMaterialExpressionMultiply* MacroAlbedo = Node<UMaterialExpressionMultiply>(Material, -700, 0);
		MacroAlbedo->A.Connect(0, Sample(Material, Macro, Quads, SAMPLERTYPE_Color, 0));
		MacroAlbedo->ConstB = AlbedoScale;
		UMaterialExpression* Base = MacroAlbedo;
		// 1 inside the survey's footprint box, 0 outside: the survey's ratio replaces the imagery's there, and the grain,
		// which is the survey's own fine texture at another place, is not laid over it.
		UMaterialExpression* InSurvey = nullptr;
		if (Ratio)
		{
			// Encoded 8-bit value v in 0..1 is a power of two: 2 ^ (range * (255 v - zero) / zero).
			UMaterialExpressionMultiply* Scaled = Node<UMaterialExpressionMultiply>(Material, -1000, -300);
			Scaled->A.Connect(0, Sample(Material, Ratio, Quads, SAMPLERTYPE_LinearColor, -300));
			Scaled->ConstB = float(Manifest.RatioLog2Range * 255.0 / Manifest.RatioZero);
			UMaterialExpressionAdd* Exponent = Node<UMaterialExpressionAdd>(Material, -900, -300);
			Exponent->A.Connect(0, Scaled);
			Exponent->ConstB = float(-Manifest.RatioLog2Range);
			UMaterialExpressionConstant* Two = Node<UMaterialExpressionConstant>(Material, -900, -400);
			Two->R = 2.f;
			UMaterialExpressionPower* Fine = Node<UMaterialExpressionPower>(Material, -800, -300);
			Fine->Base.Connect(0, Two);
			Fine->Exponent.Connect(0, Exponent);
			UMaterialExpression* FineUsed = Fine;
			if (Survey)
			{
				// The file's place in the tile: u runs north and v east, as the landscape's own coordinates do.
				UMaterialExpressionLandscapeLayerCoords* TileUv = Node<UMaterialExpressionLandscapeLayerCoords>(Material, -1300, -1200);
				TileUv->MappingScale = float(Quads);
				const auto Axis = [&](bool bNorth, int32 Y)
				{
					UMaterialExpressionComponentMask* One = Node<UMaterialExpressionComponentMask>(Material, -1200, Y);
					One->Input.Connect(0, TileUv);
					One->R = bNorth;
					One->G = !bNorth;
					One->B = false;
					One->A = false;
					const double TileM = Manifest.TileSizeCm / 100;
					const double Extent = bNorth ? Manifest.SurveyNorthM : Manifest.SurveyEastM;
					const double Start = bNorth ? Manifest.SurveySouthM : Manifest.SurveyWestM;
					UMaterialExpressionMultiply* Metres = Node<UMaterialExpressionMultiply>(Material, -1100, Y);
					Metres->A.Connect(0, One);
					Metres->ConstB = float(TileM / Extent);
					UMaterialExpressionAdd* Local = Node<UMaterialExpressionAdd>(Material, -1000, Y);
					Local->A.Connect(0, Metres);
					Local->ConstB = float(-Start / Extent);
					return Local;
				};
				UMaterialExpressionAdd* SurveyU = Axis(true, -1200);
				UMaterialExpressionAdd* SurveyV = Axis(false, -1300);
				UMaterialExpressionAppendVector* SurveyUv = Node<UMaterialExpressionAppendVector>(Material, -900, -1250);
				SurveyUv->A.Connect(0, SurveyU);
				SurveyUv->B.Connect(0, SurveyV);
				UMaterialExpressionTextureSample* SurveySample = Node<UMaterialExpressionTextureSample>(Material, -800, -1250);
				SurveySample->Texture = Survey;
				SurveySample->AutoSetSampleType();
				SurveySample->Coordinates.Connect(0, PaddedUv(Material, SurveyUv, Survey, -1250));
				UMaterialExpressionCustom* FineMipLevel = Node<UMaterialExpressionCustom>(Material, -1100, -1650);
				FineMipLevel->OutputType = CMOT_Float1;
				FineMipLevel->Inputs.Empty();
				FCustomInput& Here = FineMipLevel->Inputs.AddDefaulted_GetRef();
				Here.InputName = TEXT("Here");
				Here.Input.Connect(0, GroundPosition);
				FCustomInput& Eye = FineMipLevel->Inputs.AddDefaulted_GetRef();
				Eye.InputName = TEXT("Eye");
				Eye.Input.Connect(0, GroundEye);
				FCustomInput& PhotoUv = FineMipLevel->Inputs.AddDefaulted_GetRef();
				PhotoUv.InputName = TEXT("UV");
				PhotoUv.Input.Connect(0, SurveyUv);
				const double SourcePixelM = FMath::Min(Manifest.SurveyNorthM / Survey->Source.GetSizeX(),
					Manifest.SurveyEastM / Survey->Source.GetSizeY());
				FineMipLevel->Code = FString::Printf(TEXT(R"(
float2 texels=UV*float2(%.1f,%.1f), dx=ddx(texels), dy=ddy(texels);
float projected=0.5*log2(max(max(dot(dx,dx),dot(dy,dy)),1e-8));
float minimum=%.6f*(1-smoothstep(300,1500,distance(Here,Eye)));
return max(projected,minimum);
)"), double(Survey->Source.GetSizeX()), double(Survey->Source.GetSizeY()),
					FMath::Max(0.0, FMath::Log2(0.1 / SourcePixelM)));
				SurveySample->MipValueMode = TMVM_MipLevel;
				SurveySample->MipValue.Connect(0, FineMipLevel);
				UMaterialExpressionMultiply* SurveyScaled = Node<UMaterialExpressionMultiply>(Material, -700, -1250);
				SurveyScaled->A.Connect(1, SurveySample);
				SurveyScaled->ConstB = float(Manifest.SurveyLog2Range * 255.0 / Manifest.SurveyZero);
				UMaterialExpressionAdd* SurveyExponent = Node<UMaterialExpressionAdd>(Material, -600, -1250);
				SurveyExponent->A.Connect(0, SurveyScaled);
				SurveyExponent->ConstB = float(-Manifest.SurveyLog2Range);
				UMaterialExpressionPower* SurveyFine = Node<UMaterialExpressionPower>(Material, -500, -1250);
				SurveyFine->Base.Connect(0, Two);
				SurveyFine->Exponent.Connect(0, SurveyExponent);
				// Inside when neither coordinate has left 0 to 1: the floor of each is zero.
				UMaterialExpressionFloor* FloorU = Node<UMaterialExpressionFloor>(Material, -800, -1400);
				FloorU->Input.Connect(0, SurveyU);
				UMaterialExpressionFloor* FloorV = Node<UMaterialExpressionFloor>(Material, -800, -1500);
				FloorV->Input.Connect(0, SurveyV);
				UMaterialExpressionAbs* AbsU = Node<UMaterialExpressionAbs>(Material, -700, -1400);
				AbsU->Input.Connect(0, FloorU);
				UMaterialExpressionAbs* AbsV = Node<UMaterialExpressionAbs>(Material, -700, -1500);
				AbsV->Input.Connect(0, FloorV);
				UMaterialExpressionAdd* Outside = Node<UMaterialExpressionAdd>(Material, -600, -1450);
				Outside->A.Connect(0, AbsU);
				Outside->B.Connect(0, AbsV);
				UMaterialExpressionOneMinus* Inner = Node<UMaterialExpressionOneMinus>(Material, -500, -1450);
				Inner->Input.Connect(0, Outside);
				UMaterialExpressionSaturate* Inside = Node<UMaterialExpressionSaturate>(Material, -400, -1450);
				Inside->Input.Connect(0, Inner);
				// 0 in the file is a pixel the orthophoto does not have: there the imagery's ratio and the grain stand.
				UMaterialExpressionMultiply* Has = Node<UMaterialExpressionMultiply>(Material, -650, -1350);
				Has->A.Connect(1, SurveySample);
				Has->ConstB = 255.f;
				UMaterialExpressionSaturate* HasPixel = Node<UMaterialExpressionSaturate>(Material, -550, -1350);
				HasPixel->Input.Connect(0, Has);
				UMaterialExpressionMultiply* Covered = Node<UMaterialExpressionMultiply>(Material, -300, -1450);
				Covered->A.Connect(0, Inside);
				Covered->B.Connect(0, HasPixel);
				UMaterialExpression* Influence = Covered;
				if (OrthoColour)
				{
					UMaterialExpressionTextureSample* Edge = Node<UMaterialExpressionTextureSample>(Material, -650, -1550);
					Edge->Texture = OrthoColour;
					Edge->SamplerType = SAMPLERTYPE_Color;
					Edge->Coordinates.Connect(0, SurveyUv);
					UMaterialExpressionMultiply* Faded = Node<UMaterialExpressionMultiply>(Material, -300, -1550);
					Faded->A.Connect(0, Covered);
					Faded->B.Connect(4, Edge);
					Influence = Faded;
				}
				InSurvey = Influence;
				UMaterialExpressionLinearInterpolate* Replaced = Node<UMaterialExpressionLinearInterpolate>(Material, -450, -1250);
				Replaced->A.Connect(0, Fine);
				Replaced->B.Connect(0, SurveyFine);
				Replaced->Alpha.Connect(0, Influence);
				FineUsed = Replaced;
			}
			UMaterialExpressionMultiply* WithFine = Node<UMaterialExpressionMultiply>(Material, -600, 0);
			WithFine->A.Connect(0, MacroAlbedo);
			WithFine->B.Connect(0, FineUsed);
			Base = WithFine;
		}
		// Grass grain: two reads of the measured texture at different scales and turns, added in log space, so the
		// pattern does not repeat and the strength stays what was measured. 2 ^ (sum / root two) multiplies the base.
		UMaterialExpression* GrassBase = nullptr;
		if (Grain)
		{
			const auto LogRatio = [&](float QuadsPerRepeat, float Turn, int32 Y)
			{
				UMaterialExpressionMultiply* Scaled = Node<UMaterialExpressionMultiply>(Material, -1000, Y);
				Scaled->A.Connect(1, Sample(Material, Grain, QuadsPerRepeat, SAMPLERTYPE_LinearGrayscale, Y, Turn));
				Scaled->ConstB = float(Manifest.GrainLog2Range * 255.0 / Manifest.GrainZero);
				UMaterialExpressionAdd* Centred = Node<UMaterialExpressionAdd>(Material, -900, Y);
				Centred->A.Connect(0, Scaled);
				Centred->ConstB = float(-Manifest.GrainLog2Range);
				return Centred;
			};
			const float Repeat = float(Manifest.GrainRepeatCm / QuadCm);
			UMaterialExpressionAdd* Both = Node<UMaterialExpressionAdd>(Material, -850, -500);
			Both->A.Connect(0, LogRatio(Repeat, 0.f, -500));
			Both->B.Connect(0, LogRatio(Repeat * 0.61f, 37.f, -700));
			UMaterialExpressionMultiply* Joined = Node<UMaterialExpressionMultiply>(Material, -800, -500);
			Joined->A.Connect(0, Both);
			Joined->ConstB = 0.70710678f;
			// Nearer than one texel a pixel the texture is magnified and the grain a soft blotch: it fades down to a share.
			UMaterialExpressionWorldPosition* GrainPlace = Node<UMaterialExpressionWorldPosition>(Material, -1200, -900);
			UMaterialExpressionCameraPositionWS* GrainEye = Node<UMaterialExpressionCameraPositionWS>(Material, -1200, -800);
			UMaterialExpressionDistance* Away = Node<UMaterialExpressionDistance>(Material, -1050, -850);
			Away->A.Connect(0, GrainPlace);
			Away->B.Connect(0, GrainEye);
			UMaterialExpressionMultiply* Texels = Node<UMaterialExpressionMultiply>(Material, -950, -850);
			Texels->A.Connect(0, Away);
			Texels->ConstB = float(1.0 / Manifest.GrainSharpCm);
			UMaterialExpressionSaturate* Sharp = Node<UMaterialExpressionSaturate>(Material, -900, -850);
			Sharp->Input.Connect(0, Texels);
			UMaterialExpressionLinearInterpolate* Fade = Node<UMaterialExpressionLinearInterpolate>(Material, -850, -850);
			Fade->ConstA = float(Manifest.GrainNearShare);
			Fade->ConstB = 1.f;
			Fade->Alpha.Connect(0, Sharp);
			UMaterialExpressionMultiply* Faded = Node<UMaterialExpressionMultiply>(Material, -800, -550);
			Faded->A.Connect(0, Joined);
			Faded->B.Connect(0, Fade);
			UMaterialExpression* GrainStrength = Faded;
			if (InSurvey)
			{
				UMaterialExpressionOneMinus* Outside = Node<UMaterialExpressionOneMinus>(Material, -900, -600);
				Outside->Input.Connect(0, InSurvey);
				UMaterialExpressionMultiply* Kept = Node<UMaterialExpressionMultiply>(Material, -780, -600);
				Kept->A.Connect(0, Faded);
				Kept->B.Connect(0, Outside);
				GrainStrength = Kept;
			}
			// Three channels: a power takes the width of its base, and the exponent differs by band.
			UMaterialExpressionConstant3Vector* GrainTwo = Node<UMaterialExpressionConstant3Vector>(Material, -800, -600);
			GrainTwo->Constant = FLinearColor(2, 2, 2);
			// The grain is a colour: each band goes with the luminance by its own measured slope.
			UMaterialExpressionConstant3Vector* GrainTint = Node<UMaterialExpressionConstant3Vector>(Material, -800, -450);
			GrainTint->Constant = Manifest.GrainTint;
			UMaterialExpressionMultiply* GrainByBand = Node<UMaterialExpressionMultiply>(Material, -780, -500);
			GrainByBand->A.Connect(0, GrainStrength);
			GrainByBand->B.Connect(0, GrainTint);
			UMaterialExpressionPower* GrainPower = Node<UMaterialExpressionPower>(Material, -750, -500);
			GrainPower->Base.Connect(0, GrainTwo);
			GrainPower->Exponent.Connect(0, GrainByBand);
			UMaterialExpressionMultiply* WithGrain = Node<UMaterialExpressionMultiply>(Material, -650, -500);
			WithGrain->A.Connect(0, Base);
			WithGrain->B.Connect(0, GrainPower);
			GrassBase = WithGrain;
		}
		UMaterialExpressionTextureSample* MixNoise = Sample(Material, Detail, 1100.0 / QuadCm, SAMPLERTYPE_LinearGrayscale, 250);
		UMaterialExpressionCustom* ScanMix = Node<UMaterialExpressionCustom>(Material, -900, 350);
		ScanMix->OutputType = CMOT_Float1;
		ScanMix->Inputs.Empty();
		FCustomInput& MixPattern = ScanMix->Inputs.AddDefaulted_GetRef();
		MixPattern.InputName = TEXT("Pattern");
		MixPattern.Input.Connect(1, MixNoise);
		FCustomInput& MixPosition = ScanMix->Inputs.AddDefaulted_GetRef();
		MixPosition.InputName = TEXT("Here");
		MixPosition.Input.Connect(0, GroundPosition);
		FCustomInput& MixCamera = ScanMix->Inputs.AddDefaulted_GetRef();
		MixCamera.InputName = TEXT("Eye");
		MixCamera.Input.Connect(0, GroundEye);
		ScanMix->Code = TEXT("return Pattern*smoothstep(1500,3000,distance(Here,Eye));");
		const auto Mix = [&](UMaterialExpression* A, UMaterialExpression* B, int32 X, int32 Y)
		{
			UMaterialExpressionLinearInterpolate* Out = Node<UMaterialExpressionLinearInterpolate>(Material, X, Y);
			Out->A.Connect(0, A);
			Out->B.Connect(0, B);
			Out->Alpha.Connect(0, ScanMix);
			return Out;
		};
		const auto Combine = [&](UMaterialExpression* Sum, UMaterialExpression* Term, int32 X, int32 Y) -> UMaterialExpression*
		{
			if (!Sum)
			{
				return Term;
			}
			UMaterialExpressionAdd* Out = Node<UMaterialExpressionAdd>(Material, X, Y);
			Out->A.Connect(0, Sum);
			Out->B.Connect(0, Term);
			return Out;
		};
		UMaterialExpression* ColourSum = nullptr;
		UMaterialExpression* NormalSum = nullptr;
		UMaterialExpression* RoughSum = nullptr;
		UMaterialExpression* WeightSum = nullptr;
		UMaterialExpression* GrassSharp = nullptr;
		UMaterialExpression* GrassPlacement = nullptr;
		UMaterialExpression* NativeMasks = nullptr;
		UMaterialExpression* NativeCoverage = nullptr;
		UMaterialExpression* NativeInfluence = nullptr;
		UMaterialExpressionTextureSample* NativeColour = nullptr;
		UMaterialExpressionTextureSample* OriginalWeights = FallbackWeights
			? Sample(Material, FallbackWeights, Quads, SAMPLERTYPE_LinearColor, 650) : nullptr;
		if (OrthoMasks)
		{
			UMaterialExpressionLandscapeLayerCoords* TileUv = Node<UMaterialExpressionLandscapeLayerCoords>(Material, -1500, 700);
			TileUv->MappingScale = float(Quads);
			UMaterialExpressionCustom* Uv = Node<UMaterialExpressionCustom>(Material, -1300, 700);
			Uv->OutputType = CMOT_Float2;
			Uv->Inputs.Empty();
			FCustomInput& Input = Uv->Inputs.AddDefaulted_GetRef();
			Input.InputName = TEXT("UV");
			Input.Input.Connect(0, TileUv);
			Uv->Code = FString::Printf(TEXT("return (UV*%.6f-float2(%.6f,%.6f))/float2(%.6f,%.6f);"),
				Manifest.TileSizeCm / 100, Manifest.OrthoSouthM, Manifest.OrthoWestM, Manifest.OrthoNorthM, Manifest.OrthoEastM);
			UMaterialExpressionTextureSample* Masks = Node<UMaterialExpressionTextureSample>(Material, -1100, 700);
			Masks->Texture = OrthoMasks;
			Masks->AutoSetSampleType();
			Masks->Coordinates.Connect(0, PaddedUv(Material, Uv, OrthoMasks, 700));
			NativeMasks = Masks;
			if (OrthoColour)
			{
				NativeColour = Node<UMaterialExpressionTextureSample>(Material, -1100, 800);
				NativeColour->Texture = OrthoColour;
				NativeColour->SamplerType = SAMPLERTYPE_Color;
				NativeColour->Coordinates.Connect(0, Uv);
			}
			UMaterialExpressionCustom* Coverage = Node<UMaterialExpressionCustom>(Material, -900, 700);
			Coverage->OutputType = CMOT_Float1;
			Coverage->Inputs.Empty();
			FCustomInput& At = Coverage->Inputs.AddDefaulted_GetRef();
			At.InputName = TEXT("UV");
			At.Input.Connect(0, Uv);
			FCustomInput& Shares = Coverage->Inputs.AddDefaulted_GetRef();
			Shares.InputName = TEXT("Masks");
			Shares.Input.Connect(0, Masks);
			Coverage->Code = TEXT("return all(UV>=0)&&all(UV<=1) ? saturate(dot(Masks.rgb,float3(1,1,1))) : 0;");
			NativeCoverage = Coverage;
			NativeInfluence = Coverage;
			if (NativeColour)
			{
				UMaterialExpressionMin* Faded = Node<UMaterialExpressionMin>(Material, -700, 800);
				Faded->A.Connect(0, Coverage);
				Faded->B.Connect(4, NativeColour);
				NativeInfluence = Faded;
			}
		}
		UMaterialExpressionCustom* DetailShare = Node<UMaterialExpressionCustom>(Material, -1200, 350);
		DetailShare->OutputType = CMOT_Float1;
		DetailShare->Inputs.Empty();
		FCustomInput& PositionInput = DetailShare->Inputs.AddDefaulted_GetRef();
		PositionInput.InputName = TEXT("Here");
		PositionInput.Input.Connect(0, GroundPosition);
		FCustomInput& EyeInput = DetailShare->Inputs.AddDefaulted_GetRef();
		EyeInput.InputName = TEXT("Eye");
		EyeInput.Input.Connect(0, GroundEye);
		DetailShare->Code = TEXT("return lerp(1.0,0.2,smoothstep(1500.0,10000.0,distance(Here,Eye)));");
		int32 Row = 0;
		for (const FLayer& Layer : Layers)
		{
			const float Repeat = float(Layer.Scan.SizeCm / QuadCm);
			const int32 Y = 1000 + Row * 1500;
			UMaterialExpression* ScanColour = nullptr;
			if (Layer.Name == GrassLayer)
			{
				UMaterialExpressionTextureSample* Near = Sample(Material, Layer.Colour, Repeat, SAMPLERTYPE_Color, Y);
				UMaterialExpressionTextureSample* Far = Sample(Material, Layer.Colour, Repeat * 2.3f, SAMPLERTYPE_Color, Y + 250, 31.f);
				ScanColour = Mix(Near, Far, -400, Y);
			}
			else
			{
				ScanColour = BombColour(Material, Layer.Colour, Repeat, GroundPosition, GroundEye, Y);
			}
			UMaterialExpressionConstant3Vector* Mean = Node<UMaterialExpressionConstant3Vector>(Material, -500, Y);
			Mean->Constant = Layer.Scan.MeanColour;
			UMaterialExpressionDivide* Structure = Node<UMaterialExpressionDivide>(Material, -300, Y);
			Structure->A.Connect(0, ScanColour);
			Structure->B.Connect(0, Mean);
			UMaterialExpressionCustom* TextureContrast = Node<UMaterialExpressionCustom>(Material, -300, Y + 75);
			TextureContrast->OutputType = CMOT_Float3;
			TextureContrast->Inputs.Empty();
			FCustomInput& ScanPattern = TextureContrast->Inputs.AddDefaulted_GetRef();
			ScanPattern.InputName = TEXT("Pattern");
			ScanPattern.Input.Connect(0, Structure);
			TextureContrast->Code = TEXT("return clamp(1+(Pattern-1)*1.6,0.2,2.0);");
			UMaterialExpressionLinearInterpolate* DetailAmount = Node<UMaterialExpressionLinearInterpolate>(Material, -250, Y + 50);
			DetailAmount->ConstA = 1.f;
			DetailAmount->B.Connect(0, TextureContrast);
			DetailAmount->Alpha.Connect(0, DetailShare);
			UMaterialExpressionMultiply* Albedo = Node<UMaterialExpressionMultiply>(Material, -200, Y);
			UMaterialExpression* LayerBase = Layer.Name == GrassLayer && GrassBase ? GrassBase : Base;
			if (NativeColour && Layer.OrthoMean)
			{
				UMaterialExpressionConstant3Vector* PhotoMean = Node<UMaterialExpressionConstant3Vector>(Material, -600, Y - 300);
				PhotoMean->Constant = *Layer.OrthoMean;
				UMaterialExpressionDivide* Pattern = Node<UMaterialExpressionDivide>(Material, -450, Y - 300);
				Pattern->A.Connect(0, NativeColour);
				Pattern->B.Connect(0, PhotoMean);
				UMaterialExpressionMin* Covered = Node<UMaterialExpressionMin>(Material, -450, Y - 400);
				Covered->A.Connect(0, NativeCoverage);
				Covered->B.Connect(4, NativeColour);
				UMaterialExpressionLinearInterpolate* Applied = Node<UMaterialExpressionLinearInterpolate>(Material, -300, Y - 300);
				Applied->ConstA = 1.f;
				Applied->B.Connect(0, Pattern);
				Applied->Alpha.Connect(0, Covered);
				UMaterialExpressionMultiply* WithPattern = Node<UMaterialExpressionMultiply>(Material, -150, Y - 300);
				WithPattern->A.Connect(0, LayerBase);
				WithPattern->B.Connect(0, Applied);
				LayerBase = WithPattern;
			}
			Albedo->A.Connect(0, LayerBase);
			Albedo->B.Connect(0, DetailAmount);

			UMaterialExpressionTextureSample* NormalNear = Sample(Material, Layer.Normal, Repeat, SAMPLERTYPE_Normal, Y + 500);
			UMaterialExpressionTextureSample* RoughNear = Sample(Material, Layer.Rough, Repeat, SAMPLERTYPE_LinearGrayscale, Y + 750);
			UMaterialExpressionTextureSample* RoughFar = Sample(Material, Layer.Rough, Repeat * 2.3f, SAMPLERTYPE_LinearGrayscale, Y + 1000, 31.f);
			UMaterialExpressionTextureSample* Relief = Sample(Material, Layer.Relief, Repeat, SAMPLERTYPE_LinearGrayscale, Y + 1250);

			// This class's weight, moved a little by its relief, cut to a sharp edge at one half.
			UMaterialExpressionLandscapeLayerSample* Weight = Node<UMaterialExpressionLandscapeLayerSample>(Material, 0, Y);
			Weight->ParameterName = Layer.Name;
			Weight->PreviewWeight = Row == 0 ? 1 : 0;
			UMaterialExpression* SurfaceWeight = Weight;
			if (NativeMasks && OriginalWeights)
			{
				UMaterialExpressionComponentMask* Own = Node<UMaterialExpressionComponentMask>(Material, -400, Y + 100);
				Own->Input.Connect(0, NativeMasks);
				Own->R = Layer.Name == GrassLayer;
				Own->G = Layer.Name == PavedLayer;
				Own->B = Layer.Name == SoilLayer;
				Own->A = false;
				UMaterialExpressionDivide* Share = Node<UMaterialExpressionDivide>(Material, -200, Y + 100);
				Share->A.Connect(0, Own);
				UMaterialExpressionAdd* SafeCoverage = Node<UMaterialExpressionAdd>(Material, -400, Y + 200);
				SafeCoverage->A.Connect(0, NativeCoverage);
				SafeCoverage->ConstB = 0.0001f;
				Share->B.Connect(0, SafeCoverage);
				UMaterialExpressionLinearInterpolate* Replace = Node<UMaterialExpressionLinearInterpolate>(Material, 0, Y + 100);
				UMaterialExpressionComponentMask* Original = Node<UMaterialExpressionComponentMask>(Material, -200, Y + 200);
				Original->Input.Connect(0, OriginalWeights);
				Original->R = Layer.Name == GrassLayer;
				Original->G = Layer.Name == PavedLayer;
				Original->B = Layer.Name == SoilLayer;
				Original->A = false;
				Replace->A.Connect(0, Original);
				Replace->B.Connect(0, Share);
				Replace->Alpha.Connect(0, NativeInfluence);
				SurfaceWeight = Replace;
			}
			UMaterialExpressionAdd* Lifted = Node<UMaterialExpressionAdd>(Material, 100, Y);
			UMaterialExpressionMultiply* ReliefShift = Node<UMaterialExpressionMultiply>(Material, 0, Y + 100);
			ReliefShift->A.Connect(0, Relief);
			ReliefShift->ConstB = ReliefInfluence;
			Lifted->A.Connect(0, SurfaceWeight);
			Lifted->B.Connect(0, ReliefShift);
			UMaterialExpressionAdd* Centred = Node<UMaterialExpressionAdd>(Material, 150, Y);
			Centred->A.Connect(0, Lifted);
			Centred->ConstB = -ReliefInfluence / 2;
			UMaterialExpressionSmoothStep* Cut = Node<UMaterialExpressionSmoothStep>(Material, 200, Y);
			Cut->Value.Connect(0, Centred);
			Cut->ConstMin = 0.5f - EdgeSharpness;
			Cut->ConstMax = 0.5f + EdgeSharpness;
			// A little of the plain weight keeps the sum above zero where no class reaches one half.
			UMaterialExpressionMultiply* Floor = Node<UMaterialExpressionMultiply>(Material, 200, Y + 100);
			Floor->A.Connect(0, SurfaceWeight);
			Floor->ConstB = 0.001f;
			UMaterialExpressionAdd* Sharp = Node<UMaterialExpressionAdd>(Material, 250, Y);
			Sharp->A.Connect(0, Cut);
			Sharp->B.Connect(0, Floor);

			const auto Weighted = [&](UMaterialExpression* Input, int32 X)
			{
				UMaterialExpressionMultiply* Out = Node<UMaterialExpressionMultiply>(Material, X, Y);
				Out->A.Connect(0, Input);
				Out->B.Connect(0, Sharp);
				return Out;
			};
			ColourSum = Combine(ColourSum, Weighted(Albedo, 300), 350, Y);
			NormalSum = Combine(NormalSum, Weighted(NormalNear, 300), 350, Y + 300);
			RoughSum = Combine(RoughSum, Weighted(Mix(RoughNear, RoughFar, -400, Y + 900), 300), 350, Y + 600);
			WeightSum = Combine(WeightSum, Sharp, 350, Y + 900);
			if (Layer.Name == GrassLayer)
			{
				GrassSharp = Cut;
				GrassPlacement = Weight;
			}
			++Row;
		}
		UMaterialExpressionAdd* SafeSum = Node<UMaterialExpressionAdd>(Material, 450, 900);
		SafeSum->A.Connect(0, WeightSum);
		SafeSum->ConstB = 1e-4f;
		UMaterialExpressionDivide* Colour = Node<UMaterialExpressionDivide>(Material, 500, 0);
		Colour->A.Connect(0, ColourSum);
		Colour->B.Connect(0, SafeSum);
		UMaterialExpressionDivide* Normal = Node<UMaterialExpressionDivide>(Material, 500, 300);
		Normal->A.Connect(0, NormalSum);
		Normal->B.Connect(0, SafeSum);
		UMaterialExpressionDivide* Rough = Node<UMaterialExpressionDivide>(Material, 500, 600);
		Rough->A.Connect(0, RoughSum);
		Rough->B.Connect(0, SafeSum);
		if (!GrassTypes.IsEmpty())
		{
			UMaterialExpressionTextureSample* GrowthAt = Sample(Material, Growth, Quads, SAMPLERTYPE_LinearColor, 900);
			UMaterialExpressionLandscapeGrassOutput* Output = Node<UMaterialExpressionLandscapeGrassOutput>(Material, 300, 900);
			Output->GrassTypes.Empty();
			for (int32 Index = 0; Index < GrassTypes.Num(); ++Index)
			{
				const bool bTall = Manifest.Turf.Varieties[Index].Name == FName(TEXT("tall"));
				UMaterialExpressionMultiply* Density = Node<UMaterialExpressionMultiply>(Material, 100, 900 + Index * 100);
				Density->A.Connect(0, GrassPlacement);
				Density->B.Connect(bTall ? 2 : 1, GrowthAt);
				FGrassInput& Input = Output->GrassTypes.AddDefaulted_GetRef();
				Input.Name = Manifest.Turf.Varieties[Index].Name;
				Input.GrassType = GrassTypes[Index];
				Input.Input.Connect(0, Density);
			}
		}

		UMaterialEditingLibrary::ConnectMaterialProperty(Colour, TEXT(""), MP_BaseColor);
		UMaterialEditingLibrary::ConnectMaterialProperty(Normal, TEXT(""), MP_Normal);
		UMaterialEditingLibrary::ConnectMaterialProperty(Rough, TEXT(""), MP_Roughness);
		if (GrassSharp)
		{
			UMaterialExpressionCustom* UnevenNormal = Node<UMaterialExpressionCustom>(Material, 500, 1000);
			UnevenNormal->OutputType = CMOT_Float3;
			UnevenNormal->Inputs.Empty();
			const auto NormalInput = [&](const TCHAR* Name, UMaterialExpression* Value)
			{
				FCustomInput& Input = UnevenNormal->Inputs.AddDefaulted_GetRef();
				Input.InputName = Name;
				Input.Input.Connect(0, Value);
			};
			NormalInput(TEXT("Here"), GroundPosition);
			NormalInput(TEXT("Eye"), GroundEye);
			NormalInput(TEXT("ScanNormal"), Normal);
			NormalInput(TEXT("Grass"), GrassSharp);
			UnevenNormal->Code = TEXT(R"(
float a=Here.x*0.027+Here.y*0.013, b=Here.y*0.039-Here.x*0.011;
float2 slope=0.65*float2(0.027*cos(a)*sin(b)-0.011*sin(a)*cos(b),0.013*cos(a)*sin(b)+0.039*sin(a)*cos(b));
float close=1-smoothstep(600,1800,distance(Here,Eye));
return normalize(float3(ScanNormal.xy*lerp(1,1.8,close)-slope*Grass,ScanNormal.z));
)");
			UMaterialEditingLibrary::ConnectMaterialProperty(UnevenNormal, TEXT(""), MP_Normal);
			UMaterialExpressionCustom* Relief = Node<UMaterialExpressionCustom>(Material, 500, 1100);
			Relief->OutputType = CMOT_Float3;
			Relief->Inputs.Empty();
			FCustomInput& Place = Relief->Inputs.AddDefaulted_GetRef();
			Place.InputName = TEXT("Here");
			Place.Input.Connect(0, GroundPosition);
			FCustomInput& Grass = Relief->Inputs.AddDefaulted_GetRef();
			Grass.InputName = TEXT("Grass");
			Grass.Input.Connect(0, GrassPlacement);
			Relief->Code = TEXT("return float3(0,0,Grass*0.65*sin(Here.x*0.027+Here.y*0.013)*sin(Here.y*0.039-Here.x*0.011));");
			UMaterialEditingLibrary::ConnectMaterialProperty(Relief, TEXT(""), MP_WorldPositionOffset);
		}
		UMaterialEditingLibrary::RecompileMaterial(Material);
		return Material;
	}

	/** Decode a surface's heightmap and colour map. False, with a logged reason, when either is unusable. */
	bool DecodeSurface(const FManifest& Manifest, const FSurface& Surface, TArray64<uint8>& HeightBytes, TArray64<uint8>& ColourBytes, FIntPoint& ColourSize)
	{
		int32 Width = 0, Height = 0;
		if (!DecodePng(Manifest.Directory / Surface.HeightmapFile, ERGBFormat::Gray, 16, HeightBytes, Width, Height) || Width != Surface.Vertices ||
			Height != Surface.Vertices)
		{
			UE_LOG(LogEnvGen, Error, TEXT("%s is not a %dx%d 16-bit grey PNG"), *Surface.HeightmapFile, Surface.Vertices, Surface.Vertices);
			return false;
		}
		if (!DecodePng(Manifest.Directory / Surface.ColourFile, ERGBFormat::BGRA, 8, ColourBytes, ColourSize.X, ColourSize.Y))
		{
			UE_LOG(LogEnvGen, Error, TEXT("cannot decode %s"), *Surface.ColourFile);
			return false;
		}
		return true;
	}

	/** Import one surface as a Landscape, painted with the layers' weightmaps. */
	ALandscape* ImportLandscape(UWorld* World, const TCHAR* Label, const FSurface& Surface, const TArray64<uint8>& HeightBytes, UMaterial* Material, int32 Stencil,
		const TArray<FLayer>& Layers)
	{
		const int32 Vertices = Surface.Vertices;
		TArray<uint16> Heights;
		Heights.SetNumUninitialized(Vertices * Vertices);
		FMemory::Memcpy(Heights.GetData(), HeightBytes.GetData(), Heights.Num() * sizeof(uint16));

		TMap<FGuid, TArray<uint16>> HeightsPerLayer;
		HeightsPerLayer.Add(FGuid(), MoveTemp(Heights));
		TMap<FGuid, TArray<FLandscapeImportLayerInfo>> WeightsPerLayer;
		TArray<FLandscapeImportLayerInfo>& Weights = WeightsPerLayer.Add(FGuid());

		ALandscape* Landscape = World->SpawnActor<ALandscape>(Surface.LocationCm, FRotator::ZeroRotator);
		Landscape->SetActorLabel(Label);
		Landscape->SetActorRelativeScale3D(Surface.Scale);
		Landscape->LandscapeMaterial = Material;
		Landscape->bRenderCustomDepth = true;
		Landscape->CustomDepthStencilValue = Stencil;
		for (const FLayer& Layer : Layers)
		{
			FLandscapeImportLayerInfo& Painted = Weights.Emplace_GetRef(Layer.Name);
			Painted.LayerInfo = Layer.Info;
			Painted.LayerData.Append(Layer.Weights.GetData(), Layer.Weights.Num());
			// A weightmap for a layer the Landscape does not list as a target is dropped on import.
			Landscape->AddTargetLayer(Layer.Name, FLandscapeTargetLayerSettings(Layer.Info), false);
		}
		Landscape->Import(FGuid::NewGuid(), 0, 0, Vertices - 1, Vertices - 1, Surface.SectionsPerComponent, Surface.SectionQuads, HeightsPerLayer, nullptr,
			WeightsPerLayer, ELandscapeImportAlphamapType::Additive, TArrayView<const FLandscapeLayer>());

		ULandscapeInfo* Info = Landscape->GetLandscapeInfo();
		check(Info);
		Info->UpdateLayerInfoMap(Landscape);
		Landscape->RegisterAllComponents();
		return Landscape;
	}

	/** The surround's material: its own colour map across it, and nothing finer. It is only ever seen from far away. */
	UMaterial* MakeSurroundMaterial(UTexture2D* Colour, int32 Quads, float AlbedoScale, TArray<UPackage*>& Packages)
	{
		UMaterial* Material = NewAsset<UMaterial>(TEXT("M_Surround"), Packages);
		UMaterialExpressionMultiply* Albedo = Node<UMaterialExpressionMultiply>(Material, -300, 0);
		Albedo->A.Connect(0, Sample(Material, Colour, Quads, SAMPLERTYPE_Color, 0));
		Albedo->ConstB = AlbedoScale;
		UMaterialEditingLibrary::ConnectMaterialProperty(Albedo, TEXT(""), MP_BaseColor);
		UMaterialExpressionConstant* Roughness = Node<UMaterialExpressionConstant>(Material, -300, 200);
		Roughness->R = 0.9f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Roughness, TEXT(""), MP_Roughness);
		UMaterialEditingLibrary::RecompileMaterial(Material);
		return Material;
	}

	/**
	 * Flat ground from under the outermost surface to the horizon, in that surface's average colour. Without it
	 * the sky's empty lower half shows as a blue band past the surface's edge from any height. It only closes the band
	 * without distance fog, which would turn everything past a couple of kilometres, the plane included, dark.
	 */
	void AddHorizon(UWorld* World, const FSurface& Outer, const TArray64<uint8>& HeightBytes, const TArray64<uint8>& ColourBytes, float AlbedoScale, TArray<UPackage*>& Packages)
	{
		const uint16* Heights = reinterpret_cast<const uint16*>(HeightBytes.GetData());
		uint16 Lowest = MAX_uint16;
		for (int64 Index = 0; Index < HeightBytes.Num() / 2; ++Index)
		{
			Lowest = FMath::Min(Lowest, Heights[Index]);
		}
		FVector Sum = FVector::ZeroVector;
		const int64 Pixels = ColourBytes.Num() / 4;
		for (int64 Pixel = 0; Pixel < Pixels; ++Pixel)
		{
			Sum += FVector(FLinearColor(FColor(ColourBytes[Pixel * 4 + 2], ColourBytes[Pixel * 4 + 1], ColourBytes[Pixel * 4])));
		}
		UMaterial* Material = NewAsset<UMaterial>(TEXT("M_Horizon"), Packages);
		UMaterialExpressionConstant3Vector* Colour = Node<UMaterialExpressionConstant3Vector>(Material, -300, 0);
		Colour->Constant = FLinearColor(Sum / Pixels * AlbedoScale);
		UMaterialEditingLibrary::ConnectMaterialProperty(Colour, TEXT(""), MP_BaseColor);
		UMaterialExpressionConstant* Roughness = Node<UMaterialExpressionConstant>(Material, -300, 200);
		Roughness->R = 0.9f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Roughness, TEXT(""), MP_Roughness);
		UMaterialEditingLibrary::RecompileMaterial(Material);

		const double Z = Outer.LocationCm.Z + (double(Lowest) - 32768.0) * Outer.Scale.Z / 128.0 - HorizonSinkCm;
		AStaticMeshActor* Horizon = World->SpawnActor<AStaticMeshActor>(FVector(0, 0, Z), FRotator::ZeroRotator);
		Horizon->SetActorLabel(TEXT("EnvGenHorizon"));
		UStaticMeshComponent* Mesh = Horizon->GetStaticMeshComponent();
		// The engine's plane is 100 cm on a side.
		Mesh->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Plane.Plane")));
		Mesh->SetMaterial(0, Material);
		Mesh->SetWorldScale3D(FVector(HorizonSizeCm / 100, HorizonSizeCm / 100, 1));
		// It is only there to be seen: nothing stands on it, and it takes no part in shadows or bounce light.
		Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Mesh->SetCastShadow(false);
		Mesh->bAffectDynamicIndirectLighting = false;
		Mesh->bAffectDistanceFieldLighting = false;
	}

	/** The inventory the pipeline wrote: a table with named columns. */
	bool LoadTrees(const FString& Path, TArray<FTree>& Out, FString& Error)
	{
		FString Text;
		TSharedPtr<FJsonObject> Root;
		const TArray<TSharedPtr<FJsonValue>>* Columns = nullptr;
		const TArray<TSharedPtr<FJsonValue>>* Rows = nullptr;
		if (!FFileHelper::LoadFileToString(Text, *Path) || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root ||
			!Root->TryGetArrayField(TEXT("columns"), Columns) || !Root->TryGetArrayField(TEXT("trees"), Rows))
		{
			Error = FString::Printf(TEXT("cannot read the tree inventory %s"), *Path);
			return false;
		}
		TMap<FString, int32> Column;
		for (int32 Index = 0; Index < Columns->Num(); ++Index)
		{
			Column.Add((*Columns)[Index]->AsString(), Index);
		}
		for (const TCHAR* Needed : {TEXT("east_m"), TEXT("north_m"), TEXT("height_m"), TEXT("crown_radius_m"), TEXT("kind"), TEXT("trunk_diameter_m"), TEXT("crown_ratio"), TEXT("yaw_deg")})
		{
			if (!Column.Contains(Needed))
			{
				Error = FString::Printf(TEXT("the tree inventory has no column '%s'"), Needed);
				return false;
			}
		}
		for (const TSharedPtr<FJsonValue>& Value : *Rows)
		{
			const TArray<TSharedPtr<FJsonValue>>& Row = Value->AsArray();
			// A missing number (no species, so no trunk) reads as zero.
			const auto Number = [&](const TCHAR* Name) { double Read = 0; Row[Column[Name]]->TryGetNumber(Read); return Read; };
			FTree& Tree = Out.AddDefaulted_GetRef();
			Tree.EastM = Number(TEXT("east_m"));
			Tree.NorthM = Number(TEXT("north_m"));
			Tree.HeightM = Number(TEXT("height_m"));
			Tree.CrownRadiusM = Number(TEXT("crown_radius_m"));
			Tree.TrunkDiameterM = Number(TEXT("trunk_diameter_m"));
			Tree.CrownRatio = Number(TEXT("crown_ratio"));
			Tree.YawDeg = Number(TEXT("yaw_deg"));
			Tree.Kind = FName(*Row[Column[TEXT("kind")]]->AsString());
		}
		return true;
	}

	/** The meshes materials.json names for each kind of tree. They ship with an engine plugin; nothing is imported. */
	bool LoadTreeMeshes(const FString& Directory, TArray<FTreeMesh>& Out, FString& Error)
	{
		FString Text;
		TSharedPtr<FJsonObject> Root;
		const TSharedPtr<FJsonObject>* Trees = nullptr;
		const TSharedPtr<FJsonObject>* Kinds = nullptr;
		if (!FFileHelper::LoadFileToString(Text, *(Directory / TEXT("materials.json"))) || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root ||
			!Root->TryGetObjectField(TEXT("trees"), Trees) || !(*Trees)->TryGetObjectField(TEXT("kinds"), Kinds))
		{
			Error = TEXT("materials.json has no trees.kinds; run fetch-materials.ps1 again");
			return false;
		}
		for (const auto& Kind : (*Kinds)->Values)
		{
			for (const TSharedPtr<FJsonValue>& Path : Kind.Value->AsArray())
			{
				FTreeMesh& Mesh = Out.AddDefaulted_GetRef();
				Mesh.Kind = FName(*Kind.Key);
				Mesh.Asset = LoadObject<USkinnedAsset>(nullptr, *Path->AsString());
				if (!Mesh.Asset)
				{
					Error = FString::Printf(TEXT("cannot load the tree mesh %s; is the plugin it ships in enabled?"), *Path->AsString());
					return false;
				}
				const FBoxSphereBounds Bounds = Mesh.Asset->GetBounds();
				Mesh.HeightCm = 2 * Bounds.BoxExtent.Z;
				Mesh.RadiusCm = (Bounds.BoxExtent.X + Bounds.BoxExtent.Y) / 2;
				if (Mesh.HeightCm <= 0 || Mesh.RadiusCm <= 0)
				{
					Error = FString::Printf(TEXT("tree mesh %s has empty bounds"), *Path->AsString());
					return false;
				}
			}
		}
		return true;
	}

	/** The height of the imported surface at a point, in world centimetres, between its four vertices. */
	double SurfaceZ(const FSurface& Surface, const TArray64<uint8>& HeightBytes, double NorthCm, double EastCm)
	{
		const uint16* Heights = reinterpret_cast<const uint16*>(HeightBytes.GetData());
		const int32 Last = Surface.Vertices - 1;
		const double North = FMath::Clamp((NorthCm - Surface.LocationCm.X) / Surface.Scale.X, 0.0, double(Last));
		const double East = FMath::Clamp((EastCm - Surface.LocationCm.Y) / Surface.Scale.Y, 0.0, double(Last));
		const int32 N0 = FMath::Min(int32(North), Last - 1), E0 = FMath::Min(int32(East), Last - 1);
		const auto At = [&](int32 E, int32 N) { return double(Heights[E * Surface.Vertices + N]); };
		const double Low = FMath::Lerp(At(E0, N0), At(E0, N0 + 1), North - N0);
		const double High = FMath::Lerp(At(E0 + 1, N0), At(E0 + 1, N0 + 1), North - N0);
		return Surface.LocationCm.Z + (FMath::Lerp(Low, High, East - E0) - 32768.0) * Surface.Scale.Z / 128.0;
	}

	/**
	 * Stand every tree of the inventory on the surface, at its measured height and crown width. Each takes the mesh
	 * of its kind selected among similarly sized meshes. The meshes are instanced, cast shadows, and carry the tree
	 * stencil. Collision is separate and unseen: a cylinder for the trunk and one bounding the crown, sized from
	 * the species' inventory records.
	 */
	AActor* AddTrees(UWorld* World, const FManifest& Manifest, const TArray64<uint8>& HeightBytes, const TArray<FTree>& Trees, TArray<FTreeMesh>& Meshes, int32& Placed)
	{
		AActor* Actor = World->SpawnActor<AActor>();
		Actor->SetActorLabel(TEXT("EnvGenTrees"));
		Actor->Tags.Add(EnvGenStandingTag());
		USceneComponent* Root = NewObject<USceneComponent>(Actor, TEXT("Root"));
		Root->SetMobility(EComponentMobility::Static);
		Actor->SetRootComponent(Root);
		Actor->AddInstanceComponent(Root);
		Root->RegisterComponent();
		const int32 Stencil = int32(Manifest.StencilClasses->GetNumberField(TEXT("tree")));
		for (int32 Index = 0; Index < Meshes.Num(); ++Index)
		{
			FTreeMesh& Mesh = Meshes[Index];
			Mesh.Instances = NewObject<UInstancedSkinnedMeshComponent>(Actor, *FString::Printf(TEXT("Trees_%s_%d"), *Mesh.Kind.ToString(), Index));
			Mesh.Instances->SetupAttachment(Root);
			Mesh.Instances->SetSkinnedAsset(Mesh.Asset);
			Mesh.Instances->SetCollisionEnabled(ECollisionEnabled::NoCollision);
			Mesh.Instances->SetRenderCustomDepth(true);
			Mesh.Instances->SetCustomDepthStencilValue(Stencil);
			Actor->AddInstanceComponent(Mesh.Instances);
			Mesh.Instances->RegisterComponent();
		}
		// The engine's cylinder is 100 cm across and 100 cm tall, centred on its origin.
		UInstancedStaticMeshComponent* Solid = NewObject<UInstancedStaticMeshComponent>(Actor, TEXT("TreeCollision"));
		Solid->SetupAttachment(Root);
		Solid->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cylinder.Cylinder")));
		Solid->SetMobility(EComponentMobility::Static);
		Solid->SetCollisionProfileName(TEXT("BlockAll"));
		Solid->SetVisibility(false);
		Solid->SetHiddenInGame(true);
		Solid->SetCastShadow(false);
		Actor->AddInstanceComponent(Solid);
		Solid->RegisterComponent();

		Placed = 0;
		for (const FTree& Tree : Trees)
		{
			double BestStretch = TNumericLimits<double>::Max();
			for (FTreeMesh& Mesh : Meshes)
			{
				if (Mesh.Kind == Tree.Kind)
				{
					BestStretch = FMath::Min(BestStretch, FMath::Abs(FMath::Loge(Tree.HeightM * 100 / Mesh.HeightCm)));
				}
			}
			TArray<FTreeMesh*> Candidates;
			for (FTreeMesh& Mesh : Meshes)
			{
				if (Mesh.Kind == Tree.Kind && FMath::Abs(FMath::Loge(Tree.HeightM * 100 / Mesh.HeightCm)) <= BestStretch + FMath::Loge(1.25))
				{
					Candidates.Add(&Mesh);
				}
			}
			if (Candidates.IsEmpty())
			{
				continue;
			}
			FRandomStream Choice(FMath::FloorToInt(Tree.YawDeg * 1000000));
			FTreeMesh* Best = Candidates[Choice.RandRange(0, Candidates.Num() - 1)];
			const FVector Foot(Tree.NorthM * 100, Tree.EastM * 100, SurfaceZ(Manifest.Tile, HeightBytes, Tree.NorthM * 100, Tree.EastM * 100));
			const double Wide = Tree.CrownRadiusM * 100 / Best->RadiusCm, Tall = Tree.HeightM * 100 / Best->HeightCm;
			const FBoxSphereBounds Bounds = Best->Asset->GetBounds();
			const FVector Origin = Foot - FVector(0, 0, (Bounds.Origin.Z - Bounds.BoxExtent.Z) * Tall);
			// Opposing axis changes preserve the measured crown's area, with modest silhouette variation.
			const double Aspect = Choice.FRandRange(0.9f, 1.1f);
			Best->Instances->AddInstance(FTransform(FRotator(0, Tree.YawDeg, 0), Origin, FVector(Wide * Aspect, Wide / Aspect, Tall)), 0, true);
			++Placed;
			if (Tree.TrunkDiameterM > 0 && Tree.CrownRatio > 0)
			{
				const double HeightCm = Tree.HeightM * 100, CrownCm = HeightCm * Tree.CrownRatio;
				Solid->AddInstance(FTransform(FRotator::ZeroRotator, Foot + FVector(0, 0, (HeightCm - CrownCm) / 2), FVector(Tree.TrunkDiameterM, Tree.TrunkDiameterM, (HeightCm - CrownCm) / 100)), true);
				Solid->AddInstance(FTransform(FRotator::ZeroRotator, Foot + FVector(0, 0, HeightCm - CrownCm / 2), FVector(Tree.CrownRadiusM * 2, Tree.CrownRadiusM * 2, CrownCm / 100)), true);
			}
		}
		return Actor;
	}

	/**
	 * Trace down onto trees spread through the inventory, against their collision alone. Returns how far the worst
	 * hit is from the tree's measured top, and counts the trees a trace passed through.
	 */
	double WorstTreeTopErrorCm(AActor* Trees, const FManifest& Manifest, const TArray64<uint8>& HeightBytes, const TArray<FTree>& Inventory, int32& Checked, int32& Missed)
	{
		UInstancedStaticMeshComponent* Solid = Trees->FindComponentByClass<UInstancedStaticMeshComponent>();
		double Worst = 0;
		Checked = Missed = 0;
		const int32 Step = FMath::Max(Inventory.Num() / TreeChecks, 1);
		for (int32 Index = 0; Index < Inventory.Num(); Index += Step)
		{
			const FTree& Tree = Inventory[Index];
			if (Tree.TrunkDiameterM <= 0 || Tree.CrownRatio <= 0)
			{
				continue;
			}
			++Checked;
			const FVector Foot(Tree.NorthM * 100, Tree.EastM * 100, SurfaceZ(Manifest.Tile, HeightBytes, Tree.NorthM * 100, Tree.EastM * 100));
			FHitResult Hit;
			// A taller neighbour's crown may reach over this tree's top, so the hit may be higher, never lower.
			if (!Solid || !Solid->LineTraceComponent(Hit, Foot + FVector(0, 0, 200000), Foot, FCollisionQueryParams()))
			{
				++Missed;
				continue;
			}
			Worst = FMath::Max(Worst, Foot.Z + Tree.HeightM * 100 - Hit.Location.Z);
		}
		return Worst;
	}

	/** The building inventory the pipeline wrote. */
	bool LoadBuildings(const FString& Path, TArray<FBuilding>& Out, FString& Error)
	{
		FString Text;
		TSharedPtr<FJsonObject> Root;
		const TArray<TSharedPtr<FJsonValue>>* Rows = nullptr;
		if (!FFileHelper::LoadFileToString(Text, *Path) || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root || !Root->TryGetArrayField(TEXT("buildings"), Rows))
		{
			Error = FString::Printf(TEXT("cannot read the building inventory %s"), *Path);
			return false;
		}
		for (const TSharedPtr<FJsonValue>& Value : *Rows)
		{
			const TSharedPtr<FJsonObject> Item = Value->AsObject();
			FBuilding& Building = Out.AddDefaulted_GetRef();
			Building.EastM = Item->GetNumberField(TEXT("east_m"));
			Building.NorthM = Item->GetNumberField(TEXT("north_m"));
			Building.HeightM = Item->GetNumberField(TEXT("height_m"));
			const TArray<TSharedPtr<FJsonValue>>& Albedo = Item->GetArrayField(TEXT("roof_albedo"));
			Building.RoofAlbedo = FLinearColor(float(Albedo[0]->AsNumber()), float(Albedo[1]->AsNumber()), float(Albedo[2]->AsNumber()));
			for (const TSharedPtr<FJsonValue>& RingValue : Item->GetArrayField(TEXT("rings")))
			{
				TArray<FVector2D>& Ring = Building.Rings.AddDefaulted_GetRef();
				for (const TSharedPtr<FJsonValue>& Point : RingValue->AsArray())
				{
					Ring.Add(FVector2D(Point->AsArray()[0]->AsNumber(), Point->AsArray()[1]->AsNumber()));
				}
			}
			for (const TSharedPtr<FJsonValue>& Triangle : Item->GetArrayField(TEXT("roof_triangles")))
			{
				const TArray<TSharedPtr<FJsonValue>>& Corners = Triangle->AsArray();
				Building.RoofTriangles.Add(FIntVector(int32(Corners[0]->AsNumber()), int32(Corners[1]->AsNumber()), int32(Corners[2]->AsNumber())));
			}
		}
		return true;
	}

	/** A building's colour is carried in two UV channels, (red, green) and (blue, unused), so it needs no texture. */
	UMaterial* MakeBuildingMaterial(float Roughness, TArray<UPackage*>& Packages)
	{
		UMaterial* Material = NewAsset<UMaterial>(TEXT("M_Building"), Packages);
		UMaterialExpressionTextureCoordinate* Uv0 = Node<UMaterialExpressionTextureCoordinate>(Material, -900, 0);
		Uv0->CoordinateIndex = 0;
		UMaterialExpressionTextureCoordinate* Uv1 = Node<UMaterialExpressionTextureCoordinate>(Material, -900, 200);
		Uv1->CoordinateIndex = 1;
		UMaterialExpressionComponentMask* RedGreen = Node<UMaterialExpressionComponentMask>(Material, -600, 0);
		RedGreen->Input.Connect(0, Uv0);
		RedGreen->R = true;
		RedGreen->G = true;
		UMaterialExpressionComponentMask* Blue = Node<UMaterialExpressionComponentMask>(Material, -600, 200);
		Blue->Input.Connect(0, Uv1);
		Blue->R = true;
		UMaterialExpressionAppendVector* Colour = Node<UMaterialExpressionAppendVector>(Material, -300, 0);
		Colour->A.Connect(0, RedGreen);
		Colour->B.Connect(0, Blue);
		UMaterialEditingLibrary::ConnectMaterialProperty(Colour, TEXT(""), MP_BaseColor);
		UMaterialExpressionConstant* Rough = Node<UMaterialExpressionConstant>(Material, -300, 200);
		Rough->R = Roughness;
		UMaterialEditingLibrary::ConnectMaterialProperty(Rough, TEXT(""), MP_Roughness);
		UMaterialEditingLibrary::RecompileMaterial(Material);
		return Material;
	}

	/**
	 * Stand every building of the inventory on the surface as a flat-roofed block: walls from a little under the
	 * ground at each footprint corner up to one roof height, a roof of the measured colour, walls of one albedo. The
	 * blocks are merged into one mesh per square of the tile, so a square is one draw and one collision body.
	 */
	TArray<AActor*> AddBuildings(UWorld* World, const FManifest& Manifest, const TArray64<uint8>& HeightBytes, TArray<FBuilding>& Buildings, UMaterial* Material, TArray<UPackage*>& Packages, int32& Placed)
	{
		constexpr double SquareM = 126;
		constexpr double SinkCm = 30;
		TMap<FIntPoint, TArray<int32>> Squares;
		for (int32 Index = 0; Index < Buildings.Num(); ++Index)
		{
			Squares.FindOrAdd(FIntPoint(FMath::FloorToInt(Buildings[Index].EastM / SquareM), FMath::FloorToInt(Buildings[Index].NorthM / SquareM))).Add(Index);
		}
		const int32 Stencil = int32(Manifest.StencilClasses->GetNumberField(TEXT("building")));
		const FLinearColor Wall(Manifest.WallAlbedo, Manifest.WallAlbedo, Manifest.WallAlbedo);
		TArray<AActor*> Actors;
		Placed = 0;
		for (const TPair<FIntPoint, TArray<int32>>& Square : Squares)
		{
			UStaticMesh* Mesh = NewAsset<UStaticMesh>(FString::Printf(TEXT("SM_Buildings_%d_%d"), Square.Key.X, Square.Key.Y), Packages);
			FMeshDescription Description;
			FStaticMeshAttributes Attributes(Description);
			Attributes.Register();
			TVertexAttributesRef<FVector3f> Positions = Attributes.GetVertexPositions();
			TVertexInstanceAttributesRef<FVector3f> Normals = Attributes.GetVertexInstanceNormals();
			TVertexInstanceAttributesRef<FVector2f> Uvs = Attributes.GetVertexInstanceUVs();
			Uvs.SetNumChannels(2);
			TPolygonGroupAttributesRef<FName> Slots = Attributes.GetPolygonGroupMaterialSlotNames();
			const FPolygonGroupID Group = Description.CreatePolygonGroup();
			Slots[Group] = FName(TEXT("Building"));
			// A mesh description's polygon faces the side its corners run counter-clockwise on, which here is the side
			// opposite (B - A) x (C - A) (the build's collision trace proves it). A triangle is turned to face its normal.
			const auto AddTriangle = [&](FVector A, FVector B, FVector C, const FVector& Normal, const FLinearColor& Colour)
			{
				if (FVector::CrossProduct(B - A, C - A).Dot(Normal) > 0)
				{
					Swap(B, C);
				}
				FVertexInstanceID Corners[3];
				const FVector* Points[3] = {&A, &B, &C};
				for (int32 Corner = 0; Corner < 3; ++Corner)
				{
					const FVertexID Vertex = Description.CreateVertex();
					Positions[Vertex] = FVector3f(*Points[Corner]);
					Corners[Corner] = Description.CreateVertexInstance(Vertex);
					Normals[Corners[Corner]] = FVector3f(Normal);
					Uvs.Set(Corners[Corner], 0, FVector2f(Colour.R, Colour.G));
					Uvs.Set(Corners[Corner], 1, FVector2f(Colour.B, 0));
				}
				Description.CreatePolygon(Group, {Corners[0], Corners[1], Corners[2]});
			};
			for (const int32 Index : Square.Value)
			{
				FBuilding& Building = Buildings[Index];
				const double AnchorZ = SurfaceZ(Manifest.Tile, HeightBytes, Building.NorthM * 100, Building.EastM * 100);
				TArray<double> Ground;
				double Highest = AnchorZ;
				for (const TArray<FVector2D>& Ring : Building.Rings)
				{
					for (const FVector2D& Point : Ring)
					{
						Ground.Add(SurfaceZ(Manifest.Tile, HeightBytes, Point.Y * 100, Point.X * 100));
						Highest = FMath::Max(Highest, Ground.Last());
					}
				}
				// On a slope the roof is a roof height over the anchor, but never under the ground at a corner.
				Building.TopCm = FMath::Max(AnchorZ + Building.HeightM * 100, Highest + 50);
				int32 First = 0;
				const auto Corner = [&](const FVector2D& Point, double Z) { return FVector(Point.Y * 100, Point.X * 100, Z); };
				for (const TArray<FVector2D>& Ring : Building.Rings)
				{
					for (int32 Point = 0; Point < Ring.Num(); ++Point)
					{
						const FVector2D& From = Ring[Point];
						const FVector2D& To = Ring[(Point + 1) % Ring.Num()];
						const FVector2D Along = To - From;
						// The solid is on the left of every ring's direction, so outside is on its right.
						const FVector Outward = FVector(-Along.X, Along.Y, 0).GetSafeNormal();
						const FVector BottomFrom = Corner(From, Ground[First + Point] - SinkCm), BottomTo = Corner(To, Ground[First + (Point + 1) % Ring.Num()] - SinkCm);
						const FVector TopFrom = Corner(From, Building.TopCm), TopTo = Corner(To, Building.TopCm);
						AddTriangle(BottomFrom, BottomTo, TopTo, Outward, Wall);
						AddTriangle(BottomFrom, TopTo, TopFrom, Outward, Wall);
					}
					First += Ring.Num();
				}
				TArray<FVector2D> Points;
				for (const TArray<FVector2D>& Ring : Building.Rings)
				{
					Points.Append(Ring);
				}
				for (const FIntVector& Triangle : Building.RoofTriangles)
				{
					AddTriangle(Corner(Points[Triangle.X], Building.TopCm), Corner(Points[Triangle.Y], Building.TopCm), Corner(Points[Triangle.Z], Building.TopCm), FVector::UpVector, Building.RoofAlbedo);
				}
				++Placed;
			}
			Mesh->GetStaticMaterials().Add(FStaticMaterial(Material, FName(TEXT("Building"))));
			UStaticMesh::FBuildMeshDescriptionsParams Params;
			Params.bBuildSimpleCollision = false;
			Params.bFastBuild = false;
			Mesh->BuildFromMeshDescriptions({&Description}, Params);
			// The engine builds a mesh on another thread and sets its body up when it ends. A building is solid to a
			// walker: its own triangles are its simple collision, so that is set once the build has finished.
			FStaticMeshCompilingManager::Get().FinishCompilation({Mesh});
			Mesh->CreateBodySetup();
			Mesh->GetBodySetup()->CollisionTraceFlag = CTF_UseComplexAsSimple;
			Mesh->GetBodySetup()->InvalidatePhysicsData();
			Mesh->GetBodySetup()->CreatePhysicsMeshes();
			AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(FVector::ZeroVector, FRotator::ZeroRotator);
			Actor->SetActorLabel(FString::Printf(TEXT("EnvGenBuildings_%d_%d"), Square.Key.X, Square.Key.Y));
			Actor->Tags.Add(EnvGenStandingTag());
			UStaticMeshComponent* Component = Actor->GetStaticMeshComponent();
			Component->SetMobility(EComponentMobility::Static);
			Component->SetStaticMesh(Mesh);
			Component->SetCollisionProfileName(TEXT("BlockAll"));
			Component->SetRenderCustomDepth(true);
			Component->SetCustomDepthStencilValue(Stencil);
			Actors.Add(Actor);
		}
		return Actors;
	}

	/**
	 * Trace down onto buildings spread through the inventory, and return how far the worst hit is from the roof the
	 * build placed, counting the traces that found no building. Trees are ignored: a crown may overhang a roof.
	 */
	double WorstBuildingTopErrorCm(UWorld* World, const FManifest& Manifest, const TArray<FBuilding>& Inventory, const AActor* Trees, int32& Checked, int32& Missed)
	{
		double Worst = 0;
		Checked = Missed = 0;
		FCollisionQueryParams Params;
		if (Trees)
		{
			Params.AddIgnoredActor(Trees);
		}
		const int32 Step = FMath::Max(Inventory.Num() / TreeChecks, 1);
		for (int32 Index = 0; Index < Inventory.Num(); Index += Step)
		{
			const FBuilding& Building = Inventory[Index];
			++Checked;
			const FVector At(Building.NorthM * 100, Building.EastM * 100, 0);
			FHitResult Hit;
			if (!World->LineTraceSingleByChannel(Hit, At + FVector(0, 0, 200000), At - FVector(0, 0, 200000), ECC_WorldStatic, Params) || !Hit.GetActor() || !Hit.GetActor()->ActorHasTag(EnvGenStandingTag()))
			{
				++Missed;
				continue;
			}
			Worst = FMath::Max(Worst, FMath::Abs(Hit.Location.Z - Building.TopCm));
		}
		return Worst;
	}

	void AddSkyAndSun(UWorld* World, const FLighting& Lighting)
	{
		// World +X is grid north and +Y is east, so a sun at azimuth A lights the ground travelling towards A + 180.
		ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector(0, 0, 20000), FRotator(-Lighting.ElevationDeg, Lighting.GridAzimuthDeg + 180.0, 0));
		Sun->SetActorLabel(TEXT("EnvGenSun"));
		Sun->GetLightComponent()->SetMobility(EComponentMobility::Movable);
		Sun->GetLightComponent()->SetIntensity(float(Lighting.SunLux));
		Cast<UDirectionalLightComponent>(Sun->GetLightComponent())->SetAtmosphereSunLight(true);

		AActor* Atmosphere = World->SpawnActor<AActor>(ASkyAtmosphere::StaticClass(), FTransform::Identity);
		Atmosphere->SetActorLabel(TEXT("EnvGenSkyAtmosphere"));

		ASkyLight* Sky = World->SpawnActor<ASkyLight>(FVector(0, 0, 20000), FRotator::ZeroRotator);
		Sky->SetActorLabel(TEXT("EnvGenSkyLight"));
		Sky->GetLightComponent()->SetMobility(EComponentMobility::Movable);
		Sky->GetLightComponent()->SetRealTimeCapture(true);

		// Exposure is fixed at the EV100 that puts mid-grey in this sun and sky at mid-grey.
		APostProcessVolume* Exposure = World->SpawnActor<APostProcessVolume>(FVector::ZeroVector, FRotator::ZeroRotator);
		Exposure->SetActorLabel(TEXT("EnvGenExposure"));
		Exposure->bUnbound = true;
		Exposure->Settings.bOverride_AutoExposureMinBrightness = true;
		Exposure->Settings.bOverride_AutoExposureMaxBrightness = true;
		Exposure->Settings.AutoExposureMinBrightness = float(Lighting.ExposureEv100);
		Exposure->Settings.AutoExposureMaxBrightness = float(Lighting.ExposureEv100);
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
	double WorstSurfaceErrorCm(UWorld* World, const FManifest& Manifest, const TArray64<uint8>& HeightBytes, const TArray<const AActor*>& Above, int32& Missed)
	{
		const uint16* Heights = reinterpret_cast<const uint16*>(HeightBytes.GetData());
		const int32 Last = Manifest.Tile.Vertices - 1;
		double Worst = 0;
		Missed = 0;
		// What stands on the ground is not the ground.
		FCollisionQueryParams Params;
		for (const AActor* Standing : Above)
		{
			if (Standing)
			{
				Params.AddIgnoredActor(Standing);
			}
		}
		for (const double* Fraction : CheckPoints)
		{
			const int32 NorthIndex = FMath::RoundToInt32(Fraction[0] * Last);
			const int32 EastIndex = FMath::RoundToInt32(Fraction[1] * Last);
			const double Expected = Manifest.Tile.LocationCm.Z + (double(Heights[EastIndex * Manifest.Tile.Vertices + NorthIndex]) - 32768.0) * Manifest.Tile.Scale.Z / 128.0;
			const FVector At(Manifest.Tile.LocationCm.X + NorthIndex * Manifest.Tile.Scale.X, Manifest.Tile.LocationCm.Y + EastIndex * Manifest.Tile.Scale.Y, 0);
			FHitResult Hit;
			if (!World->LineTraceSingleByChannel(Hit, At + FVector(0, 0, 200000), At - FVector(0, 0, 200000), ECC_WorldStatic, Params))
			{
				++Missed;
				continue;
			}
			Worst = FMath::Max(Worst, FMath::Abs(Hit.Location.Z - Expected));
		}
		return Worst;
	}

	/**
	 * Read every layer's merged weight back at the manifest's check points and compare it with what the manifest
	 * says is there. Returns the largest difference out of 255, or 255 if a layer cannot be read. A dropped,
	 * swapped or transposed weightmap fails this; so does a layer attached to the wrong file.
	 */
	int32 WorstWeightError(ALandscape* Landscape, const FManifest& Manifest)
	{
		ULandscapeInfo* Info = Landscape->GetLandscapeInfo();
		int32 Worst = 0;
		FLandscapeEditDataInterface Edit(Info);
		for (const FCheckPoint& Point : Manifest.CheckPoints)
		{
			for (const FLayer& Layer : Manifest.Layers)
			{
				ULandscapeLayerInfoObject* Merged = Info->GetLayerInfoByName(Layer.Name);
				const int32* Expected = Point.Weights.Find(Layer.Name);
				if (!Merged || !Expected)
				{
					return 255;
				}
				int32 X1 = Point.North, Y1 = Point.East, X2 = X1, Y2 = Y1;
				uint8 Weight = 0;
				Edit.GetWeightDataFast(Merged, X1, Y1, X2, Y2, &Weight, 0);
				Worst = FMath::Max(Worst, FMath::Abs(int32(Weight) - *Expected));
			}
		}
		return Worst;
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
	ALandscape* Surround = nullptr;
	TArray<FTree> Trees;
	AActor* TreeActor = nullptr;
	int32 TreesPlaced = 0;
	TArray<FBuilding> Buildings;
	TArray<AActor*> BuildingActors;
	int32 BuildingsPlaced = 0;
	int32 MaterialErrors = 0;
	float Waited = 0;
	int32 Frames = 0;
};

bool FEnvGenLevelBuild::Start(const FString& ManifestPath, const FString& MapPath, const FString& MaterialsDirectory)
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

	if (!LoadScans(MaterialsDirectory, Manifest.Layers, Error))
	{
		UE_LOG(LogEnvGen, Error, TEXT("%s"), *Error);
		return false;
	}
	TArray<FTreeMesh> TreeMeshes;
	if (!Manifest.BuildingsFile.IsEmpty() && !LoadBuildings(Manifest.Directory / Manifest.BuildingsFile, State->Buildings, Error))
	{
		UE_LOG(LogEnvGen, Error, TEXT("%s"), *Error);
		return false;
	}
	if (!Manifest.TreesFile.IsEmpty() && (!LoadTrees(Manifest.Directory / Manifest.TreesFile, State->Trees, Error) || !LoadTreeMeshes(MaterialsDirectory, TreeMeshes, Error)))
	{
		UE_LOG(LogEnvGen, Error, TEXT("%s"), *Error);
		return false;
	}
	for (FLayer& Layer : Manifest.Layers)
	{
		int32 Width = 0, Height = 0;
		if (!DecodePng(Manifest.Directory / Layer.File, ERGBFormat::Gray, 8, Layer.Weights, Width, Height) || Width != Manifest.Tile.Vertices || Height != Manifest.Tile.Vertices)
		{
			UE_LOG(LogEnvGen, Error, TEXT("%s is not a %dx%d 8-bit grey PNG"), *Layer.File, Manifest.Tile.Vertices, Manifest.Tile.Vertices);
			return false;
		}
	}
	TArray64<uint8> MacroBytes, SurroundHeightBytes, SurroundColourBytes;
	FIntPoint MacroSize(0, 0), SurroundColourSize(0, 0);
	if (!DecodeSurface(Manifest, Manifest.Tile, State->HeightBytes, MacroBytes, MacroSize))
	{
		return false;
	}
	if (Manifest.Surround && !DecodeSurface(Manifest, *Manifest.Surround, SurroundHeightBytes, SurroundColourBytes, SurroundColourSize))
	{
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

	UTexture2D* Macro = MakeTexture(TEXT("T_MacroColour"), MacroSize.X, MacroSize.Y, TSF_BGRA8, MacroBytes.GetData(), true, State->Packages);
	UTexture2D* Ratio = nullptr;
	if (!Manifest.RatioFile.IsEmpty())
	{
		TArray64<uint8> RatioBytes;
		int32 RatioWidth = 0, RatioHeight = 0;
		if (!DecodePng(Manifest.Directory / Manifest.RatioFile, ERGBFormat::BGRA, 8, RatioBytes, RatioWidth, RatioHeight))
		{
			UE_LOG(LogEnvGen, Error, TEXT("cannot decode %s"), *Manifest.RatioFile);
			return false;
		}
		// Uncompressed: block compression would put steps of about 5 % in a texture whose job is small ratios.
		Ratio = MakeTexture(TEXT("T_DetailRatio"), RatioWidth, RatioHeight, TSF_BGRA8, RatioBytes.GetData(), false, State->Packages, TC_VectorDisplacementmap);
	}
	UTexture2D* Grain = nullptr;
	if (!Manifest.GrainFile.IsEmpty())
	{
		TArray64<uint8> GrainBytes;
		int32 GrainWidth = 0, GrainHeight = 0;
		if (!DecodePng(Manifest.Directory / Manifest.GrainFile, ERGBFormat::Gray, 8, GrainBytes, GrainWidth, GrainHeight))
		{
			UE_LOG(LogEnvGen, Error, TEXT("cannot decode %s"), *Manifest.GrainFile);
			return false;
		}
		Grain = MakeTexture(TEXT("T_Grain"), GrainWidth, GrainHeight, TSF_G8, GrainBytes.GetData(), false, State->Packages, TC_Grayscale);
	}
	UTexture2D* Survey = nullptr;
	if (!Manifest.SurveyFile.IsEmpty())
	{
		TArray64<uint8> SurveyBytes;
		int32 SurveyWidth = 0, SurveyHeight = 0;
		if (!DecodePng(Manifest.Directory / Manifest.SurveyFile, ERGBFormat::Gray, 8, SurveyBytes, SurveyWidth, SurveyHeight))
		{
			UE_LOG(LogEnvGen, Error, TEXT("cannot decode %s"), *Manifest.SurveyFile);
			return false;
		}
		// A virtual texture: at a centimetre a pixel the file is hundreds of megabytes, and only the pages in view are resident.
		Survey = MakeTexture(TEXT("T_SurveyDetail"), SurveyWidth, SurveyHeight, TSF_G8, SurveyBytes.GetData(), false, State->Packages, TC_Grayscale, true);
	}
	UTexture2D* OrthoMasks = nullptr;
	UTexture2D* OrthoColour = nullptr;
	UTexture2D* FallbackWeights = nullptr;
	if (!Manifest.OrthoMasksFile.IsEmpty())
	{
		TArray64<uint8> Bytes;
		int32 Width = 0, Height = 0;
		if (!DecodePng(Manifest.Directory / Manifest.OrthoMasksFile, ERGBFormat::BGRA, 8, Bytes, Width, Height))
		{
			UE_LOG(LogEnvGen, Error, TEXT("cannot decode %s"), *Manifest.OrthoMasksFile);
			return false;
		}
		OrthoMasks = MakeTexture(TEXT("T_OrthoMasks"), Width, Height, TSF_BGRA8, Bytes.GetData(), false, State->Packages, TC_VectorDisplacementmap, true);
		if (!DecodePng(Manifest.Directory / Manifest.OrthoColourFile, ERGBFormat::BGRA, 8, Bytes, Width, Height))
		{
			UE_LOG(LogEnvGen, Error, TEXT("cannot decode %s"), *Manifest.OrthoColourFile);
			return false;
		}
		OrthoColour = MakeTexture(TEXT("T_OrthoColour"), Width, Height, TSF_BGRA8, Bytes.GetData(), true, State->Packages);
		if (Manifest.FallbackWeightsFile.IsEmpty() || !DecodePng(Manifest.Directory / Manifest.FallbackWeightsFile, ERGBFormat::BGRA, 8, Bytes, Width, Height))
		{
			UE_LOG(LogEnvGen, Error, TEXT("native masks need original fallback weights: rebuild the pipeline"));
			return false;
		}
		FallbackWeights = MakeTexture(TEXT("T_SurfaceFallback"), Width, Height, TSF_BGRA8, Bytes.GetData(), false, State->Packages, TC_VectorDisplacementmap);
	}
	const TArray<uint8> Noise = DetailNoise();
	UTexture2D* Detail = MakeTexture(TEXT("T_Detail"), DetailPixels, DetailPixels, TSF_G8, Noise.GetData(), false, State->Packages);
	for (FLayer& Layer : Manifest.Layers)
	{
		const FString Name = Layer.Name.ToString();
		const FScan& Scan = Layer.Scan;
		Layer.Colour = MakeTexture(TEXT("T_") + Name + TEXT("_Colour"), Scan.Width, Scan.Height, TSF_BGRA8, Scan.Colour.GetData(), true, State->Packages);
		Layer.Normal = MakeTexture(TEXT("T_") + Name + TEXT("_Normal"), Scan.Width, Scan.Height, TSF_BGRA8, Scan.Normal.GetData(), false, State->Packages, TC_Normalmap);
		Layer.Rough = MakeTexture(TEXT("T_") + Name + TEXT("_Rough"), Scan.Width, Scan.Height, TSF_G8, Scan.Rough.GetData(), false, State->Packages);
		Layer.Relief = MakeTexture(TEXT("T_") + Name + TEXT("_Relief"), Scan.Width, Scan.Height, TSF_G8, Scan.Relief.GetData(), false, State->Packages);
	}
	UTexture2D* Growth = nullptr;
	if (!Manifest.Turf.GrowthFile.IsEmpty())
	{
		TArray64<uint8> Bytes;
		int32 Width = 0, Height = 0;
		if (!DecodePng(Manifest.Directory / Manifest.Turf.GrowthFile, ERGBFormat::BGRA, 8, Bytes, Width, Height))
		{
			UE_LOG(LogEnvGen, Error, TEXT("cannot decode %s"), *Manifest.Turf.GrowthFile);
			return false;
		}
		Growth = MakeTexture(TEXT("T_TurfGrowth"), Width, Height, TSF_BGRA8, Bytes.GetData(), false, State->Packages, TC_VectorDisplacementmap);
	}
	TArray<ULandscapeGrassType*> GrassTypes;
	if (Manifest.Layers.ContainsByPredicate([](const FLayer& Layer) { return Layer.Name == GrassLayer; }))
	{
		if (Manifest.Turf.Varieties.IsEmpty() || !Growth)
		{
			UE_LOG(LogEnvGen, Error, TEXT("the manifest has a grass class and no turf or growth map: rebuild the pipeline"));
			return false;
		}
		for (int32 Index = 0; Index < Manifest.Turf.Varieties.Num(); ++Index)
		{
			const FTuftVariety& Tuft = Manifest.Turf.Varieties[Index];
			ULandscapeGrassType* GrassType = NewAsset<ULandscapeGrassType>(TEXT("LGT_Grass_") + Tuft.Name.ToString(), State->Packages);
			GrassTypes.Add(GrassType);
			FGrassVariety& Variety = GrassType->GrassVarieties.AddDefaulted_GetRef();
			Variety.GrassMesh = MakeGrassTuft(MakeBladeMaterial(Macro, Growth, Manifest, Tuft, State->Packages), Tuft, Manifest.Turf.BladeColours, Index, State->Packages);
			Variety.GrassDensity = FPerPlatformFloat(Tuft.DensityPer100M2);
			Variety.StartCullDistance = FPerPlatformInt(Tuft.StartCullCm);
			Variety.EndCullDistance = FPerPlatformInt(Tuft.EndCullCm);
			Variety.InstanceWorldPositionOffsetDisableDistance = 2500;
			Variety.Scaling = EGrassScaling::Uniform;
			Variety.ScaleX = FFloatInterval(Tuft.ScaleMin, Tuft.ScaleMax);
			Variety.bCastDynamicShadow = Tuft.bCastsShadow;
			Variety.RandomRotation = true;
			Variety.AlignToSurface = true;
		}
	}
	UMaterial* Material = MakeGroundMaterial(Macro, Ratio, Survey, OrthoMasks, OrthoColour, FallbackWeights, Grain, Manifest, Detail, Growth, Manifest.Tile.Vertices - 1, Manifest.Tile.Scale.X, Manifest.AlbedoScale, Manifest.Layers, GrassTypes, State->Packages);
	for (FLayer& Layer : Manifest.Layers)
	{
		Layer.Info = NewAsset<ULandscapeLayerInfoObject>(TEXT("LI_") + Layer.Name.ToString(), State->Packages);
		Layer.Info->SetLayerName(Layer.Name, false);
	}

	const int32 GroundStencil = int32(Manifest.StencilClasses->GetNumberField(TEXT("ground")));
	State->Landscape = ImportLandscape(State->World, TEXT("EnvGenLandscape"), Manifest.Tile, State->HeightBytes, Material, GroundStencil, Manifest.Layers);
	if (Manifest.Surround)
	{
		UTexture2D* SurroundColour = MakeTexture(TEXT("T_SurroundColour"), SurroundColourSize.X, SurroundColourSize.Y, TSF_BGRA8, SurroundColourBytes.GetData(), true,
			State->Packages);
		UMaterial* SurroundMaterial = MakeSurroundMaterial(SurroundColour, Manifest.Surround->Vertices - 1, Manifest.AlbedoScale, State->Packages);
		State->Surround = ImportLandscape(State->World, TEXT("EnvGenSurround"), *Manifest.Surround, SurroundHeightBytes, SurroundMaterial, GroundStencil, TArray<FLayer>());
	}
	if (Manifest.Surround)
	{
		AddHorizon(State->World, *Manifest.Surround, SurroundHeightBytes, SurroundColourBytes, Manifest.AlbedoScale, State->Packages);
	}
	else
	{
		AddHorizon(State->World, Manifest.Tile, State->HeightBytes, MacroBytes, Manifest.AlbedoScale, State->Packages);
	}
	if (!State->Trees.IsEmpty())
	{
		State->TreeActor = AddTrees(State->World, Manifest, State->HeightBytes, State->Trees, TreeMeshes, State->TreesPlaced);
	}
	if (!State->Buildings.IsEmpty())
	{
		UMaterial* BuildingMaterial = MakeBuildingMaterial(Manifest.RoofRoughness, State->Packages);
		State->BuildingActors = AddBuildings(State->World, Manifest, State->HeightBytes, State->Buildings, BuildingMaterial, State->Packages, State->BuildingsPlaced);
	}
	AddSkyAndSun(State->World, Manifest.Lighting);
	AddSiteInfo(State->World, Manifest);
	APlayerStart* PlayerStart = State->World->SpawnActor<APlayerStart>(FVector(0, 0, 150), FRotator::ZeroRotator);
	PlayerStart->SetActorLabel(TEXT("EnvGenPlayerStart"));
	State->World->GetWorldSettings()->DefaultGameMode = AEnvGenGameMode::StaticClass();
	for (UPackage* Package : State->Packages)
	{
		ForEachObjectWithPackage(Package, [&](UObject* Object)
		{
			if (UMaterial* Generated = Cast<UMaterial>(Object))
			{
				State->MaterialErrors += CompileErrors(Generated);
			}
			return true;
		});
	}
	return true;
}

bool FEnvGenLevelBuild::Finish(float DeltaSeconds, bool& bSucceeded)
{
	State->Waited += DeltaSeconds;
	++State->Frames;
	const bool bMerged = State->Frames > MinMergeFrames && State->Landscape->IsUpToDate() && (!State->Surround || State->Surround->IsUpToDate());
	if (!bMerged && State->Waited < MergeTimeoutSeconds)
	{
		return false;
	}

	const FManifest& Manifest = State->Manifest;
	int32 Missed = 0;
	TArray<const AActor*> Standing;
	Standing.Add(State->TreeActor);
	Standing.Append(State->BuildingActors);
	const double WorstCm = WorstSurfaceErrorCm(State->World, Manifest, State->HeightBytes, Standing, Missed);
	const int32 Components = State->Landscape->LandscapeComponents.Num();
	const int32 TargetLayers = State->Landscape->GetTargetLayers().Num();
	const int32 WeightError = WorstWeightError(State->Landscape, Manifest);
	const bool bSurfaceOk = Missed == 0 && WorstCm <= SurfaceToleranceCm;
	const bool bWeightsOk = TargetLayers == Manifest.Layers.Num() && WeightError <= WeightTolerance;
	int32 TreesChecked = 0, TreesMissed = 0;
	const double TreeTopCm = State->TreeActor ? WorstTreeTopErrorCm(State->TreeActor, Manifest, State->HeightBytes, State->Trees, TreesChecked, TreesMissed) : 0;
	const bool bTreesOk = State->TreesPlaced == State->Trees.Num() && TreesMissed == 0 && TreeTopCm <= SurfaceToleranceCm;
	int32 BuildingsChecked = 0, BuildingsMissed = 0;
	const double BuildingTopCm = State->Buildings.IsEmpty() ? 0 : WorstBuildingTopErrorCm(State->World, Manifest, State->Buildings, State->TreeActor, BuildingsChecked, BuildingsMissed);
	const bool bBuildingsOk = State->BuildingsPlaced == State->Buildings.Num() && BuildingsMissed == 0 && BuildingTopCm <= SurfaceToleranceCm;
	const bool bSaved = UEditorLoadingAndSavingUtils::SavePackages(State->Packages, false) && UEditorLoadingAndSavingUtils::SaveMap(State->World, State->MapPath);
	const bool bMaterialsOk = State->MaterialErrors == 0;
	bSucceeded = bMerged && bSurfaceOk && bWeightsOk && bMaterialsOk && bTreesOk && bBuildingsOk && bSaved;

	TSharedRef<FJsonObject> Receipt = MakeShared<FJsonObject>();
	Receipt->SetStringField(TEXT("map"), State->MapPath);
	Receipt->SetStringField(TEXT("engine"), FEngineVersion::Current().ToString());
	Receipt->SetNumberField(TEXT("landscape_components"), Components);
	Receipt->SetNumberField(TEXT("surround_components"), State->Surround ? State->Surround->LandscapeComponents.Num() : 0);
	Receipt->SetBoolField(TEXT("edit_layers_merged"), bMerged);
	Receipt->SetNumberField(TEXT("merge_seconds"), State->Waited);
	Receipt->SetNumberField(TEXT("surface_points_missed"), Missed);
	Receipt->SetNumberField(TEXT("surface_worst_error_cm"), WorstCm);
	Receipt->SetNumberField(TEXT("surface_tolerance_cm"), SurfaceToleranceCm);
	Receipt->SetBoolField(TEXT("surface_ok"), bSurfaceOk);
	Receipt->SetNumberField(TEXT("target_layers"), TargetLayers);
	Receipt->SetNumberField(TEXT("weights_worst_error"), WeightError);
	Receipt->SetNumberField(TEXT("weights_tolerance"), WeightTolerance);
	Receipt->SetBoolField(TEXT("weights_ok"), bWeightsOk);
	Receipt->SetNumberField(TEXT("material_compile_errors"), State->MaterialErrors);
	Receipt->SetBoolField(TEXT("materials_ok"), bMaterialsOk);
	Receipt->SetNumberField(TEXT("trees_in_inventory"), State->Trees.Num());
	Receipt->SetNumberField(TEXT("trees_placed"), State->TreesPlaced);
	Receipt->SetNumberField(TEXT("trees_traced"), TreesChecked);
	Receipt->SetNumberField(TEXT("trees_traces_missed"), TreesMissed);
	Receipt->SetNumberField(TEXT("tree_top_worst_shortfall_cm"), TreeTopCm);
	Receipt->SetBoolField(TEXT("trees_ok"), bTreesOk);
	Receipt->SetNumberField(TEXT("buildings_in_inventory"), State->Buildings.Num());
	Receipt->SetNumberField(TEXT("buildings_placed"), State->BuildingsPlaced);
	Receipt->SetNumberField(TEXT("buildings_traced"), BuildingsChecked);
	Receipt->SetNumberField(TEXT("buildings_traces_missed"), BuildingsMissed);
	Receipt->SetNumberField(TEXT("building_top_worst_error_cm"), BuildingTopCm);
	Receipt->SetBoolField(TEXT("buildings_ok"), bBuildingsOk);
	Receipt->SetBoolField(TEXT("saved"), bSaved);
	Receipt->SetBoolField(TEXT("succeeded"), bSucceeded);
	FString Json;
	FJsonSerializer::Serialize(Receipt, TJsonWriterFactory<>::Create(&Json));
	FFileHelper::SaveStringToFile(Json, *(FPaths::ProjectSavedDir() / TEXT("EnvGen") / TEXT("build_receipt.json")));

	UE_LOG(LogEnvGen, Display, TEXT("%s: %d components, merged=%d, surface worst error %.2f cm (%d missed), %d layers with worst weight error %d of 255, saved=%d"), *State->MapPath,
		Components, bMerged, WorstCm, Missed, TargetLayers, WeightError, bSaved);
	if (!bSucceeded)
	{
		UE_LOG(LogEnvGen, Error, TEXT("the level build failed its checks; see Saved/EnvGen/build_receipt.json"));
	}
	return true;
}
