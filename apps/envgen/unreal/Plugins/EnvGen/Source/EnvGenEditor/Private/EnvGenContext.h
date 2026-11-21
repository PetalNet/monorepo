#pragma once

#include "CoreMinimal.h"

class AActor;
class ALandscape;
class FJsonObject;
class UMaterialInterface;
class UPackage;
class UWorld;

struct FEnvGenContextState
{
	bool bPresent = false;
	TArray<AActor*> Actors;
	TArray<FVector> GroundProbesCm;
	TSharedPtr<FJsonObject> Counts;
	UMaterialInterface* Material = nullptr;
};

bool BuildEnvGenContext(UWorld* World, const FString& ManifestPath, UMaterialInterface* Material, TArray<UPackage*>& Packages,
	FEnvGenContextState& State, FString& Error);

bool FinishEnvGenContext(ALandscape* ContextLandscape, const FEnvGenContextState& State,
	TSharedRef<FJsonObject> Receipt, FString& Error);
