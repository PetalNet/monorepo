#pragma once

#include "CoreMinimal.h"

class UWorld;
class UPackage;

/** The sun and exposure fitted by the pipeline, in grid-north coordinates. */
struct FEnvGenLighting
{
	double GridAzimuthDeg = 0;
	double ElevationDeg = 0;
	double SunLux = 0;
	double ExposureEv100 = 0;
};

/** Builds the outdoor atmosphere; weather and lens priors are recorded in atmosphere.md. */
bool AddEnvGenAtmosphere(UWorld* World, const FEnvGenLighting& Lighting, TArray<UPackage*>& Packages, FString& Error);
