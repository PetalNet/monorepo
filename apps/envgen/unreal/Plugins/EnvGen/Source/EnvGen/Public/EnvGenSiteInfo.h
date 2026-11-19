#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Info.h"
#include "EnvGenSiteInfo.generated.h"

/**
 * Where this level is on Earth, and which stencil value means what.
 * Written by the level build from the manifest; one per level, always named "EnvGenSiteInfo".
 *
 * World frame: X = grid north, Y = grid east, Z = up, centimetres, origin at the tile centre.
 */
UCLASS()
class ENVGEN_API AEnvGenSiteInfo : public AInfo
{
	GENERATED_BODY()

public:
	UPROPERTY(VisibleAnywhere, Category = "Georeference")
	FString ProjectedCrs;

	UPROPERTY(VisibleAnywhere, Category = "Georeference")
	double OriginEastingM = 0;

	UPROPERTY(VisibleAnywhere, Category = "Georeference")
	double OriginNorthingM = 0;

	UPROPERTY(VisibleAnywhere, Category = "Georeference")
	double OriginLatitudeDeg = 0;

	UPROPERTY(VisibleAnywhere, Category = "Georeference")
	double OriginLongitudeDeg = 0;

	/** Height of world Z = 0, in the vertical datum below. */
	UPROPERTY(VisibleAnywhere, Category = "Georeference")
	double OriginHeightM = 0;

	UPROPERTY(VisibleAnywhere, Category = "Georeference")
	FString VerticalDatum;

	/** Bearing of true north measured from world +X (grid north), positive towards +Y (east). */
	UPROPERTY(VisibleAnywhere, Category = "Georeference")
	double TrueNorthFromGridNorthDeg = 0;

	/** Side of the square tile, centred on the world origin. */
	UPROPERTY(VisibleAnywhere, Category = "Site")
	double TileSizeCm = 0;

	UPROPERTY(VisibleAnywhere, Category = "Site")
	TMap<FName, int32> StencilClasses;

	static AEnvGenSiteInfo* Find(const UWorld* World);
};
