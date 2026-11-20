#include "EnvGenStreetscape.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

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
#endif
