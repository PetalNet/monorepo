#pragma once

#include "CoreMinimal.h"

class FJsonObject;
class UMaterial;
class UPackage;
struct FMeshDescription;
class AStaticMeshActor;

namespace EnvGenArchitecture
{

// UV1 is reserved for lightmaps. Colour and finish use UV2/UV3; UV0 is metric for tangent generation.
enum EFinish { Plain, Brick, Siding, Concrete, Shingle, Membrane, Metal, Glass };
using FTriangle = TFunctionRef<void(FVector, FVector, FVector, const FVector&, const FLinearColor&)>;

struct FRoofForm
{
	FVector2D At = FVector2D::ZeroVector;
	double WidthM = 0, DepthM = 0, HeightM = 0;
	bool bObservedPlan = false, bSkylight = false;
};

struct FStyle
{

	bool bDetailed = false;
	bool bMeasuredRoof = false;
	bool bPressBoxPrior = true;
	int32 RoofFinish = Membrane;
	FString Role;
	FLinearColor Wall = FLinearColor(0.25f, 0.25f, 0.25f, Plain);
	FVector2D Centre = FVector2D::ZeroVector, Along = FVector2D(1, 0);
	double LengthM = 0, WidthM = 0, RiseM = 0, ParapetM = 0;
	int32 StandRows = 0;
	double StandStepM = 0;
	TArray<FVector> RoofVertices;
	TArray<FIntVector> RoofTriangles;
	TArray<TPair<FVector, FVector>> WallSegments;
	TArray<FRoofForm> RoofForms;
	TArray<double> StandAisles{0};

	void Read(const TSharedPtr<FJsonObject>& Building);
	double RoofOffsetM(const FVector2D& Point) const;
	TOptional<double> WallOffsetM(const FVector2D& Point, const FVector2D& Direction, double HalfWidth) const;
	FLinearColor RoofColour(FLinearColor Colour) const;
	FVector2D RoofCheckPoint(FVector2D Anchor) const;
	bool AddRoof(double RoofZ, FLinearColor Colour, FTriangle Emit) const;
	void AddWall(FVector2D A, FVector2D B, double GroundA, double GroundB, double RoofZ, FLinearColor Colour, FTriangle Emit) const;
	void AddDetails(const TArray<TArray<FVector2D>>& Rings, double RoofZ, const FVector2D& TracePoint,
		TFunctionRef<double(double, double)> Ground, FTriangle Emit) const;
};

UMaterial* MakeMaterial(const FString& GeneratedPath, float Roughness, TArray<UPackage*>& Packages);
void AppendCollisionTriangle(FMeshDescription& Description, FVector A, FVector B, FVector C, const FVector& Normal);
void AttachCollision(AStaticMeshActor* Actor, const FMeshDescription& Description, const FString& GeneratedPath, const FString& Name, TArray<UPackage*>& Packages);

}
