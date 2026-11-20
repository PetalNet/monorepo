#include "EnvGenStreetscape.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionTextureObject.h"
#include "Materials/MaterialExpressionTextureSample.h"
#include "Materials/MaterialExpressionCustom.h"
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
			if (bGrassPaint)
			{
				UMaterial* Material = CastChecked<UMaterial>(Component->GetMaterial(0));
				bool bFoundAlpha = false;
				for (UMaterialExpression* Expression : Material->GetExpressions())
				{
					if (const auto* Pattern = Cast<UMaterialExpressionCustom>(Expression))
					{
						TestTrue(TEXT("grass artwork uses filtered natural paint breakup"), Pattern->Code.Contains(TEXT("bladeVisible=1-smoothstep")));
						TestTrue(TEXT("grass artwork multiplies source alpha by coverage"), Pattern->Code.Contains(TEXT("Coverage*=PaintAlpha;")));
						TestTrue(TEXT("grass artwork retains natural paint fade"), Pattern->Code.Contains(TEXT("float fade=.84+.12*grain;")));
						for (const FCustomInput& Input : Pattern->Inputs)
						{
							if (Input.InputName != TEXT("PaintAlpha")) continue;
							const auto* Sample = Cast<UMaterialExpressionTextureSample>(Input.Input.Expression);
							bFoundAlpha = Sample && Input.Input.OutputIndex == 4;
							if (Sample)
							{
								const auto* Texture = CastChecked<UTexture2D>(Sample->Texture);
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
		Row.Replace(TEXT("[10,20,14,26]"), TEXT("[10,20,14,27]")), Decal});
	UWorld* World = UWorld::CreateWorld(EWorldType::Editor, false);
	if (!TestNotNull(TEXT("athletic test world"), World)) return false;
	TArray<UPackage*> Packages;
	TArray<AActor*> Actors;
	const TSharedRef<FJsonObject> Receipt = MakeShared<FJsonObject>();
	if (TestTrue(TEXT("build split athletic fields"), BuildEnvGenStreetscape(World, ManifestPath, Height, Packages, Actors, Receipt, Error))
		&& TestEqual(TEXT("one actor per supplied mesh; no marking overlays"), Actors.Num(), 7))
	{
		const auto Component = [&](int32 Index) { return CastChecked<AStaticMeshActor>(Actors[Index])->GetStaticMeshComponent(); };
		UMaterial* Material = CastChecked<UMaterial>(Component(0)->GetMaterial(0));
		TestTrue(TEXT("athletic atlas is opaque"), Material->BlendMode == BLEND_Opaque);
		TestFalse(TEXT("fiber normals are in world space"), Material->bTangentSpaceNormal);
		TestEqual(TEXT("athletic field is ground class"), Component(0)->CustomDepthStencilValue, 1);
		TestFalse(TEXT("athletic field keeps terrain planes"), Component(0)->GetStaticMesh()->GetNaniteSettings().bEnabled);
		TestEqual(TEXT("identical field bins share a material"), Component(1)->GetMaterial(0), Component(0)->GetMaterial(0));
		for (int32 I = 2; I <= 6; ++I)
			TestNotEqual(TEXT("axes, stripe, dimensions and material type cannot alias"), Component(I)->GetMaterial(0), Component(0)->GetMaterial(0));
		TestTrue(TEXT("same opaque image still uses masked decal behavior"), CastChecked<UMaterial>(Component(6)->GetMaterial(0))->BlendMode == BLEND_Masked);
		bool bFoundAtlas = false;
		for (UMaterialExpression* Expression : Material->GetExpressions())
		{
			if (const auto* Atlas = Cast<UMaterialExpressionTextureObject>(Expression))
			{
				const auto* Texture = CastChecked<UTexture2D>(Atlas->Texture);
				bFoundAtlas = true;
				TestTrue(TEXT("athletic atlas clamps both UV axes"), Texture->AddressX == TA_Clamp && Texture->AddressY == TA_Clamp);
				TestFalse(TEXT("opaque atlas does not rescale alpha mip coverage"), Texture->bDoScaleMipsForAlphaCoverage);
			}
		}
		TestTrue(TEXT("athletic shader samples the registered atlas"), bFoundAtlas);
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
		TestEqual(TEXT("receipt deduplicates identical bins"), Priors->GetArrayField(TEXT("registrations")).Num(), 5);
	}
	World->DestroyWorld(false);
	IFileManager::Get().DeleteDirectory(*Directory, false, true);
	return true;
}
#endif
