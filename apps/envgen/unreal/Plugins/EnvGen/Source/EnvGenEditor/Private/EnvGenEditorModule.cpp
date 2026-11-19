#include "Containers/Ticker.h"
#include "Editor.h"
#include "EnvGenLevelBuild.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Modules/ModuleManager.h"

/**
 * Starts the editor with -EnvGenManifest=<path to build.json> [-EnvGenMap=/Game/...] to rebuild the
 * level unattended. The process exits with 0 when the build passed its checks and 1 when it did not.
 */
class FEnvGenEditorModule : public IModuleInterface
{
public:
	virtual void StartupModule() override
	{
		if (IsRunningCommandlet() || !FParse::Value(FCommandLine::Get(), TEXT("EnvGenManifest="), ManifestPath))
		{
			return;
		}
		FParse::Value(FCommandLine::Get(), TEXT("EnvGenMap="), MapPath);
		FEditorDelegates::OnEditorInitialized.AddRaw(this, &FEnvGenEditorModule::OnEditorReady);
	}

	virtual void ShutdownModule() override
	{
		FEditorDelegates::OnEditorInitialized.RemoveAll(this);
		FTSTicker::RemoveTicker(Ticker);
	}

private:
	void OnEditorReady(double)
	{
		if (!Build.Start(ManifestPath, MapPath))
		{
			FPlatformMisc::RequestExitWithStatus(false, 1);
			return;
		}
		Ticker = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([this](float DeltaSeconds)
		{
			bool bSucceeded = false;
			if (!Build.Finish(DeltaSeconds, bSucceeded))
			{
				return true;
			}
			FPlatformMisc::RequestExitWithStatus(false, bSucceeded ? 0 : 1);
			return false;
		}));
	}

	FString ManifestPath;
	FString MapPath;
	FEnvGenLevelBuild Build;
	FTSTicker::FDelegateHandle Ticker;
};

IMPLEMENT_MODULE(FEnvGenEditorModule, EnvGenEditor);
