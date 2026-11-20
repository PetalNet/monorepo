#pragma once

#include "CoreMinimal.h"

class FJsonObject;
class AActor;
class ALandscape;
class UPackage;
class UWorld;

/** Imports the optional streetscape inventory, in tile-centred east/north metres. */
bool BuildEnvGenStreetscape(UWorld* World, const FString& ManifestPath,
	TFunctionRef<double(double NorthCm, double EastCm)> SurfaceHeight,
	TArray<UPackage*>& Packages, TArray<AActor*>& Actors, TSharedRef<FJsonObject> Receipt, FString& Error);

/** Checks the complete artifact without creating assets or requiring a world. */
bool ValidateEnvGenStreetscape(const FString& ManifestPath,
	TFunctionRef<double(double NorthCm, double EastCm)> SurfaceHeight, FString& Error);

/** LOD0 Landscape uses the 00--11 diagonal, rather than a bilinear surface. */
double EnvGenStreetscapeHeight(const TArray64<uint8>& HeightBytes, int32 Vertices,
	const FVector& LocationCm, const FVector& Scale, double NorthCm, double EastCm);

/** Keep the imported triangle planes under paving at distance, with a two-quad border for edge morphing. */
int32 LockEnvGenStreetscapeTerrainLOD(ALandscape* Landscape, const TArray<AActor*>& Actors);
