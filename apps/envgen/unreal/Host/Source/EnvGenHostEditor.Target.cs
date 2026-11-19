using UnrealBuildTool;

public class EnvGenHostEditorTarget : TargetRules
{
	public EnvGenHostEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("EnvGenHost");
	}
}
