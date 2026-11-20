#include "EnvGenContext.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "Landscape.h"
#include "LandscapeHeightfieldCollisionComponent.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionVertexColor.h"
#include "Materials/MaterialExpressionConstant.h"
#include "MeshDescription.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "StaticMeshAttributes.h"
#include "StaticMeshCompiler.h"
#include "UObject/Package.h"

namespace
{
	constexpr double BoundaryToleranceM = 1.e-7;
	bool ReadJson(const FString& Path, TSharedPtr<FJsonObject>& Object)
	{
		FString Text;
		return FFileHelper::LoadFileToString(Text, *Path)
			&& FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Object) && Object.IsValid();
	}

	bool Numbers(const TSharedPtr<FJsonValue>& Value, int32 Size, TArray<double>& Out)
	{
		const TArray<TSharedPtr<FJsonValue>>* Array = nullptr;
		if (!Value.IsValid() || !Value->TryGetArray(Array) || Array->Num() != Size) return false;
		Out.Reset();
		for (const auto& Item : *Array)
		{
			double N;
			if (!Item.IsValid() || !Item->TryGetNumber(N) || !FMath::IsFinite(N)) return false;
			Out.Add(N);
		}
		return true;
	}

	bool IsHexHash(const FString& Hash)
	{
		for (TCHAR C : Hash) if (!((C >= '0' && C <= '9') || (C >= 'a' && C <= 'f') || (C >= 'A' && C <= 'F'))) return false;
		return true;
	}

	bool Count(const FJsonObject& Object, const TCHAR* Key, int32 Limit, int32& Out)
	{
		double N;
		if (!Object.TryGetNumberField(Key, N) || !FMath::IsFinite(N) || N < 0 || N > Limit || FMath::FloorToDouble(N) != N) return false;
		Out = int32(N);
		return true;
	}

	template <typename T>
	T* Asset(const FString& Name, TArray<UPackage*>& Packages)
	{
		UPackage* Package = CreatePackage(*(TEXT("/Game/EnvGen/Generated/") + Name));
		T* Object = NewObject<T>(Package, *Name, RF_Public | RF_Standalone);
		FAssetRegistryModule::AssetCreated(Object);
		Package->MarkPackageDirty();
		Packages.Add(Package);
		return Object;
	}

	struct FBatch
	{
		FString Kind;
		FVector Origin;
		TArray<FVector> Vertices;
		TArray<FIntVector> Triangles;
		TArray<FLinearColor> Colours;
	};

	// A separating axis test also handles vertical faces whose XY projection is a line.
	bool OverlapsPrimary(const FVector& A, const FVector& B, const FVector& C, double Half)
	{
		const FVector2D P[] = {{A.X, A.Y}, {B.X, B.Y}, {C.X, C.Y}};
		const FVector2D Axes[] = {{1, 0}, {0, 1}, {P[1].Y-P[0].Y, P[0].X-P[1].X},
			{P[2].Y-P[1].Y, P[1].X-P[2].X}, {P[0].Y-P[2].Y, P[2].X-P[0].X}};
		for (const FVector2D& Axis : Axes)
		{
			const double D0 = FVector2D::DotProduct(P[0], Axis), D1 = FVector2D::DotProduct(P[1], Axis), D2 = FVector2D::DotProduct(P[2], Axis);
			const double Radius = Half * (FMath::Abs(Axis.X) + FMath::Abs(Axis.Y));
			if (FMath::Min3(D0, D1, D2) > Radius || FMath::Max3(D0, D1, D2) < -Radius) return false;
		}
		return true;
	}
}

bool BuildEnvGenContext(UWorld* World, const FString& ManifestPath, TArray<UPackage*>& Packages,
	FEnvGenContextState& State, FString& Error)
{
	State = FEnvGenContextState();
	TSharedPtr<FJsonObject> Manifest;
	if (!ReadJson(ManifestPath, Manifest)) { Error = TEXT("cannot read context manifest"); return false; }
	const TSharedPtr<FJsonObject>* Context = nullptr;
	if (!Manifest->TryGetObjectField(TEXT("context"), Context))
	{
		if (Manifest->HasField(TEXT("context"))) { Error = TEXT("context must be an object"); return false; }
		return true;
	}
	const TSharedPtr<FJsonObject>* Descriptor = nullptr;
	if (!(*Context)->TryGetObjectField(TEXT("geometry"), Descriptor))
	{
		if ((*Context)->HasField(TEXT("geometry"))) { Error = TEXT("context geometry must be an object"); return false; }
		return true;
	}
	FString File, Frame, Hash;
	double Version = 0, Half = 0, PrimarySize = 0, ContextSize = 0;
	TSharedPtr<FJsonObject> Data;
	const TSharedPtr<FJsonObject>* Counts = nullptr;
	const TSharedPtr<FJsonObject>* Sources = nullptr;
	const TSharedPtr<FJsonObject>* Settings = nullptr;
	const TSharedPtr<FJsonObject>* Stencils = nullptr;
	const TSharedPtr<FJsonObject>* Tile = nullptr;
	const TArray<TSharedPtr<FJsonValue>> *Meshes = nullptr, *Probes = nullptr;
	TArray<double> Bounds;
	int32 Buildings, Canopy, BatchCount, TriangleCount, BuildingStencil, TreeStencil;
	if (!(*Descriptor)->TryGetNumberField(TEXT("schema_version"), Version) || Version != 1
		|| !(*Descriptor)->TryGetStringField(TEXT("file"), File) || File != TEXT("context_geometry.json")
		|| !ReadJson(FPaths::GetPath(ManifestPath) / File, Data)
		|| !Data->TryGetNumberField(TEXT("schema_version"), Version) || Version != 1
		|| !Data->TryGetStringField(TEXT("frame"), Frame) || Frame != TEXT("east_north_up_m")
		|| !Data->TryGetStringField(TEXT("context_heightmap_sha256"), Hash) || Hash.Len() != 64
		|| !IsHexHash(Hash)
		|| !Numbers(Data->TryGetField(TEXT("bounds_enu_m")), 4, Bounds)
		|| !Data->TryGetNumberField(TEXT("primary_half_m"), Half) || !FMath::IsFinite(Half) || Half <= 0
		|| !Manifest->TryGetObjectField(TEXT("tile"), Tile) || !(*Tile)->TryGetNumberField(TEXT("size_m"), PrimarySize)
		|| !(*Context)->TryGetNumberField(TEXT("size_m"), ContextSize) || !FMath::IsFinite(ContextSize)
		|| !FMath::IsNearlyEqual(Half * 2, PrimarySize, 1.e-6)
		|| !FMath::IsNearlyEqual(Bounds[0], -ContextSize / 2, 1.e-6) || !FMath::IsNearlyEqual(Bounds[1], -ContextSize / 2, 1.e-6)
		|| !FMath::IsNearlyEqual(Bounds[2], ContextSize / 2, 1.e-6) || !FMath::IsNearlyEqual(Bounds[3], ContextSize / 2, 1.e-6)
		|| Bounds[0] >= -Half || Bounds[1] >= -Half || Bounds[2] <= Half || Bounds[3] <= Half
		|| !Data->TryGetObjectField(TEXT("counts"), Counts) || !Data->TryGetObjectField(TEXT("sources"), Sources)
		|| !Data->TryGetObjectField(TEXT("settings"), Settings) || !Data->TryGetArrayField(TEXT("meshes"), Meshes)
		|| !Data->TryGetArrayField(TEXT("ground_probes"), Probes) || Probes->Num() > 64
		|| !Count(**Counts, TEXT("buildings"), MAX_int32, Buildings) || !Count(**Counts, TEXT("canopy_clusters"), MAX_int32, Canopy)
		|| !Count(**Counts, TEXT("batches"), 1024, BatchCount) || !Count(**Counts, TEXT("triangles"), 1500000, TriangleCount)
		|| BatchCount != Meshes->Num() || !Manifest->TryGetObjectField(TEXT("stencil_classes"), Stencils)
		|| (TriangleCount > 0 && Probes->IsEmpty())
		|| !Count(**Stencils, TEXT("building"), 255, BuildingStencil) || BuildingStencil == 0
		|| !Count(**Stencils, TEXT("tree"), 255, TreeStencil) || TreeStencil == 0)
	{
		Error = TEXT("invalid context geometry schema or descriptor"); return false;
	}
	TArray<FVector> ParsedProbes;
	for (const auto& Probe : *Probes)
	{
		TArray<double> P;
		if (!Numbers(Probe, 3, P) || P[0] < Bounds[0] || P[0] > Bounds[2] || P[1] < Bounds[1] || P[1] > Bounds[3]
			|| (FMath::Abs(P[0]) <= Half && FMath::Abs(P[1]) <= Half))
		{ Error = TEXT("invalid context ground probe"); return false; }
		FVector V(P[1] * 100, P[0] * 100, P[2] * 100);
		if (V.ContainsNaN()) { Error = TEXT("context probe exceeds world range"); return false; }
		ParsedProbes.Add(V);
	}
	TArray<FBatch> Batches;
	TSet<FString> MeshKinds;
	int32 Total = 0;
	for (const auto& Row : *Meshes)
	{
		const TSharedPtr<FJsonObject>* Object = nullptr;
		const TArray<TSharedPtr<FJsonValue>> *Vertices = nullptr, *Triangles = nullptr, *Colours = nullptr;
		TArray<double> Origin;
		FBatch Batch;
		if (!Row.IsValid() || !Row->TryGetObject(Object) || !(*Object)->TryGetStringField(TEXT("kind"), Batch.Kind)
			|| (Batch.Kind != TEXT("building") && Batch.Kind != TEXT("canopy"))
			|| !Numbers((*Object)->TryGetField(TEXT("origin_enu_m")), 3, Origin)
			|| !(*Object)->TryGetArrayField(TEXT("vertices"), Vertices) || Vertices->IsEmpty() || Vertices->Num() > 60000
			|| !(*Object)->TryGetArrayField(TEXT("triangles"), Triangles) || Triangles->IsEmpty() || Triangles->Num() > 20000
			|| !(*Object)->TryGetArrayField(TEXT("colours"), Colours) || Colours->Num() != Triangles->Num())
		{ Error = TEXT("invalid context mesh"); return false; }
		Batch.Origin = FVector(Origin[1] * 100, Origin[0] * 100, Origin[2] * 100);
		if (Batch.Origin.ContainsNaN()) { Error = TEXT("invalid context origin"); return false; }
		for (const auto& Vertex : *Vertices)
		{
			TArray<double> V;
			if (!Numbers(Vertex, 3, V) || Origin[0] + V[0] < Bounds[0] - BoundaryToleranceM
				|| Origin[0] + V[0] > Bounds[2] + BoundaryToleranceM
				|| Origin[1] + V[1] < Bounds[1] - BoundaryToleranceM
				|| Origin[1] + V[1] > Bounds[3] + BoundaryToleranceM)
			{ Error = TEXT("context vertex outside bounds"); return false; }
			const double East = FMath::Clamp(Origin[0] + V[0], Bounds[0], Bounds[2]) - Origin[0];
			const double North = FMath::Clamp(Origin[1] + V[1], Bounds[1], Bounds[3]) - Origin[1];
			FVector P(North * 100, East * 100, V[2] * 100);
			FVector3f FloatP(P);
			if (P.ContainsNaN() || FloatP.ContainsNaN() || FVector3f(P + Batch.Origin).ContainsNaN()) { Error = TEXT("invalid context vertex range"); return false; }
			Batch.Vertices.Add(P);
		}
		for (int32 I = 0; I < Triangles->Num(); ++I)
		{
			TArray<double> T, C;
			if (!Numbers((*Triangles)[I], 3, T) || !Numbers((*Colours)[I], 3, C)
				|| T.ContainsByPredicate([&](double N) { return N < 0 || N >= Vertices->Num() || FMath::FloorToDouble(N) != N; })
				|| C.ContainsByPredicate([](double N) { return N < 0 || N > 1; }))
			{ Error = TEXT("invalid context triangle or colour"); return false; }
			FIntVector Indices(static_cast<int32>(T[0]), static_cast<int32>(T[1]), static_cast<int32>(T[2]));
			const FVector A = Batch.Vertices[Indices.X], B = Batch.Vertices[Indices.Y], D = Batch.Vertices[Indices.Z];
			const FVector3f AF(A), BF(B), DF(D);
			const FVector3f Cross = FVector3f::CrossProduct(BF-AF, DF-AF);
			if (FVector::CrossProduct(B-A, D-A).SizeSquared() <= 1.e-12
				|| Cross.ContainsNaN() || !FMath::IsFinite(Cross.SizeSquared()) || Cross.SizeSquared() <= 1.e-12f
				|| OverlapsPrimary(A + Batch.Origin, B + Batch.Origin, D + Batch.Origin, Half * 100))
			{ Error = TEXT("degenerate or primary-overlapping context triangle"); return false; }
			Batch.Triangles.Add(Indices);
			Batch.Colours.Emplace(C[0], C[1], C[2], 1);
		}
		Total += Batch.Triangles.Num();
		if (Total > 1500000) { Error = TEXT("context triangle budget exceeded"); return false; }
		MeshKinds.Add(Batch.Kind);
		Batches.Add(MoveTemp(Batch));
	}
	if (Total != TriangleCount || (BatchCount == 0 && (Buildings || Canopy)) || (BatchCount > 0 && !World))
	{ Error = TEXT("context counts or world invalid"); return false; }
	if ((Buildings > 0) != MeshKinds.Contains(TEXT("building")) || (Canopy > 0) != MeshKinds.Contains(TEXT("canopy")))
	{ Error = TEXT("context feature counts disagree with mesh kinds"); return false; }

	State.bPresent = true;
	State.GroundProbesCm = MoveTemp(ParsedProbes);
	State.Counts = *Counts;
	if (Batches.IsEmpty()) return true;
	UMaterial* Material = Asset<UMaterial>(TEXT("M_EnvGenContext"), Packages);
	auto* Colour = CastChecked<UMaterialExpressionVertexColor>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionVertexColor::StaticClass()));
	UMaterialEditingLibrary::ConnectMaterialProperty(Colour, TEXT("RGB"), MP_BaseColor);
	auto* Roughness = CastChecked<UMaterialExpressionConstant>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionConstant::StaticClass()));
	Roughness->R = .9f;
	UMaterialEditingLibrary::ConnectMaterialProperty(Roughness, TEXT(""), MP_Roughness);
	UMaterialEditingLibrary::RecompileMaterial(Material);
	for (int32 Index = 0; Index < Batches.Num(); ++Index)
	{
		const FBatch& Batch = Batches[Index];
		FMeshDescription Description;
		FStaticMeshAttributes Attributes(Description);
		Attributes.Register();
		auto Positions = Attributes.GetVertexPositions();
		auto Normals = Attributes.GetVertexInstanceNormals();
		auto Colours = Attributes.GetVertexInstanceColors();
		auto UVs = Attributes.GetVertexInstanceUVs();
		UVs.SetNumChannels(1);
		const FPolygonGroupID Group = Description.CreatePolygonGroup();
		Attributes.GetPolygonGroupMaterialSlotNames()[Group] = TEXT("Context");
		for (int32 I = 0; I < Batch.Triangles.Num(); ++I)
		{
			const FIntVector T = Batch.Triangles[I];
			const FVector3f P[] = {FVector3f(Batch.Vertices[T.X]), FVector3f(Batch.Vertices[T.Y]), FVector3f(Batch.Vertices[T.Z])};
			const FVector3f Normal = -FVector3f::CrossProduct(P[1]-P[0], P[2]-P[0]).GetSafeNormal();
			FVertexInstanceID Corners[3];
			for (int32 J = 0; J < 3; ++J)
			{
				const FVertexID Vertex = Description.CreateVertex();
				Positions[Vertex] = P[J];
				Corners[J] = Description.CreateVertexInstance(Vertex);
				Normals[Corners[J]] = Normal;
				Colours[Corners[J]] = FVector4f(Batch.Colours[I].R, Batch.Colours[I].G, Batch.Colours[I].B, 1);
				UVs.Set(Corners[J], 0, FVector2f::ZeroVector);
			}
			Description.CreatePolygon(Group, {Corners[0], Corners[1], Corners[2]});
		}
		UStaticMesh* Mesh = Asset<UStaticMesh>(FString::Printf(TEXT("SM_EnvGenContext_%04d"), Index), Packages);
		Mesh->GetStaticMaterials().Add(FStaticMaterial(Material, TEXT("Context")));
		Mesh->GetNaniteSettings().bEnabled = false;
		UStaticMesh::FBuildMeshDescriptionsParams Params;
		Params.bFastBuild = false;
		Params.bBuildSimpleCollision = false;
		Mesh->BuildFromMeshDescriptions({&Description}, Params);
		FStaticMeshCompilingManager::Get().FinishCompilation({Mesh});
		if (Mesh->GetNumTriangles(0) != Batch.Triangles.Num())
		{ Error = TEXT("context mesh build lost triangles"); return false; }
		AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(Batch.Origin, FRotator::ZeroRotator);
		if (!Actor) { Error = TEXT("cannot spawn context actor"); return false; }
		Actor->SetActorLabel(FString::Printf(TEXT("EnvGenContext_%04d_%s"), Index, *Batch.Kind));
		State.Actors.Add(Actor);
		auto* Component = Actor->GetStaticMeshComponent();
		Component->SetMobility(EComponentMobility::Static);
		Component->SetStaticMesh(Mesh);
		Component->SetCollisionProfileName(TEXT("NoCollision"));
		Component->SetCanEverAffectNavigation(false);
		Component->SetCastShadow(false);
		Component->bAffectDistanceFieldLighting = false;
		Component->bAffectDynamicIndirectLighting = false;
		Component->SetRenderCustomDepth(true);
		Component->SetCustomDepthStencilValue(Batch.Kind == TEXT("building") ? BuildingStencil : TreeStencil);
	}
	return true;
}

bool FinishEnvGenContext(ALandscape* ContextLandscape, const FEnvGenContextState& State,
	TSharedRef<FJsonObject> Receipt, FString& Error)
{
	Receipt->SetBoolField(TEXT("context_geometry_present"), State.bPresent);
	if (!State.bPresent) return true;
	if (!ContextLandscape) { Error = TEXT("context geometry needs a context landscape"); return false; }
	int32 ActualTriangles = 0;
	for (AActor* Actor : State.Actors)
	{
		const AStaticMeshActor* MeshActor = Cast<AStaticMeshActor>(Actor);
		const UStaticMeshComponent* Component = MeshActor ? MeshActor->GetStaticMeshComponent() : nullptr;
		const UStaticMesh* Mesh = Component ? Component->GetStaticMesh() : nullptr;
		if (!IsValid(MeshActor) || !IsValid(Mesh) || Component->GetCollisionEnabled() != ECollisionEnabled::NoCollision)
		{ Error = TEXT("context actor or mesh invalid"); return false; }
		ActualTriangles += Mesh->GetNumTriangles(0);
	}
	int32 ExpectedTriangles = 0;
	if (!State.Counts.IsValid() || !Count(*State.Counts, TEXT("triangles"), 1500000, ExpectedTriangles) || ActualTriangles != ExpectedTriangles)
	{ Error = TEXT("context mesh triangle count mismatch"); return false; }
	TArray<ULandscapeHeightfieldCollisionComponent*> Components;
	ContextLandscape->GetComponents(Components);
	double WorstCm = 0;
	for (const FVector& Probe : State.GroundProbesCm)
	{
		bool HitGround = false;
		double Best = TNumericLimits<double>::Max();
		for (ULandscapeHeightfieldCollisionComponent* Component : Components)
		{
			FHitResult Hit;
			if (Component && Component->LineTraceComponent(Hit, Probe + FVector(0, 0, 200000), Probe - FVector(0, 0, 200000), FCollisionQueryParams()))
			{
				HitGround = true;
				Best = FMath::Min(Best, FMath::Abs(Hit.ImpactPoint.Z - Probe.Z));
			}
		}
		if (!HitGround || Best > 5) { Error = TEXT("context landscape ground probe failed"); return false; }
		WorstCm = FMath::Max(WorstCm, Best);
	}
	Receipt->SetObjectField(TEXT("context_geometry_counts"), State.Counts.ToSharedRef());
	Receipt->SetNumberField(TEXT("context_geometry_actors"), State.Actors.Num());
	Receipt->SetNumberField(TEXT("context_ground_probes"), State.GroundProbesCm.Num());
	Receipt->SetNumberField(TEXT("context_ground_probe_worst_error_cm"), WorstCm);
	return true;
}
