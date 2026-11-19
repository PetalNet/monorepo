using UnrealBuildTool;

public class EnvGen : ModuleRules
{
	public EnvGen(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "InputCore" });
		PrivateDependencyModuleNames.AddRange(new[] { "Json", "Landscape", "RenderCore", "RHI" });
	}
}
