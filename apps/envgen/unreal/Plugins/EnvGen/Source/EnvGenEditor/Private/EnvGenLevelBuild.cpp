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
#include "Materials/MaterialExpressionComponentMask.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Materials/MaterialExpressionDivide.h"
#include "Materials/MaterialExpressionLandscapeLayerBlend.h"
#include "Materials/MaterialExpressionLandscapeGrassOutput.h"
#include "Materials/MaterialExpressionLandscapeLayerCoords.h"
#include "Materials/MaterialExpressionLandscapeLayerSample.h"
#include "Materials/MaterialExpressionLinearInterpolate.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Materials/MaterialExpressionObjectPositionWS.h"
#include "Materials/MaterialExpressionPerInstanceRandom.h"
#include "Materials/MaterialExpressionPower.h"
#include "Materials/MaterialExpressionSmoothStep.h"
#include "Materials/MaterialExpressionVertexColor.h"
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
	constexpr float EdgeSharpness = 0.12f;
	constexpr float ReliefInfluence = 0.15f;
	// Grass: a tuft of blades, so many tufts per 100 square metres, drawn out to this far. The blade height is the
	// summer mowing height a land-grant university extension guide gives cool-season lawn turf, 3 to 4 inches (publications MG10, G6705).
	// Density, blade count, radius and the tuft-to-tuft size spread have no source: looks.
	constexpr int32 TuftBlades = 14;
	constexpr float TuftRadiusCm = 9.f;
	constexpr float BladeHeightMinCm = 7.6f, BladeHeightMaxCm = 10.2f;
	constexpr float TuftScaleMin = 0.85f, TuftScaleMax = 1.15f;
	constexpr float GrassDensityPer100M2 = 2000.f;
	constexpr int32 GrassStartCullCm = 2500, GrassEndCullCm = 4500;
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

	/** One tree of the inventory: where it stands from the tile centre, and its measured size. */
	struct FTree
	{
		double EastM = 0, NorthM = 0, HeightM = 0, CrownRadiusM = 0, YawDeg = 0;
		// From the species' inventory records; without them the trunk and crown have no collision.
		double TrunkDiameterM = 0, CrownRatio = 0;
		FName Kind;
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
		// The photo's fine detail as a ratio to the macro colour: file, and how 8 bits map to a power of two.
		FString RatioFile;
		double RatioLog2Range = 1, RatioZero = 127;
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
		const TSharedPtr<FJsonObject>* Trees = nullptr;
		if (Root->TryGetObjectField(TEXT("trees"), Trees))
		{
			Out.TreesFile = (*Trees)->GetStringField(TEXT("file"));
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
		TextureCompressionSettings Compression = TC_MAX)
	{
		UTexture2D* Texture = NewAsset<UTexture2D>(Name, Packages);
		Texture->Source.Init(Width, Height, 1, 1, Format, Pixels);
		Texture->SRGB = bSrgb;
		Texture->CompressionSettings = Compression != TC_MAX ? Compression : (Format == TSF_G8 ? TC_Grayscale : TC_Default);
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
	UStaticMesh* MakeGrassTuft(UMaterial* Material, TArray<UPackage*>& Packages)
	{
		UStaticMesh* Mesh = NewAsset<UStaticMesh>(TEXT("SM_GrassTuft"), Packages);
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
		FRandomStream Random(7);
		constexpr int32 Segments = 4;
		for (int32 Blade = 0; Blade < TuftBlades; ++Blade)
		{
			const float Around = Random.FRand() * 2 * PI;
			const FVector2f Root = FVector2f(FMath::Cos(Around), FMath::Sin(Around)) * Random.FRand() * TuftRadiusCm;
			const float Facing = Random.FRand() * 2 * PI;
			const FVector2f Along(FMath::Cos(Facing), FMath::Sin(Facing)), Across(-Along.Y, Along.X);
			const float Height = Random.FRandRange(BladeHeightMinCm, BladeHeightMaxCm);
			const float Width = Random.FRandRange(0.4f, 0.7f);
			const float Lean = Random.FRandRange(0.2f, 0.6f) * Height;
			// Left and right edge vertices per level, and one at the tip.
			TArray<FVertexInstanceID> Left, Right;
			FVertexInstanceID Tip;
			const auto Add = [&](float T, float Side)
			{
				const FVector2f Plan = Root + Along * (Lean * T * T) + Across * (Side * Width * (1.f - T));
				const FVertexID Vertex = Description.CreateVertex();
				Positions[Vertex] = FVector3f(Plan.X, Plan.Y, Height * T);
				const FVertexInstanceID Instance = Description.CreateVertexInstance(Vertex);
				Normals[Instance] = FVector3f(0, 0, 1);
				Uvs[Instance] = FVector2f(Side * 0.5f + 0.5f, T);
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
	UMaterial* MakeBladeMaterial(const FLinearColor& MeanPhotoColour, float AlbedoScale, TArray<UPackage*>& Packages)
	{
		UMaterial* Material = NewAsset<UMaterial>(TEXT("M_GrassBlade"), Packages);
		Material->TwoSided = true;
		Material->bUsedWithInstancedStaticMeshes = true;
		UMaterialExpressionConstant3Vector* Albedo = Node<UMaterialExpressionConstant3Vector>(Material, -500, 0);
		Albedo->Constant = MeanPhotoColour * AlbedoScale;

		// The mesh's vertex colour is how far up the blade the point is: 0 at the root, 1 at the tip.
		UMaterialExpressionVertexColor* Along = Node<UMaterialExpressionVertexColor>(Material, -800, 400);
		UMaterialExpressionLinearInterpolate* Shade = Node<UMaterialExpressionLinearInterpolate>(Material, -650, 400);
		Shade->ConstA = 0.7f;
		Shade->ConstB = 1.3f;
		Shade->Alpha.Connect(1, Along);
		UMaterialExpressionPerInstanceRandom* Random = Node<UMaterialExpressionPerInstanceRandom>(Material, -800, 550);
		UMaterialExpressionLinearInterpolate* Tuft = Node<UMaterialExpressionLinearInterpolate>(Material, -650, 550);
		Tuft->ConstA = 0.85f;
		Tuft->ConstB = 1.15f;
		Tuft->Alpha.Connect(0, Random);
		UMaterialExpressionMultiply* Lit = Node<UMaterialExpressionMultiply>(Material, -350, 100);
		Lit->A.Connect(0, Albedo);
		Lit->B.Connect(0, Shade);
		UMaterialExpressionMultiply* Colour = Node<UMaterialExpressionMultiply>(Material, -200, 100);
		Colour->A.Connect(0, Lit);
		Colour->B.Connect(0, Tuft);
		// Thin blades pass light: lit from behind they glow with their own colour rather than going black.
		Material->SetShadingModel(MSM_DefaultLit);
		UMaterialEditingLibrary::ConnectMaterialProperty(Colour, TEXT(""), MP_BaseColor);
		// Lit as the ground under it: a two-sided blade's normal turns over on the side the camera sees, and a blade seen
		// from the back would take no sun. A world-space up normal does not turn over.
		Material->bTangentSpaceNormal = false;
		UMaterialExpressionConstant3Vector* Up = Node<UMaterialExpressionConstant3Vector>(Material, -200, 200);
		Up->Constant = FLinearColor(0, 0, 1);
		UMaterialEditingLibrary::ConnectMaterialProperty(Up, TEXT(""), MP_Normal);
		UMaterialExpressionConstant* Roughness = Node<UMaterialExpressionConstant>(Material, -200, 300);
		Roughness->R = 0.75f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Roughness, TEXT(""), MP_Roughness);
		UMaterialEditingLibrary::RecompileMaterial(Material);
		return Material;
	}

	/**
	 * The ground: per class a scanned material, blended where classes meet. Evidence sets the colour that varies
	 * over tens of metres (the macro colour map times the fitted albedo scale) and, when the build has one, what the
	 * photo shows finer than that (the ratio map: rows, tracks, markings, patches). The scan adds everything finer
	 * still: its colour divided by its own mean, so it never shifts the colour. Each scan is read at two scales and
	 * turns, mixed by broad noise, so the repeat does not show from the air. The class weights are cut to a sharp
	 * edge where they cross one half, so an edge is as crisp as the photo's rather than as wide as a weightmap texel.
	 */
	UMaterial* MakeGroundMaterial(UTexture2D* Macro, UTexture2D* Ratio, const FManifest& Manifest, UTexture2D* Detail, int32 Quads, double QuadCm, float AlbedoScale,
		const TArray<FLayer>& Layers, ULandscapeGrassType* GrassType, TArray<UPackage*>& Packages)
	{
		UMaterial* Material = NewAsset<UMaterial>(TEXT("M_Ground"), Packages);
		UMaterialExpressionMultiply* MacroAlbedo = Node<UMaterialExpressionMultiply>(Material, -700, 0);
		MacroAlbedo->A.Connect(0, Sample(Material, Macro, Quads, SAMPLERTYPE_Color, 0));
		MacroAlbedo->ConstB = AlbedoScale;
		UMaterialExpression* Base = MacroAlbedo;
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
			UMaterialExpressionMultiply* WithFine = Node<UMaterialExpressionMultiply>(Material, -600, 0);
			WithFine->A.Connect(0, MacroAlbedo);
			WithFine->B.Connect(0, Fine);
			Base = WithFine;
		}
		UMaterialExpressionTextureSample* MixNoise = Sample(Material, Detail, 1100.0 / QuadCm, SAMPLERTYPE_LinearGrayscale, 250);
		const auto Mix = [&](UMaterialExpression* A, UMaterialExpression* B, int32 X, int32 Y)
		{
			UMaterialExpressionLinearInterpolate* Out = Node<UMaterialExpressionLinearInterpolate>(Material, X, Y);
			Out->A.Connect(0, A);
			Out->B.Connect(0, B);
			Out->Alpha.Connect(1, MixNoise);
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
		int32 Row = 0;
		for (const FLayer& Layer : Layers)
		{
			const float Repeat = float(Layer.Scan.SizeCm / QuadCm);
			const int32 Y = 1000 + Row * 1500;
			UMaterialExpressionTextureSample* ColourNear = Sample(Material, Layer.Colour, Repeat, SAMPLERTYPE_Color, Y);
			UMaterialExpressionTextureSample* ColourFar = Sample(Material, Layer.Colour, Repeat * 2.3f, SAMPLERTYPE_Color, Y + 250, 31.f);
			UMaterialExpressionConstant3Vector* Mean = Node<UMaterialExpressionConstant3Vector>(Material, -500, Y);
			Mean->Constant = Layer.Scan.MeanColour;
			UMaterialExpressionDivide* Structure = Node<UMaterialExpressionDivide>(Material, -300, Y);
			Structure->A.Connect(0, Mix(ColourNear, ColourFar, -400, Y));
			Structure->B.Connect(0, Mean);
			UMaterialExpressionMultiply* Albedo = Node<UMaterialExpressionMultiply>(Material, -200, Y);
			Albedo->A.Connect(0, Base);
			Albedo->B.Connect(0, Structure);

			UMaterialExpressionTextureSample* NormalNear = Sample(Material, Layer.Normal, Repeat, SAMPLERTYPE_Normal, Y + 500);
			UMaterialExpressionTextureSample* RoughNear = Sample(Material, Layer.Rough, Repeat, SAMPLERTYPE_LinearGrayscale, Y + 750);
			UMaterialExpressionTextureSample* RoughFar = Sample(Material, Layer.Rough, Repeat * 2.3f, SAMPLERTYPE_LinearGrayscale, Y + 1000, 31.f);
			UMaterialExpressionTextureSample* Relief = Sample(Material, Layer.Relief, Repeat, SAMPLERTYPE_LinearGrayscale, Y + 1250);

			// This class's weight, moved a little by its relief, cut to a sharp edge at one half.
			UMaterialExpressionLandscapeLayerSample* Weight = Node<UMaterialExpressionLandscapeLayerSample>(Material, 0, Y);
			Weight->ParameterName = Layer.Name;
			Weight->PreviewWeight = Row == 0 ? 1 : 0;
			UMaterialExpressionAdd* Lifted = Node<UMaterialExpressionAdd>(Material, 100, Y);
			UMaterialExpressionMultiply* ReliefShift = Node<UMaterialExpressionMultiply>(Material, 0, Y + 100);
			ReliefShift->A.Connect(0, Relief);
			ReliefShift->ConstB = ReliefInfluence;
			Lifted->A.Connect(0, Weight);
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
			Floor->A.Connect(0, Weight);
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
			++Row;
		}
		UMaterialExpressionDivide* Colour = Node<UMaterialExpressionDivide>(Material, 500, 0);
		Colour->A.Connect(0, ColourSum);
		Colour->B.Connect(0, WeightSum);
		UMaterialExpressionDivide* Normal = Node<UMaterialExpressionDivide>(Material, 500, 300);
		Normal->A.Connect(0, NormalSum);
		Normal->B.Connect(0, WeightSum);
		UMaterialExpressionDivide* Rough = Node<UMaterialExpressionDivide>(Material, 500, 600);
		Rough->A.Connect(0, RoughSum);
		Rough->B.Connect(0, WeightSum);
		if (GrassType)
		{
			// Where the grass class has weight, the engine grows tufts of the grass type.
			UMaterialExpressionLandscapeLayerSample* Weight = Node<UMaterialExpressionLandscapeLayerSample>(Material, 0, 900);
			Weight->ParameterName = GrassLayer;
			Weight->PreviewWeight = 1;
			UMaterialExpressionLandscapeGrassOutput* Output = Node<UMaterialExpressionLandscapeGrassOutput>(Material, 300, 900);
			Output->GrassTypes.Empty();
			FGrassInput& Input = Output->GrassTypes.AddDefaulted_GetRef();
			Input.Name = FName(TEXT("Grass"));
			Input.GrassType = GrassType;
			Input.Input.Connect(0, Weight);
		}
		UMaterialEditingLibrary::ConnectMaterialProperty(Colour, TEXT(""), MP_BaseColor);
		UMaterialEditingLibrary::ConnectMaterialProperty(Normal, TEXT(""), MP_Normal);
		UMaterialEditingLibrary::ConnectMaterialProperty(Rough, TEXT(""), MP_Roughness);
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
				Mesh.HeightCm = Bounds.Origin.Z + Bounds.BoxExtent.Z;
				Mesh.RadiusCm = (Bounds.BoxExtent.X + Bounds.BoxExtent.Y) / 2;
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
	 * of its kind that needs the least stretching. The meshes are instanced, cast shadows, and carry the tree
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
			FTreeMesh* Best = nullptr;
			for (FTreeMesh& Mesh : Meshes)
			{
				const auto Stretch = [&](const FTreeMesh& Of) { return FMath::Abs(FMath::Loge(Tree.HeightM * 100 / Of.HeightCm)); };
				if (Mesh.Kind == Tree.Kind && (!Best || Stretch(Mesh) < Stretch(*Best)))
				{
					Best = &Mesh;
				}
			}
			if (!Best)
			{
				continue;
			}
			const FVector Foot(Tree.NorthM * 100, Tree.EastM * 100, SurfaceZ(Manifest.Tile, HeightBytes, Tree.NorthM * 100, Tree.EastM * 100));
			const double Wide = Tree.CrownRadiusM * 100 / Best->RadiusCm, Tall = Tree.HeightM * 100 / Best->HeightCm;
			Best->Instances->AddInstance(FTransform(FRotator(0, Tree.YawDeg, 0), Foot, FVector(Wide, Wide, Tall)), 0, true);
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
	double WorstSurfaceErrorCm(UWorld* World, const FManifest& Manifest, const TArray64<uint8>& HeightBytes, const AActor* Above, int32& Missed)
	{
		const uint16* Heights = reinterpret_cast<const uint16*>(HeightBytes.GetData());
		const int32 Last = Manifest.Tile.Vertices - 1;
		double Worst = 0;
		Missed = 0;
		// What stands on the ground is not the ground.
		FCollisionQueryParams Params;
		if (Above)
		{
			Params.AddIgnoredActor(Above);
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
		Ratio = MakeTexture(TEXT("T_DetailRatio"), RatioWidth, RatioHeight, TSF_BGRA8, RatioBytes.GetData(), false, State->Packages);
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
	ULandscapeGrassType* GrassType = nullptr;
	if (Manifest.Layers.ContainsByPredicate([](const FLayer& Layer) { return Layer.Name == GrassLayer; }))
	{
		GrassType = NewAsset<ULandscapeGrassType>(TEXT("LGT_Grass"), State->Packages);
		FGrassVariety& Variety = GrassType->GrassVarieties.AddDefaulted_GetRef();
		Variety.GrassMesh = MakeGrassTuft(MakeBladeMaterial(Manifest.Layers[Manifest.Layers.IndexOfByPredicate([](const FLayer& Layer) { return Layer.Name == GrassLayer; })].MeanColour, Manifest.AlbedoScale, State->Packages), State->Packages);
		Variety.GrassDensity = FPerPlatformFloat(GrassDensityPer100M2);
		Variety.StartCullDistance = FPerPlatformInt(GrassStartCullCm);
		Variety.EndCullDistance = FPerPlatformInt(GrassEndCullCm);
		Variety.Scaling = EGrassScaling::Uniform;
		Variety.ScaleX = FFloatInterval(TuftScaleMin, TuftScaleMax);
		Variety.RandomRotation = true;
		Variety.AlignToSurface = true;
	}
	UMaterial* Material = MakeGroundMaterial(Macro, Ratio, Manifest, Detail, Manifest.Tile.Vertices - 1, Manifest.Tile.Scale.X, Manifest.AlbedoScale, Manifest.Layers, GrassType, State->Packages);
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
	const double WorstCm = WorstSurfaceErrorCm(State->World, Manifest, State->HeightBytes, State->TreeActor, Missed);
	const int32 Components = State->Landscape->LandscapeComponents.Num();
	const int32 TargetLayers = State->Landscape->GetTargetLayers().Num();
	const int32 WeightError = WorstWeightError(State->Landscape, Manifest);
	const bool bSurfaceOk = Missed == 0 && WorstCm <= SurfaceToleranceCm;
	const bool bWeightsOk = TargetLayers == Manifest.Layers.Num() && WeightError <= WeightTolerance;
	int32 TreesChecked = 0, TreesMissed = 0;
	const double TreeTopCm = State->TreeActor ? WorstTreeTopErrorCm(State->TreeActor, Manifest, State->HeightBytes, State->Trees, TreesChecked, TreesMissed) : 0;
	const bool bTreesOk = State->TreesPlaced == State->Trees.Num() && TreesMissed == 0 && TreeTopCm <= SurfaceToleranceCm;
	const bool bSaved = UEditorLoadingAndSavingUtils::SavePackages(State->Packages, false) && UEditorLoadingAndSavingUtils::SaveMap(State->World, State->MapPath);
	const bool bMaterialsOk = State->MaterialErrors == 0;
	bSucceeded = bMerged && bSurfaceOk && bWeightsOk && bMaterialsOk && bTreesOk && bSaved;

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
