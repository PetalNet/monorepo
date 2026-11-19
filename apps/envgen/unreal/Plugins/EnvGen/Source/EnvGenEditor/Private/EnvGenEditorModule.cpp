#include "Containers/Ticker.h"
#include "Editor.h"
#include "EnvGenLevelBuild.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Modules/ModuleManager.h"

/**
 * Starts the editor with -EnvGenManifest=<path to build.json> -EnvGenMaterials=<directory fetch-materials.ps1 filled> [-EnvGenMap=/Game/...] to rebuild the
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
		FParse::Value(FCommandLine::Get(), TEXT("EnvGenMaterials="), MaterialsDirectory);
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
		if (!Build.Start(ManifestPath, MapPath, MaterialsDirectory))
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
			// A normal shutdown reports 0 to the caller whatever status was asked for, so a failed build would look
			// like a good one. Failing leaves at once, with the receipt and the log already written.
			if (!bSucceeded)
			{
				GLog->Flush();
				FPlatformMisc::RequestExitWithStatus(true, 1);
			}
			FPlatformMisc::RequestExitWithStatus(false, 0);
			return false;
		}));
	}

	FString ManifestPath;
	FString MapPath;
	FString MaterialsDirectory;
	FEnvGenLevelBuild Build;
	FTSTicker::FDelegateHandle Ticker;
};

IMPLEMENT_MODULE(FEnvGenEditorModule, EnvGenEditor);
