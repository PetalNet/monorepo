#pragma once

#include "CoreMinimal.h"

class AActor;
class ALandscape;
class FJsonObject;
class UPackage;
class UWorld;

struct FEnvGenContextState
{
	bool bPresent = false;
	TArray<AActor*> Actors;
	TArray<FVector> GroundProbesCm;
	TSharedPtr<FJsonObject> Counts;
};

bool BuildEnvGenContext(UWorld* World, const FString& ManifestPath, TArray<UPackage*>& Packages,
	FEnvGenContextState& State, FString& Error);

bool FinishEnvGenContext(ALandscape* ContextLandscape, const FEnvGenContextState& State,
	TSharedRef<FJsonObject> Receipt, FString& Error);
