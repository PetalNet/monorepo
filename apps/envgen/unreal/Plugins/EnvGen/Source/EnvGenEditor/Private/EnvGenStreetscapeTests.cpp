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
	for (const FString& Row : BadRows)
	{
		const FString Inventory = TEXT("{\"schema_version\":1,\"feature_count\":1,\"counts\":{\"surface\":1},\"meshes\":[") + Row + TEXT("]}");
		FFileHelper::SaveStringToFile(Inventory, *(Directory / TEXT("geometry.json")));
		TArray<UPackage*> Packages;
		TArray<AActor*> Actors;
		FString Error;
		TestFalse(TEXT("invalid geometry is rejected before requiring a world"), BuildEnvGenStreetscape(nullptr, ManifestPath,
			[](double, double) { return 0.; }, Packages, Actors, MakeShared<FJsonObject>(), Error));
		TestFalse(TEXT("failure has a diagnostic"), Error.IsEmpty());
		TestTrue(TEXT("failure creates no assets"), Packages.IsEmpty());
		TestTrue(TEXT("failure places no actors"), Actors.IsEmpty());
	}
	IFileManager::Get().DeleteDirectory(*Directory, false, true);
	return true;
}
#endif
