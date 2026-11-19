using UnrealBuildTool;

public class EnvGenHostTarget : TargetRules
{
	public EnvGenHostTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("EnvGenHost");
	}
}
