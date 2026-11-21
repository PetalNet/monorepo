#include "EnvGenStreetscape.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Components/StaticMeshComponent.h"
#include "Components/DecalComponent.h"
#include "Engine/DecalActor.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Landscape.h"
#include "LandscapeGrassType.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionTextureObject.h"
#include "Materials/MaterialExpressionTextureSample.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionLandscapeGrassOutput.h"
#include "MeshDescription.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "StaticMeshAttributes.h"
#include "StaticMeshResources.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FEnvGenStreetscapeMalformed, "EnvGen.Streetscape.MalformedGeometry",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FEnvGenStreetscapeMalformed::RunTest(const FString& Parameters)
{
	const FString Directory = FPaths::ProjectSavedDir() / TEXT("Automation/Streetscape");
	IFileManager::Get().MakeDirectory(*Directory, true);
	const FString ManifestPath = Directory / TEXT("build.json");
	FFileHelper::SaveStringToFile(TEXT("{\"streetscape\":{\"file\":\"geometry.json\"},\"stencil_classes\":{\"ground\":1,\"road\":5,\"prop\":8,\"marking\":9}}"), *ManifestPath);
	const TArray<FString> BadRows = {
		TEXT("null"),
		TEXT("{\"material\":\"asphalt\",\"vertices\":[[0,0]],\"triangles\":[[0,0,0]],\"collision\":false}"),
		TEXT("{\"material\":\"asphalt\",\"vertices\":[[0,0,0]],\"triangles\":[[0,0,0]],\"collision\":false,\"anchor_m\":null}"),
		TEXT("{\"material\":\"asphalt\",\"vertices\":[[0,0,0]],\"triangles\":[[0.5,0,0]],\"collision\":false}"),
		TEXT("{\"material\":\"asphalt\",\"vertices\":[[0,0,0]],\"triangles\":[[\"bad\",0,0]],\"collision\":false}"),
		TEXT("{\"material\":\"asphalt\",\"vertices\":[[0,0,0]],\"triangles\":[],\"collision\":false}"),
		TEXT("{\"material\":\"asphalt\",\"vertices\":[[0,0,0]],\"triangles\":[[0,0,0]],\"collision\":false}")
	};
	const FString ValidRow = TEXT("{\"material\":\"asphalt\",\"vertices\":[[0,0,0.04],[1,0,0.04],[0,1,0.04]],\"triangles\":[[0,1,2]],\"collision\":false}");
	const FString ValidInventory = TEXT("{\"schema_version\":1,\"feature_count\":1,\"counts\":{\"surface\":1},\"meshes\":[") + ValidRow + TEXT("]}");
	FFileHelper::SaveStringToFile(ValidInventory, *(Directory / TEXT("geometry.json")));
	FString PreflightError;
	TestTrue(TEXT("valid geometry passes preflight without a world"), ValidateEnvGenStreetscape(ManifestPath,
		[](double, double) { return 0.; }, PreflightError));
	TArray<UPackage*> ControlPackages;
	TArray<AActor*> ControlActors;
	FString ControlError;
	TestFalse(TEXT("valid geometry reaches the world requirement"), BuildEnvGenStreetscape(nullptr, ManifestPath,
		[](double, double) { return 0.; }, ControlPackages, ControlActors, MakeShared<FJsonObject>(), ControlError));
	TestEqual(TEXT("positive control parsed successfully"), ControlError, FString(TEXT("streetscape needs a world after validation")));
	const FString Sliver = TEXT("{\"material\":\"asphalt\",\"vertices\":[[400,0,0.04],[400.00001,0,0.04],[400,0.00001,0.04]],\"triangles\":[[0,1,2]],\"collision\":false}");
	const FString SliverInventory = TEXT("{\"schema_version\":1,\"feature_count\":2,\"counts\":{\"surface\":2},\"meshes\":[") + ValidRow + TEXT(",") + Sliver + TEXT("]}");
	FFileHelper::SaveStringToFile(SliverInventory, *(Directory / TEXT("geometry.json")));
	FString SliverError;
	TestFalse(TEXT("sub-precision clipping slivers do not reject the valid mesh"), BuildEnvGenStreetscape(nullptr, ManifestPath,
		[](double, double) { return 0.; }, ControlPackages, ControlActors, MakeShared<FJsonObject>(), SliverError));
	TestEqual(TEXT("sliver reached the same validated state"), SliverError, ControlError);
	for (const FString& Row : BadRows)
	{
		const FString Inventory = TEXT("{\"schema_version\":1,\"feature_count\":2,\"counts\":{\"surface\":2},\"meshes\":[") + ValidRow + TEXT(",") + Row + TEXT("]}");
		FFileHelper::SaveStringToFile(Inventory, *(Directory / TEXT("geometry.json")));
		FString PreflightFailure;
		TestFalse(TEXT("invalid geometry fails preflight"), ValidateEnvGenStreetscape(ManifestPath,
			[](double, double) { return 0.; }, PreflightFailure));
		TArray<UPackage*> Packages;
		TArray<AActor*> Actors;
		FString Error;
		TestFalse(TEXT("invalid geometry is rejected before requiring a world"), BuildEnvGenStreetscape(nullptr, ManifestPath,
			[](double, double) { return 0.; }, Packages, Actors, MakeShared<FJsonObject>(), Error));
		TestFalse(TEXT("failure has a diagnostic"), Error.IsEmpty());
		TestNotEqual(TEXT("invalid geometry fails before world creation"), Error, ControlError);
		TestTrue(TEXT("failure creates no assets"), Packages.IsEmpty());
		TestTrue(TEXT("failure places no actors"), Actors.IsEmpty());
	}
	TArray64<uint8> HeightBytes;
	HeightBytes.SetNumZeroed(8);
	uint16* Heights = reinterpret_cast<uint16*>(HeightBytes.GetData());
	Heights[0] = Heights[3] = 32788;
	Heights[1] = 32776;
	Heights[2] = 32784;
	const FVector Origin(-150, -150, 0), Scale(100, 100, 128);
	TestEqual(TEXT("saddle diagonal retains the high ridge"), EnvGenStreetscapeHeight(HeightBytes, 2, Origin, Scale, -100, -100), 20.);
	TestEqual(TEXT("north triangle uses barycentric height"), EnvGenStreetscapeHeight(HeightBytes, 2, Origin, Scale, -75, -125), 14.);
	TestEqual(TEXT("east triangle uses barycentric height"), EnvGenStreetscapeHeight(HeightBytes, 2, Origin, Scale, -125, -75), 18.);
	IFileManager::Get().DeleteDirectory(*Directory, false, true);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FEnvGenNaturalFields, "EnvGen.Streetscape.NaturalFields",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FEnvGenNaturalFields::RunTest(const FString& Parameters)
{
	const FString Directory = FPaths::ProjectSavedDir() / TEXT("Automation/NaturalFields");
	IFileManager::Get().MakeDirectory(*Directory, true);
	const FString Manifest = Directory / TEXT("build.json");
	FFileHelper::SaveStringToFile(TEXT(R"JSON({"streetscape":{"file":"geometry.json"},"stencil_classes":{"ground":1,"road":5,"prop":8,"marking":9}})JSON"), *Manifest);
	const FString Valid = TEXT(R"JSON({"schema_version":1,"feature_count":1,"counts":{"surface":1},"meshes":[],"fields":[{"surface_id":"field","effective_surface":"natural_grass"}]})JSON");
	const auto Check = [&](const FString& Json, bool bExpected) {
		FFileHelper::SaveStringToFile(Json, *(Directory / TEXT("geometry.json")));
		FString Error;
		TestEqual(TEXT("landscape-only field preflight"), ValidateEnvGenStreetscape(Manifest,
			[](double, double) { return 0.; }, Error), bExpected);
	};
	Check(Valid, true);
	Check(Valid.Replace(TEXT("natural_grass"), TEXT("athletic_turf")), false);
	Check(Valid.Replace(TEXT("\"surface\":1"), TEXT("\"decal\":1")), false);
	Check(Valid.Replace(TEXT("\"feature_count\":1"), TEXT("\"feature_count\":2")), false);
	Check(Valid.Replace(TEXT("\"surface_id\":\"field\""), TEXT("\"surface_id\":\"\"")), false);
	IFileManager::Get().DeleteDirectory(*Directory, false, true);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FEnvGenStreetscapeDecal, "EnvGen.Streetscape.RegisteredDecal",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FEnvGenStreetscapeDecal::RunTest(const FString& Parameters)
{
	const FString Directory = FPaths::ProjectSavedDir() / TEXT("Automation/StreetscapeDecal");
	IFileManager::Get().MakeDirectory(*Directory, true);
	const FString ManifestPath = Directory / TEXT("build.json");
	const FString ImagePath = Directory / TEXT("mark.png");
	FFileHelper::SaveStringToFile(TEXT(R"JSON({"streetscape":{"file":"geometry.json"},"stencil_classes":{"ground":1,"road":5,"prop":8,"marking":9}})JSON"), *ManifestPath);
	const FString StandardRow = TEXT(R"JSON({"material":"paint_decal","image":"mark.png","bounds_m":[10,20,14,26],"vertices":[[10,20,0.07],[14,20,0.07],[14,26,0.07],[10,26,0.07]],"triangles":[[0,1,2],[0,2,3]],"collision":false})JSON");
	const auto WriteRow = [&](const FString& Value) {
		return FFileHelper::SaveStringToFile(TEXT("{\"schema_version\":1,\"feature_count\":1,\"counts\":{\"decal\":1},\"meshes\":[") + Value + TEXT("]}"), *(Directory / TEXT("geometry.json")));
	};
	const auto Height = [](double North, double East) { return .1 * North + .2 * East; };
	IImageWrapperModule& Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
	const TSharedPtr<IImageWrapper> Wrapper = Module.CreateImageWrapper(EImageFormat::PNG);
	const uint8 Pixels[] = {255,0,0,255, 0,255,0,192, 0,0,255,128, 255,255,0,0};
	if (!TestTrue(TEXT("encode asymmetric synthetic RGBA"), Wrapper.IsValid()
		&& Wrapper->SetRaw(Pixels, sizeof(Pixels), 2, 2, ERGBFormat::RGBA, 8)
		&& FFileHelper::SaveArrayToFile(Wrapper->GetCompressed(), *ImagePath))) return false;
	for (const bool bGrassPaint : {false, true})
	{
		const FString Row = bGrassPaint
			? StandardRow.Replace(TEXT("paint_decal"), TEXT("grass_paint_decal")).Replace(TEXT("0.07"), TEXT("0.027"))
			: StandardRow;
		WriteRow(Row);
		FString Error;
		TestTrue(TEXT("valid registered image passes preflight"), ValidateEnvGenStreetscape(ManifestPath, Height, Error));
		const TArray<FString> BadRows = {
			Row.Replace(TEXT("mark.png"), TEXT("missing.png")),
			Row.Replace(TEXT("mark.png"), TEXT("../mark.png")),
			Row.Replace(TEXT("[10,20,14,26]"), TEXT("[10,20,10,26]")),
			Row.Replace(TEXT("[10,20,14,26]"), TEXT("[11,20,14,26]")),
			Row.Replace(TEXT("\"collision\":false"), TEXT("\"collision\":true")),
			Row.Replace(TEXT("\"collision\":false"), TEXT("\"collision\":false,\"anchor_m\":[0,0]"))
		};
		for (const FString& Bad : BadRows)
		{
			WriteRow(Bad);
			TArray<UPackage*> Packages;
			TArray<AActor*> Actors;
			Error.Empty();
			TestFalse(TEXT("invalid decal fails preflight"), ValidateEnvGenStreetscape(ManifestPath, Height, Error));
			TestFalse(TEXT("invalid decal creates no assets"), BuildEnvGenStreetscape(nullptr, ManifestPath, Height,
				Packages, Actors, MakeShared<FJsonObject>(), Error));
			TestTrue(TEXT("no packages on failure"), Packages.IsEmpty());
			TestTrue(TEXT("no actors on failure"), Actors.IsEmpty());
			TestNotEqual(TEXT("failure precedes world creation"), Error, FString(TEXT("streetscape needs a world after validation")));
		}
		if (bGrassPaint)
		{
			for (const FString& Vertices : {
				FString(TEXT("[[10,20,0.027],[10,23,0.027],[10,26,1.027]]")),
				FString(TEXT("[[10,20,0.027],[12,23,0.027],[14,26,1.027]]"))})
			{
				WriteRow(TEXT("{\"material\":\"grass_paint_decal\",\"image\":\"mark.png\",\"bounds_m\":[10,20,14,26],\"vertices\":")
					+ Vertices + TEXT(",\"triangles\":[[0,1,2]],\"collision\":false}"));
				TestFalse(TEXT("vertical and diagonal zero-area paint projections fail preflight"), ValidateEnvGenStreetscape(ManifestPath, Height, Error));
			}
			WriteRow(Row);
		}
		WriteRow(Row);
		FFileHelper::SaveStringToFile(TEXT("corrupt PNG"), *ImagePath);
		TestFalse(TEXT("corrupt PNG fails preflight"), ValidateEnvGenStreetscape(ManifestPath, Height, Error));
		const uint8 Transparent[16] = {};
		Wrapper->SetRaw(Transparent, sizeof(Transparent), 2, 2, ERGBFormat::RGBA, 8);
		FFileHelper::SaveArrayToFile(Wrapper->GetCompressed(), *ImagePath);
		TestFalse(TEXT("empty alpha fails preflight"), ValidateEnvGenStreetscape(ManifestPath, Height, Error));
		for (const uint8 Alpha : {uint8(84), uint8(85)})
		{
			uint8 Faint[16];
			for (int32 I = 0; I < 16; ++I) Faint[I] = (I % 4 == 3) ? Alpha : 200;
			Wrapper->SetRaw(Faint, sizeof(Faint), 2, 2, ERGBFormat::RGBA, 8);
			FFileHelper::SaveArrayToFile(Wrapper->GetCompressed(), *ImagePath);
			TestEqual(TEXT("alpha must reach the masked cutoff"), ValidateEnvGenStreetscape(ManifestPath, Height, Error), Alpha >= 85);
		}
		const uint8 Gray[4] = {};
		Wrapper->SetRaw(Gray, sizeof(Gray), 2, 2, ERGBFormat::Gray, 8);
		FFileHelper::SaveArrayToFile(Wrapper->GetCompressed(), *ImagePath);
		TestFalse(TEXT("grayscale PNG fails preflight"), ValidateEnvGenStreetscape(ManifestPath, Height, Error));
		Wrapper->SetRaw(Pixels, sizeof(Pixels), 2, 2, ERGBFormat::RGBA, 8);
		FFileHelper::SaveArrayToFile(Wrapper->GetCompressed(), *ImagePath);

		UWorld* World = UWorld::CreateWorld(EWorldType::Editor, false);
		if (!TestNotNull(TEXT("test world"), World)) return false;
		ULandscapeGrassType* NaturalReceiver = nullptr;
		if (bGrassPaint)
		{
			auto* Landscape = World->SpawnActor<ALandscape>();
			Landscape->SetActorLabel(TEXT("EnvGenLandscape"));
			auto* Ground = NewObject<UMaterial>();
			Landscape->LandscapeMaterial = Ground;
			auto* Output = CastChecked<UMaterialExpressionLandscapeGrassOutput>(UMaterialEditingLibrary::CreateMaterialExpression(Ground, UMaterialExpressionLandscapeGrassOutput::StaticClass()));
			Output->GrassTypes.Empty();
			NaturalReceiver = NewObject<ULandscapeGrassType>();
			NaturalReceiver->GrassVarieties.AddDefaulted_GetRef().bReceivesDecals = false;
			auto& Input = Output->GrassTypes.AddDefaulted_GetRef();
			Input.Name = TEXT("NaturalControl"); Input.GrassType = NaturalReceiver;
		}
		TArray<UPackage*> Packages;
		TArray<AActor*> Actors;
		const bool bBuilt = BuildEnvGenStreetscape(World, ManifestPath, Height, Packages, Actors, MakeShared<FJsonObject>(), Error);
		if (TestTrue(TEXT("build registered mesh"), bBuilt) && TestEqual(TEXT("paint projects onto receivers and retains its semantic mesh"), Actors.Num(), bGrassPaint ? 2 : 1))
		{
			auto* Component = CastChecked<AStaticMeshActor>(Actors[0])->GetStaticMeshComponent();
			UStaticMesh* Mesh = Component->GetStaticMesh();
			TestFalse(TEXT("decal retains ordinary terrain planes"), Mesh->GetNaniteSettings().bEnabled);
			TestEqual(TEXT("decal is marking class"), Component->CustomDepthStencilValue, 9);
			TestEqual(TEXT("decal has no collision"), Component->GetCollisionProfileName(), FName(TEXT("NoCollision")));
			TestTrue(TEXT("decal material is masked"), CastChecked<UMaterial>(Component->GetMaterial(0))->BlendMode == BLEND_Masked);
			if (bGrassPaint)
			{
				TestTrue(TEXT("existing natural blades receive paint"), NaturalReceiver->GrassVarieties[0].bReceivesDecals);
				TestFalse(TEXT("grass paint has no visible flat overlay"), Component->bRenderInMainPass);
				TestFalse(TEXT("semantic paint cannot occlude the visible ground"), Component->bRenderInDepthPass);
				const auto* Projector = Cast<ADecalActor>(Actors[1]);
				if (TestNotNull(TEXT("grass paint projects onto existing blades"), Projector))
				{
					TestTrue(TEXT("paint projection points down after actor construction"), Projector->GetActorForwardVector().Equals(FVector(0, 0, -1), 1.e-4));
					const auto* Projected = CastChecked<UMaterial>(Projector->GetDecal()->GetDecalMaterial());
					TestTrue(TEXT("paint uses the deferred receiver surface"), Projected->MaterialDomain == MD_DeferredDecal);
					TestTrue(TEXT("paint fades instead of cutting angular holes"), Projected->BlendMode == BLEND_Translucent);
					for (UMaterialExpression* Expression : Projected->GetExpressions())
					{
						const auto* Sample = Cast<UMaterialExpressionTextureSample>(Expression);
						if (!Sample) continue;
						auto* Texture = CastChecked<UTexture2D>(Sample->Texture);
						TestFalse(TEXT("blended paint mips average alpha without masked coverage inflation"), Texture->bDoScaleMipsForAlphaCoverage);
						TArray64<uint8> Mip;
						if (TestTrue(TEXT("read projected artwork"), Texture->Source.GetMipData(Mip, 0)))
						{
							const int32 W = Texture->Source.GetSizeX(), H = Texture->Source.GetSizeY();
							for (int32 Y = 0; Y < 2; ++Y) for (int32 X = 0; X < 2; ++X)
							{
								const int64 At = (int64((Y * 2 + 1) * H / 4) * W + (X * 2 + 1) * W / 4) * 4;
								const int32 Original = (Y * 2 + X) * 4;
								TestEqual(TEXT("projected paint preserves registered color"), Mip[At + 2], Pixels[Original]);
								TestEqual(TEXT("projected paint preserves source alpha including holes"), Mip[At + 3], Pixels[Original + 3]);
							}
						}
					}
				}
				UMaterial* Material = CastChecked<UMaterial>(Component->GetMaterial(0));
				bool bFoundAlpha = false;
				for (UMaterialExpression* Expression : Material->GetExpressions())
				{
					if (const auto* Pattern = Cast<UMaterialExpressionCustom>(Expression))
					{
						for (const FCustomInput& Input : Pattern->Inputs)
						{
							if (Input.InputName != TEXT("PaintAlpha")) continue;
							const auto* Sample = Cast<UMaterialExpressionTextureSample>(Input.Input.Expression);
							bFoundAlpha = Sample && Input.Input.OutputIndex == 4;
							if (Sample)
							{
								auto* Texture = CastChecked<UTexture2D>(Sample->Texture);
								TestTrue(TEXT("grass artwork clamps registered UVs"), Texture->AddressX == TA_Clamp && Texture->AddressY == TA_Clamp);
								TestTrue(TEXT("grass artwork retains alpha mip coverage"), Texture->bDoScaleMipsForAlphaCoverage);
							}
						}
					}
				}
				TestTrue(TEXT("grass paint consumes the source alpha channel"), bFoundAlpha);
			}
			const FMeshDescription* Description = Mesh->GetMeshDescription(0);
			if (TestNotNull(TEXT("mesh description"), Description))
			{
				FStaticMeshConstAttributes Attributes(*Description);
				const auto Positions = Attributes.GetVertexPositions();
				const auto UVs = Attributes.GetVertexInstanceUVs();
				for (const FVertexInstanceID Corner : Description->VertexInstances().GetElementIDs())
				{
					const FVector3f P = Positions[Description->GetVertexInstanceVertex(Corner)];
					const FVector2f Expected((P.Y - 1000) / 400, (2600 - P.X) / 600);
					TestTrue(TEXT("north-up UV survives EN-to-NE conversion"), UVs.Get(Corner, 0).Equals(Expected, 1.e-6f));
					TestTrue(TEXT("each vertex follows terrain plus the supplied paint offset"), FMath::IsNearlyEqual(double(P.Z), Height(P.X, P.Y) + (bGrassPaint ? 2.7 : 7), .001));
				}
			}
		}
		World->DestroyWorld(false);
	}
	WriteRow(TEXT(R"JSON({"material":"grass_paint_white","vertices":[[0.02,0,0.027],[0.024,0,0.027],[0.024,100,0.027],[0.02,100,0.027],[99.996,0,0.027],[100,0,0.027],[100,100,0.027],[99.996,100,0.027]],"triangles":[[0,1,2],[0,2,3],[4,5,6],[4,6,7]],"collision":false})JSON"));
	UWorld* ThinWorld = UWorld::CreateWorld(EWorldType::Editor, false);
	TArray<UPackage*> ThinPackages;
	TArray<AActor*> ThinActors;
	FString ThinError;
	if (TestTrue(TEXT("build disconnected subpixel paint in a large bin"), BuildEnvGenStreetscape(ThinWorld, ManifestPath,
		[](double, double) { return 0.; }, ThinPackages, ThinActors, MakeShared<FJsonObject>(), ThinError)))
	{
		for (UPackage* Package : ThinPackages)
		{
			auto* Texture = FindObject<UTexture2D>(Package, TEXT("T_GrassPaint_0000"));
			if (!Texture) continue;
			TArray64<uint8> Mip;
			if (TestTrue(TEXT("read narrow paint footprint"), Texture->Source.GetMipData(Mip, 0)))
			{
				const int32 W = Texture->Source.GetSizeX(), H = Texture->Source.GetSizeY();
				const int64 Row = int64(H / 2) * W * 4;
				TestEqual(TEXT("left 4mm strip survives between pixel centers"), Mip[Row + 3], uint8(255));
				TestEqual(TEXT("right 4mm strip survives the resolution cap"), Mip[Row + (W - 1) * 4 + 3], uint8(255));
				TestEqual(TEXT("unpainted gap stays transparent"), Mip[Row + W / 2 * 4 + 3], uint8(0));
				TestTrue(TEXT("transparent white paint retains RGB for fringe-free filtering"), Mip[Row + W / 2 * 4] > 200);
			}
		}
	}
	ThinWorld->DestroyWorld(false);
	WriteRow(TEXT(R"JSON({"material":"grass_paint_white","vertices":[[0,1000000,0.027],[1,1000000.01,0.027],[0,1000000.02,1.027]],"triangles":[[0,1,2]],"collision":false})JSON"));
	FString CollapsedError;
	TestFalse(TEXT("paint rejects horizontal collapse after float conversion"), ValidateEnvGenStreetscape(ManifestPath,
		[](double, double) { return 0.; }, CollapsedError));
	TArray<uint8> NarrowPixels;
	NarrowPixels.SetNumZeroed(10000 * 2 * 4);
	for (int32 Y = 0; Y < 2; ++Y) for (int32 C = 0; C < 4; ++C) NarrowPixels[Y * 10000 * 4 + C] = 255;
	Wrapper->SetRaw(NarrowPixels.GetData(), NarrowPixels.Num(), 10000, 2, ERGBFormat::RGBA, 8);
	FFileHelper::SaveArrayToFile(Wrapper->GetCompressed(), *ImagePath);
	WriteRow(TEXT(R"JSON({"material":"grass_paint_decal","image":"mark.png","bounds_m":[0,0,100,100],"vertices":[[0,0,0.027],[0.004,0,0.027],[0.004,100,0.027],[0,100,0.027],[99.996,0,0.027],[100,0,0.027],[100,100,0.027],[99.996,100,0.027]],"triangles":[[0,1,2],[0,2,3],[4,5,6],[4,6,7]],"collision":false})JSON"));
	UWorld* NarrowWorld = UWorld::CreateWorld(EWorldType::Editor, false);
	TArray<UPackage*> NarrowPackages;
	TArray<AActor*> NarrowActors;
	FString NarrowError;
	if (TestTrue(TEXT("build subpixel registered alpha"), BuildEnvGenStreetscape(NarrowWorld, ManifestPath,
		[](double, double) { return 0.; }, NarrowPackages, NarrowActors, MakeShared<FJsonObject>(), NarrowError)))
	{
		for (UPackage* Package : NarrowPackages)
		{
			auto* Texture = FindObject<UTexture2D>(Package, TEXT("T_GrassPaint_0000"));
			if (!Texture) continue;
			TArray64<uint8> Mip;
			if (TestTrue(TEXT("read registered narrow footprint"), Texture->Source.GetMipData(Mip, 0)))
				TestEqual(TEXT("source alpha survives footprint resampling"), Mip[3], uint8(255));
		}
	}
	NarrowWorld->DestroyWorld(false);
	for (int32 Y = 0; Y < 2; ++Y) for (int32 C = 0; C < 4; ++C)
	{
		NarrowPixels[Y * 10000 * 4 + C] = 0;
		NarrowPixels[(Y * 10000 + 1) * 4 + C] = 255;
	}
	Wrapper->SetRaw(NarrowPixels.GetData(), NarrowPixels.Num(), 10000, 2, ERGBFormat::RGBA, 8);
	FFileHelper::SaveArrayToFile(Wrapper->GetCompressed(), *ImagePath);
	UWorld* ClippedWorld = UWorld::CreateWorld(EWorldType::Editor, false);
	TArray<UPackage*> ClippedPackages;
	TArray<AActor*> ClippedActors;
	if (TestTrue(TEXT("build paint clipped away from opaque artwork"), BuildEnvGenStreetscape(ClippedWorld, ManifestPath,
		[](double, double) { return 0.; }, ClippedPackages, ClippedActors, MakeShared<FJsonObject>(), NarrowError)))
	{
		for (UPackage* Package : ClippedPackages)
		{
			auto* Texture = FindObject<UTexture2D>(Package, TEXT("T_GrassPaint_0000"));
			if (!Texture) continue;
			TArray64<uint8> Mip;
			if (TestTrue(TEXT("read clipped registered footprint"), Texture->Source.GetMipData(Mip, 0)))
				TestEqual(TEXT("opaque source outside geometry cannot paint the shared pixel"), Mip[3], uint8(0));
		}
	}
	ClippedWorld->DestroyWorld(false);
	const uint8 OutsidePixels[] = {0,0,0,0, 0,0,0,0, 0,0,0,0, 255,255,255,255};
	Wrapper->SetRaw(OutsidePixels, sizeof(OutsidePixels), 2, 2, ERGBFormat::RGBA, 8);
	FFileHelper::SaveArrayToFile(Wrapper->GetCompressed(), *ImagePath);
	WriteRow(TEXT(R"JSON({"material":"grass_paint_decal","image":"mark.png","bounds_m":[0,0,1,1],"vertices":[[0,1,0.027],[1,1,0.027],[0,0,0.027]],"triangles":[[0,1,2]],"collision":false})JSON"));
	UWorld* DiagonalWorld = UWorld::CreateWorld(EWorldType::Editor, false);
	TArray<UPackage*> DiagonalPackages;
	TArray<AActor*> DiagonalActors;
	if (TestTrue(TEXT("build paint touching opaque artwork at a diagonal corner"), BuildEnvGenStreetscape(DiagonalWorld, ManifestPath,
		[](double, double) { return 0.; }, DiagonalPackages, DiagonalActors, MakeShared<FJsonObject>(), NarrowError)))
	{
		for (UPackage* Package : DiagonalPackages)
		{
			auto* Texture = FindObject<UTexture2D>(Package, TEXT("T_GrassPaint_0000"));
			if (!Texture) continue;
			TArray64<uint8> Mip;
			if (TestTrue(TEXT("read diagonal clipping footprint"), Texture->Source.GetMipData(Mip, 0)))
			{
				int32 Covered = 0;
				for (int64 I = 3; I < Mip.Num(); I += 4) Covered += Mip[I] > 0;
				TestEqual(TEXT("zero-area diagonal source contact cannot create visible paint"), Covered, 0);
			}
		}
	}
	DiagonalWorld->DestroyWorld(false);
	IFileManager::Get().DeleteDirectory(*Directory, false, true);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FEnvGenStreetscapeAthletic, "EnvGen.Streetscape.AthleticTurf",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FEnvGenStreetscapeAthletic::RunTest(const FString& Parameters)
{
	const FString Directory = FPaths::ProjectSavedDir() / TEXT("Automation/StreetscapeAthletic");
	IFileManager::Get().MakeDirectory(*Directory, true);
	const FString ManifestPath = Directory / TEXT("build.json");
	FFileHelper::SaveStringToFile(TEXT(R"JSON({"streetscape":{"file":"geometry.json"},"stencil_classes":{"ground":1,"road":5,"prop":8,"marking":9}})JSON"), *ManifestPath);
	const FString Row = TEXT(R"JSON({"material":"athletic_turf","image":"field.png","bounds_m":[10,20,14,26],"heading_deg":0,"stripe_width_m":4.572,"vertices":[[10,20,0.025],[14,20,0.025],[14,26,0.025],[10,26,0.025]],"triangles":[[0,1,2],[0,2,3]],"collision":false})JSON");
	const FString Decal = Row.Replace(TEXT("athletic_turf"), TEXT("paint_decal"));
	const auto WriteRows = [&](const TArray<FString>& Rows)
	{
		return FFileHelper::SaveStringToFile(FString::Printf(TEXT("{\"schema_version\":1,\"feature_count\":%d,\"counts\":{\"surface\":%d},\"meshes\":[%s]}"),
			Rows.Num(), Rows.Num(), *FString::Join(Rows, TEXT(","))), *(Directory / TEXT("geometry.json")));
	};
	const auto Height = [](double North, double East) { return .1 * North + .2 * East; };
	IImageWrapperModule& Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
	const TSharedPtr<IImageWrapper> Wrapper = Module.CreateImageWrapper(EImageFormat::PNG);
	uint8 Pixels[] = {30,100,40,255, 230,230,230,255, 240,200,20,255, 25,95,35,255};
	const auto WriteImage = [&]()
	{
		return Wrapper.IsValid() && Wrapper->SetRaw(Pixels, sizeof(Pixels), 2, 2, ERGBFormat::RGBA, 8)
			&& FFileHelper::SaveArrayToFile(Wrapper->GetCompressed(), *(Directory / TEXT("field.png")));
	};
	if (!TestTrue(TEXT("encode opaque full-field atlas"), WriteImage())) return false;
	FString Error;
	WriteRows({Row});
	TestTrue(TEXT("opaque atlas with required metadata passes preflight"), ValidateEnvGenStreetscape(ManifestPath, Height, Error));
	TArray<UPackage*> ControlPackages;
	TArray<AActor*> ControlActors;
	TestFalse(TEXT("valid athletic atlas reaches the world requirement"), BuildEnvGenStreetscape(nullptr, ManifestPath, Height,
		ControlPackages, ControlActors, MakeShared<FJsonObject>(), Error));
	TestEqual(TEXT("athletic positive control parsed successfully"), Error, FString(TEXT("streetscape needs a world after validation")));
	for (const FString& Valid : {
		Row.Replace(TEXT("\"heading_deg\":0"), TEXT("\"heading_deg\":-450")),
		Row.Replace(TEXT("\"stripe_width_m\":4.572"), TEXT("\"stripe_width_m\":100")),
		Row.Replace(TEXT("\"stripe_width_m\":4.572"), TEXT("\"stripe_width_m\":1e-300")),
		Row.Replace(TEXT("athletic_turf"), TEXT("natural_grass")),
		Row.Replace(TEXT("athletic_turf"), TEXT("grass_paint_white")),
		Row.Replace(TEXT("athletic_turf"), TEXT("grass_paint_yellow"))})
	{
		WriteRows({Valid});
		TestTrue(TEXT("new grass names and finite athletic metadata pass"), ValidateEnvGenStreetscape(ManifestPath, Height, Error));
	}
	const TArray<FString> BadRows = {
		Row.Replace(TEXT("\"image\":\"field.png\","), TEXT("")),
		Row.Replace(TEXT("field.png"), TEXT("missing.png")),
		Row.Replace(TEXT("field.png"), TEXT("../field.png")),
		Row.Replace(TEXT("\"bounds_m\":[10,20,14,26],"), TEXT("")),
		Row.Replace(TEXT("[10,20,14,26]"), TEXT("[10,20,10,26]")),
		Row.Replace(TEXT("[10,20,14,26]"), TEXT("[11,20,14,26]")),
		Row.Replace(TEXT("\"heading_deg\":0,"), TEXT("")),
		Row.Replace(TEXT("\"heading_deg\":0"), TEXT("\"heading_deg\":null")),
		Row.Replace(TEXT("\"heading_deg\":0"), TEXT("\"heading_deg\":true")),
		Row.Replace(TEXT("\"heading_deg\":0"), TEXT("\"heading_deg\":\"90\"")),
		Row.Replace(TEXT("\"heading_deg\":0"), TEXT("\"heading_deg\":1e309")),
		Row.Replace(TEXT("\"stripe_width_m\":4.572,"), TEXT("")),
		Row.Replace(TEXT("\"stripe_width_m\":4.572"), TEXT("\"stripe_width_m\":null")),
		Row.Replace(TEXT("\"stripe_width_m\":4.572"), TEXT("\"stripe_width_m\":true")),
		Row.Replace(TEXT("\"stripe_width_m\":4.572"), TEXT("\"stripe_width_m\":\"4.572\"")),
		Row.Replace(TEXT("\"stripe_width_m\":4.572"), TEXT("\"stripe_width_m\":0")),
		Row.Replace(TEXT("\"stripe_width_m\":4.572"), TEXT("\"stripe_width_m\":-1")),
		Row.Replace(TEXT("\"stripe_width_m\":4.572"), TEXT("\"stripe_width_m\":100.001")),
		Row.Replace(TEXT("\"stripe_width_m\":4.572"), TEXT("\"stripe_width_m\":1e309")),
		Row.Replace(TEXT("\"collision\":false"), TEXT("\"collision\":true")),
		Row.Replace(TEXT("0.025"), TEXT("0.1")),
		Row.Replace(TEXT("\"collision\":false"), TEXT("\"collision\":false,\"anchor_m\":[0,0]"))
	};
	const auto RejectWithoutMutation = [&]()
	{
		TArray<UPackage*> Packages;
		TArray<AActor*> Actors;
		Error.Empty();
		TestFalse(TEXT("invalid athletic atlas fails preflight"), ValidateEnvGenStreetscape(ManifestPath, Height, Error));
		TestFalse(TEXT("invalid athletic atlas fails build"), BuildEnvGenStreetscape(nullptr, ManifestPath, Height,
			Packages, Actors, MakeShared<FJsonObject>(), Error));
		TestFalse(TEXT("athletic failure has a diagnostic"), Error.IsEmpty());
		TestNotEqual(TEXT("athletic failure precedes world requirement"), Error, FString(TEXT("streetscape needs a world after validation")));
		TestTrue(TEXT("athletic failure creates no assets"), Packages.IsEmpty());
		TestTrue(TEXT("athletic failure creates no actors"), Actors.IsEmpty());
	};
	for (const FString& Bad : BadRows)
	{
		WriteRows({Row, Bad});
		RejectWithoutMutation();
	}
	// Load the same image through the decal cache first; athletic alpha rules must still apply.
	for (const uint8 Alpha : {uint8(0), uint8(85), uint8(254)})
	{
		Pixels[15] = Alpha;
		if (!TestTrue(TEXT("write partially transparent atlas"), WriteImage())) return false;
		WriteRows({Decal});
		TestTrue(TEXT("partial alpha remains valid for decals"), ValidateEnvGenStreetscape(ManifestPath, Height, Error));
		WriteRows({Decal, Row});
		RejectWithoutMutation();
	}
	Pixels[15] = 255;
	if (!TestTrue(TEXT("restore opaque atlas"), WriteImage())) return false;
	WriteRows({Row, Row,
		Row.Replace(TEXT("\"heading_deg\":0"), TEXT("\"heading_deg\":90")),
		Row.Replace(TEXT("\"stripe_width_m\":4.572"), TEXT("\"stripe_width_m\":5")),
		Row.Replace(TEXT("[10,20,14,26]"), TEXT("[10,20,15,26]")),
		Row.Replace(TEXT("[10,20,14,26]"), TEXT("[10,20,14,27]")), Decal,
		Row.Replace(TEXT("[10,20,14,26]"), TEXT("[20,20,24,26]"))
			.Replace(TEXT("\"heading_deg\":0"), TEXT("\"heading_deg\":1e300"))
			.Replace(TEXT("[10,20,0.025]"), TEXT("[20,20,0.025]"))
			.Replace(TEXT("[14,20,0.025]"), TEXT("[24,20,0.025]"))
			.Replace(TEXT("[14,26,0.025]"), TEXT("[24,26,0.025]"))
			.Replace(TEXT("[10,26,0.025]"), TEXT("[20,26,0.025]")),
		Row.Replace(TEXT("[10,20,14,26]"), TEXT("[10,20,110,120]"))
			.Replace(TEXT("[14,20,0.025]"), TEXT("[10.01,20,0.025]"))
			.Replace(TEXT("[14,26,0.025]"), TEXT("[10.01,120,0.025]"))
			.Replace(TEXT("[10,26,0.025]"), TEXT("[10,120,0.025]"))});
	UWorld* World = UWorld::CreateWorld(EWorldType::Editor, false);
	if (!TestNotNull(TEXT("athletic test world"), World)) return false;
	ALandscape* Landscape = World->SpawnActor<ALandscape>();
	Landscape->SetActorLabel(TEXT("EnvGenLandscape"));
	UMaterial* Ground = NewObject<UMaterial>();
	Landscape->LandscapeMaterial = Ground;
	auto* GrassOutput = CastChecked<UMaterialExpressionLandscapeGrassOutput>(UMaterialEditingLibrary::CreateMaterialExpression(Ground, UMaterialExpressionLandscapeGrassOutput::StaticClass()));
	GrassOutput->GrassTypes.Empty();
	ULandscapeGrassType* NaturalGrass = NewObject<ULandscapeGrassType>();
	FGrassInput& NaturalInput = GrassOutput->GrassTypes.AddDefaulted_GetRef();
	NaturalInput.Name = TEXT("NaturalControl");
	NaturalInput.GrassType = NaturalGrass;
	TArray<UPackage*> Packages;
	TArray<AActor*> Actors;
	const TSharedRef<FJsonObject> Receipt = MakeShared<FJsonObject>();
	if (TestTrue(TEXT("build split athletic fields"), BuildEnvGenStreetscape(World, ManifestPath, Height, Packages, Actors, Receipt, Error))
		&& TestEqual(TEXT("one actor per supplied mesh; no marking overlays"), Actors.Num(), 9))
	{
		const auto Component = [&](int32 Index) { return CastChecked<AStaticMeshActor>(Actors[Index])->GetStaticMeshComponent(); };
		UMaterial* Material = CastChecked<UMaterial>(Component(0)->GetMaterial(0));
		TestTrue(TEXT("athletic atlas is opaque"), Material->BlendMode == BLEND_Opaque);
		TestFalse(TEXT("fiber normals are in world space"), Material->bTangentSpaceNormal);
		TestEqual(TEXT("athletic field is ground class"), Component(0)->CustomDepthStencilValue, 1);
		TestFalse(TEXT("athletic field keeps terrain planes"), Component(0)->GetStaticMesh()->GetNaniteSettings().bEnabled);
		TestTrue(TEXT("registered atlas retains full precision in the actual render buffer"),
			Component(0)->GetStaticMesh()->GetRenderData()->LODResources[0].VertexBuffers.StaticMeshVertexBuffer.GetUseFullPrecisionUVs());
		TestEqual(TEXT("identical field bins share a material"), Component(1)->GetMaterial(0), Component(0)->GetMaterial(0));
		TestNotEqual(TEXT("translated fields cannot share a world-projected pile"), Component(7)->GetMaterial(0), Component(0)->GetMaterial(0));
		for (int32 I = 2; I <= 6; ++I)
			TestNotEqual(TEXT("axes, stripe, dimensions and material type cannot alias"), Component(I)->GetMaterial(0), Component(0)->GetMaterial(0));
		TestTrue(TEXT("same opaque image still uses masked decal behavior"), CastChecked<UMaterial>(Component(6)->GetMaterial(0))->BlendMode == BLEND_Masked);
		bool bFoundAtlas = false;
		for (UMaterialExpression* Expression : Material->GetExpressions())
		{
			if (const auto* Atlas = Cast<UMaterialExpressionTextureObject>(Expression); Atlas && Atlas->SamplerType == SAMPLERTYPE_Color)
			{
				const auto* Texture = CastChecked<UTexture2D>(Atlas->Texture);
				bFoundAtlas = true;
				TestTrue(TEXT("athletic atlas clamps both UV axes"), Texture->AddressX == TA_Clamp && Texture->AddressY == TA_Clamp);
				TestTrue(TEXT("athletic atlas supports mip generation with unchanged normalized UVs"),
					Texture->PowerOfTwoMode == ETexturePowerOfTwoSetting::StretchToPowerOfTwo && Texture->MipGenSettings == TMGS_SimpleAverage);
				TestFalse(TEXT("opaque atlas does not rescale alpha mip coverage"), Texture->bDoScaleMipsForAlphaCoverage);
			}
		}
		TestTrue(TEXT("athletic shader samples the registered atlas"), bFoundAtlas);
		const UTexture2D* Infill = nullptr;
		for (UMaterialExpression* Expression : Material->GetExpressions())
		{
			if (const auto* Sample = Cast<UMaterialExpressionTextureObject>(Expression); Sample && Sample->SamplerType == SAMPLERTYPE_LinearColor)
				Infill = Cast<UTexture2D>(Sample->Texture);
		}
		if (TestNotNull(TEXT("turf binds packed infill data"), Infill))
		{
			TestFalse(TEXT("infill height and reflectance are linear data"), Infill->SRGB);
			TestTrue(TEXT("infill retains uncompressed height precision"), Infill->CompressionSettings == TC_VectorDisplacementmap);
			TestTrue(TEXT("infill wraps and filters at distance"), Infill->AddressX == TA_Wrap && Infill->AddressY == TA_Wrap && Infill->MipGenSettings == TMGS_SimpleAverage);
		}

		TestEqual(TEXT("one streamed pile per field registration plus existing natural grass"), GrassOutput->GrassTypes.Num(), 8);
		TestEqual(TEXT("existing natural grass input survives"), GrassOutput->GrassTypes[0].GrassType.Get(), NaturalGrass);
		for (int32 I = 1; I < GrassOutput->GrassTypes.Num(); ++I)
		{
			const FGrassVariety& Variety = GrassOutput->GrassTypes[I].GrassType->GrassVarieties[0];
			const UStaticMesh* Pile = Variety.GrassMesh;
			TestNotNull(TEXT("synthetic field has real fiber geometry"), Pile);
			TestTrue(TEXT("pile has a bounded eleven-metre range"), Variety.EndCullDistance.GetValue() <= 1100);
			TestEqual(TEXT("pile has two geometry levels"), Pile->GetNumSourceModels(), 2);
			TestEqual(TEXT("both pile levels reach the render buffers"), Pile->GetRenderData()->LODResources.Num(), 2);
			TestTrue(TEXT("distant blades use fewer triangles"), Pile->GetMeshDescription(1)->Triangles().Num() < Pile->GetMeshDescription(0)->Triangles().Num());
			TestFalse(TEXT("synthetic fibers do not cast large natural-grass shadows"), Variety.bCastDynamicShadow);
			TestFalse(TEXT("bounded-WPO pile avoids HISM dither cutoff gaps"), CastChecked<UMaterial>(Pile->GetMaterial(0))->DitheredLODTransition);
			TSet<FIntPoint> Roots[2];
			for (int32 LOD = 0; LOD < 2; ++LOD)
			{
				const FStaticMeshLODResources& Mesh = Pile->GetRenderData()->LODResources[LOD];
				const FStaticMeshVertexBuffer& Vertices = Mesh.VertexBuffers.StaticMeshVertexBuffer;
				TestEqual(TEXT("rendered LOD retains the authored triangle budget"), int32(Mesh.IndexBuffer.GetNumIndices() / 3),
					Pile->GetMeshDescription(LOD)->Triangles().Num());
				AddInfo(FString::Printf(TEXT("pile LOD%d sourceTriangles=%d renderTriangles=%d reduction=%d percent=%.6g baseLOD=%d"),
					LOD, Pile->GetMeshDescription(LOD)->Triangles().Num(), Mesh.IndexBuffer.GetNumIndices() / 3,
					Pile->IsReductionActive(LOD), Pile->GetReductionSettings(LOD).PercentTriangles, Pile->GetReductionSettings(LOD).BaseLODModel));
				for (uint32 Vertex = 0; Vertex < Vertices.GetNumVertices(); ++Vertex)
				{
					const FVector2f Root = Vertices.GetVertexUV(Vertex, 1);
					Roots[LOD].Add(FIntPoint(FMath::RoundToInt(Root.X * 1000), FMath::RoundToInt(Root.Y * 1000)));
				}
				int32 SplitRoots = 0;
				for (int32 Triangle = 0; Triangle < Mesh.IndexBuffer.GetNumIndices(); Triangle += 3)
				{
					const FVector2f Root = Vertices.GetVertexUV(Mesh.IndexBuffer.GetIndex(Triangle), 1);
					if (Root != Vertices.GetVertexUV(Mesh.IndexBuffer.GetIndex(Triangle + 1), 1)
						|| Root != Vertices.GetVertexUV(Mesh.IndexBuffer.GetIndex(Triangle + 2), 1)) ++SplitRoots;
				}
				TestEqual(TEXT("rendered fiber vertices share an exact root before snapping"), SplitRoots, 0);
			}
			TestEqual(TEXT("near pile covers every patch root"), Roots[0].Num(), 400);
			const TSet<FIntPoint> Missing = Roots[0].Difference(Roots[1]), Extra = Roots[1].Difference(Roots[0]);
			TestEqual(FString::Printf(TEXT("far pile retains every near stitch root (near=%d far=%d missing=%d extra=%d)"),
				Roots[0].Num(), Roots[1].Num(), Missing.Num(), Extra.Num()), Missing.Num() + Extra.Num(), 0);
			if (!Missing.IsEmpty() || !Extra.IsEmpty())
			{
				FString Detail;
				for (const FIntPoint Root : Missing) Detail += FString::Printf(TEXT(" missing(%d,%d)"), Root.X, Root.Y);
				for (const FIntPoint Root : Extra) Detail += FString::Printf(TEXT(" extra(%d,%d)"), Root.X, Root.Y);
				AddInfo(Detail);
			}
			for (int32 Heading : {0, 90}) for (float Phase : {0.f, .25f, .5f})
			{
				TSet<int32> Rows;
				for (const FIntPoint Root : Roots[1])
					Rows.Add(FMath::FloorToInt((Heading == 0 ? Root.X : Root.Y) / 1000.f + Phase + .5f));
				TestEqual(TEXT("both field axes retain all centimetre rows at each phase"), Rows.Num(), 20);
			}

			const auto PilePositions = FStaticMeshConstAttributes(*Pile->GetMeshDescription(0)).GetVertexPositions();
			float MinZ = MAX_flt, MaxZ = -MAX_flt;
			for (const FVertexID Vertex : Pile->GetMeshDescription(0)->Vertices().GetElementIDs())
			{
				TestFalse(TEXT("all finite headings produce finite fiber geometry"), PilePositions[Vertex].ContainsNaN());
				MinZ = FMath::Min(MinZ, PilePositions[Vertex].Z);
				MaxZ = FMath::Max(MaxZ, PilePositions[Vertex].Z);
			}
			TestTrue(TEXT("pile keeps its physical height before the world-vertical surface offset"), FMath::Abs(MinZ) <= 1.e-5f && MaxZ > 1.8f && MaxZ <= 2.21f);
		}
		auto* NarrowMask = FindObject<UTexture2D>(nullptr, TEXT("/Game/EnvGen/Generated/T_AthleticPileMask_0008.T_AthleticPileMask_0008"));
		if (TestNotNull(TEXT("narrow field has a fine footprint mask"), NarrowMask))
		{
			TArray64<uint8> MaskBytes;
			TestTrue(TEXT("read actual narrow-field mask"), NarrowMask->Source.GetMipData(MaskBytes, 0));
			TestTrue(TEXT("a one-centimetre strip in a 100-metre registration retains pile coverage"), MaskBytes.ContainsByPredicate([](uint8 Value) { return Value > 0; }));
		}
		const FMeshDescription* Description = Component(0)->GetStaticMesh()->GetMeshDescription(0);
		if (TestNotNull(TEXT("athletic mesh description"), Description))
		{
			FStaticMeshConstAttributes Attributes(*Description);
			const auto Positions = Attributes.GetVertexPositions();
			const auto UVs = Attributes.GetVertexInstanceUVs();
			for (const FVertexInstanceID Corner : Description->VertexInstances().GetElementIDs())
			{
				const FVector3f P = Positions[Description->GetVertexInstanceVertex(Corner)];
				TestTrue(TEXT("athletic north-up registration matches decals"), UVs.Get(Corner, 0).Equals(FVector2f((P.Y - 1000) / 400, (2600 - P.X) / 600), 1.e-6f));
				TestTrue(TEXT("athletic follows terrain at supplied height"), FMath::IsNearlyEqual(double(P.Z), Height(P.X, P.Y) + 2.5, .001));
			}
		}
		const TSharedPtr<FJsonObject> Priors = Receipt->GetObjectField(TEXT("streetscape_material_priors"))->GetObjectField(TEXT("athletic_turf"));
		TestEqual(TEXT("receipt records machine row appearance prior"), Priors->GetNumberField(TEXT("machine_row_spacing_m")), .01);
		TestEqual(TEXT("receipt cull range matches the generated grass settings"), Priors->GetNumberField(TEXT("pile_end_cull_m")),
			GrassOutput->GrassTypes[1].GrassType->GrassVarieties[0].EndCullDistance.GetValue() / 100.);
		TestEqual(TEXT("receipt deduplicates identical bins"), Priors->GetArrayField(TEXT("registrations")).Num(), 7);
	}
	World->DestroyWorld(false);
	IFileManager::Get().DeleteDirectory(*Directory, false, true);
	return true;
}
#endif
