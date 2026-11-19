#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "EnvGenGameMode.generated.h"

/** Spawns the walker, or runs a tour when the command line has -EnvGenTour=walk, fly or overview. */
UCLASS()
class ENVGEN_API AEnvGenGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AEnvGenGameMode();
	virtual void StartPlay() override;
};
