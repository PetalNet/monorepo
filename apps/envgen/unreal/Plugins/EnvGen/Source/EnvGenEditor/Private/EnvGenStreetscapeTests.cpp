#include "EnvGenStreetscape.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Materials/Material.h"
#include "MeshDescription.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "StaticMeshAttributes.h"

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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FEnvGenStreetscapeDecal, "EnvGen.Streetscape.RegisteredDecal",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FEnvGenStreetscapeDecal::RunTest(const FString& Parameters)
{
	const FString Directory = FPaths::ProjectSavedDir() / TEXT("Automation/StreetscapeDecal");
	IFileManager::Get().MakeDirectory(*Directory, true);
	const FString ManifestPath = Directory / TEXT("build.json");
	const FString ImagePath = Directory / TEXT("mark.png");
	FFileHelper::SaveStringToFile(TEXT(R"JSON({"streetscape":{"file":"geometry.json"},"stencil_classes":{"ground":1,"road":5,"prop":8,"marking":9}})JSON"), *ManifestPath);
	const FString Row = TEXT(R"JSON({"material":"paint_decal","image":"mark.png","bounds_m":[10,20,14,26],"vertices":[[10,20,0.07],[14,20,0.07],[14,26,0.07],[10,26,0.07]],"triangles":[[0,1,2],[0,2,3]],"collision":false})JSON");
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
	TArray<UPackage*> Packages;
	TArray<AActor*> Actors;
	const bool bBuilt = BuildEnvGenStreetscape(World, ManifestPath, Height, Packages, Actors, MakeShared<FJsonObject>(), Error);
	if (TestTrue(TEXT("build registered mesh"), bBuilt) && TestEqual(TEXT("one decal mesh"), Actors.Num(), 1))
	{
		auto* Component = CastChecked<AStaticMeshActor>(Actors[0])->GetStaticMeshComponent();
		UStaticMesh* Mesh = Component->GetStaticMesh();
		TestFalse(TEXT("decal retains ordinary terrain planes"), Mesh->GetNaniteSettings().bEnabled);
		TestEqual(TEXT("decal is marking class"), Component->CustomDepthStencilValue, 9);
		TestEqual(TEXT("decal has no collision"), Component->GetCollisionProfileName(), FName(TEXT("NoCollision")));
		TestTrue(TEXT("decal material is masked"), CastChecked<UMaterial>(Component->GetMaterial(0))->BlendMode == BLEND_Masked);
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
				TestTrue(TEXT("each vertex follows terrain plus seven centimetres"), FMath::IsNearlyEqual(double(P.Z), Height(P.X, P.Y) + 7, .001));
			}
		}
	}
	World->DestroyWorld(false);
	IFileManager::Get().DeleteDirectory(*Directory, false, true);
	return true;
}
#endif
