#pragma once

#include "CoreMinimal.h"

class FJsonObject;
class AActor;
class UPackage;
class UWorld;

/** Imports the optional streetscape inventory, in tile-centred east/north metres. */
bool BuildEnvGenStreetscape(UWorld* World, const FString& ManifestPath,
	TFunctionRef<double(double NorthCm, double EastCm)> SurfaceHeight,
	TArray<UPackage*>& Packages, TArray<AActor*>& Actors, TSharedRef<FJsonObject> Receipt, FString& Error);
