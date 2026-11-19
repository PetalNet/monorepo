using UnrealBuildTool;

public class EnvGenEditor : ModuleRules
{
	public EnvGenEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "EnvGen" });
		// Foliage is here only because the engine's LandscapeEdit.h includes one of its headers.
		PrivateDependencyModuleNames.AddRange(new[]
		{
			"AssetRegistry", "Foliage", "ImageWrapper", "Json", "Landscape", "MaterialEditor", "UnrealEd",
		});
	}
}
