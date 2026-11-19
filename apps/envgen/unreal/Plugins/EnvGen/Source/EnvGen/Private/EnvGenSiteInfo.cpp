#include "EnvGenSiteInfo.h"

#include "EngineUtils.h"

AEnvGenSiteInfo* AEnvGenSiteInfo::Find(const UWorld* World)
{
	for (TActorIterator<AEnvGenSiteInfo> It(World); It; ++It)
	{
		return *It;
	}
	return nullptr;
}
