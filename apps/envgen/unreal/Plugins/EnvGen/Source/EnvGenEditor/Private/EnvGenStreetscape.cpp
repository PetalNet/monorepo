#include "EnvGenStreetscape.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "EnvGenSiteInfo.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionComponentMask.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionMaterialFunctionCall.h"
#include "Materials/MaterialExpressionWorldPosition.h"
#include "Materials/MaterialExpressionTextureCoordinate.h"
#include "Materials/MaterialFunction.h"
#include "MeshDescription.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "PhysicsEngine/BodySetup.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "StaticMeshAttributes.h"
#include "StaticMeshCompiler.h"
#include "UObject/Package.h"

namespace
{
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

	struct FFinish
	{
		FLinearColor Albedo;
		float Roughness;
		float Metallic;
		int32 Pattern;
	};

	const TMap<FString, FFinish> Finishes = {
		{TEXT("asphalt"), {FLinearColor(.065f, .068f, .072f), .88f, 0, 1}},
		{TEXT("concrete"), {FLinearColor(.32f, .31f, .28f), .86f, 0, 2}},
		{TEXT("track"), {FLinearColor(.20f, .065f, .055f), .93f, 0, 3}},
		{TEXT("gravel"), {FLinearColor(.24f, .22f, .18f), .95f, 0, 4}},
		{TEXT("clay"), {FLinearColor(.34f, .23f, .14f), .97f, 0, 4}},
		{TEXT("paint_white"), {FLinearColor(.64f, .63f, .57f), .83f, 0, 5}},
		{TEXT("paint_yellow"), {FLinearColor(.72f, .48f, .045f), .8f, 0, 5}},
		{TEXT("steel"), {FLinearColor(.26f, .28f, .29f), .55f, .8f, 0}},
		{TEXT("aluminum"), {FLinearColor(.46f, .48f, .49f), .46f, .85f, 0}},
		{TEXT("wood"), {FLinearColor(.19f, .115f, .058f), .87f, 0, 4}},
		{TEXT("steel_yellow"), {FLinearColor(.72f, .47f, .035f), .65f, .1f, 0}},
		{TEXT("lamp_dark"), {FLinearColor(.025f, .029f, .033f), .4f, .2f, 0}},
		{TEXT("net"), {FLinearColor(.32f, .34f, .32f), .9f, 0, 0}},
		{TEXT("chainlink"), {FLinearColor(.26f, .28f, .29f), .6f, .8f, 0}},
	};

	UMaterial* MakeMaterial(const FString& Name, const FFinish& Finish, TArray<UPackage*>& Packages)
	{
		UMaterial* Material = Asset<UMaterial>(TEXT("M_Streetscape_") + Name, Packages);
		const auto Constant = [&](float Value)
		{
			auto* Expression = CastChecked<UMaterialExpressionConstant>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionConstant::StaticClass()));
			Expression->R = Value;
			return Expression;
		};
		auto* Position = CastChecked<UMaterialExpressionWorldPosition>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionWorldPosition::StaticClass()));
		auto* Pattern = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCustom::StaticClass()));
		Pattern->Inputs.Empty();
		FCustomInput& Input = Pattern->Inputs.AddDefaulted_GetRef();
		Input.InputName = TEXT("P");
		Input.Input.Connect(0, Position);
		Pattern->OutputType = CMOT_Float4;
		// Frequencies and finish colours are material priors, never placement evidence. Filter the aggregate when
		// its cells are smaller than a pixel, keeping distant asphalt from turning into a shimmering stipple.
		Pattern->Code = FString::Printf(TEXT(R"HLSL(
struct Noise {
 float hash(float2 p) { return frac(sin(dot(p,float2(127.1,311.7)))*43758.5453); }
 float value(float2 p) {
  float2 i=floor(p), f=frac(p); f=f*f*(3-2*f);
  return lerp(lerp(hash(i),hash(i+float2(1,0)),f.x),lerp(hash(i+float2(0,1)),hash(i+1),f.x),f.y);
 }
};
Noise n;
float2 q=P.xy*.01;
float broad=n.value(q*.35), wear=n.value(q*2.7);
float visible=saturate(1-length(fwidth(q*140)));
float aggregate=lerp(.5,n.hash(floor(q*140)),visible);
float modulation=.90+.14*broad+.12*(aggregate-.5);
float crack=0;
if (%d==1) {
 float2 warp=q+float2(sin(q.y*.8),sin(q.x*.7))*.24;
 float2 seam=abs(frac(warp/4)-.5)*4;
 float fw=max(length(fwidth(q)),.0001);
 crack=(1-smoothstep(max(0.,.008-fw),.008+fw,min(seam.x,seam.y)))*min(1.,.008/fw)*step(.62,n.value(q*.13));
 modulation*=1-.62*crack;
}
if (%d==2) {
 float2 joint=abs(frac(q/3)-.5)*3;
 float fw=max(length(fwidth(q)),.0001);
 crack=(1-smoothstep(max(0.,.012-fw),.012+fw,min(joint.x,joint.y)))*min(1.,.012/fw);
 modulation*=1-.48*crack;
}
if (%d==3) modulation*=.9+.16*wear;
if (%d==4) modulation*=.80+.32*wear;
if (%d==5) modulation*=.83+.17*wear;
return float4(float3(%.5f,%.5f,%.5f)*modulation,saturate(%.5f+.08*(wear-.5)+.08*crack));
)HLSL"), Finish.Pattern, Finish.Pattern, Finish.Pattern, Finish.Pattern, Finish.Pattern,
			Finish.Albedo.R, Finish.Albedo.G, Finish.Albedo.B, Finish.Roughness);
		auto* Colour = CastChecked<UMaterialExpressionComponentMask>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionComponentMask::StaticClass()));
		Colour->Input.Connect(0, Pattern);
		Colour->R = Colour->G = Colour->B = true;
		Colour->A = false;
		auto* Rough = CastChecked<UMaterialExpressionComponentMask>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionComponentMask::StaticClass()));
		Rough->Input.Connect(0, Pattern);
		Rough->R = Rough->G = Rough->B = false;
		Rough->A = true;
		UMaterialEditingLibrary::ConnectMaterialProperty(Colour, TEXT(""), MP_BaseColor);
		UMaterialEditingLibrary::ConnectMaterialProperty(Rough, TEXT(""), MP_Roughness);
		UMaterialEditingLibrary::ConnectMaterialProperty(Constant(Finish.Metallic), TEXT(""), MP_Metallic);
		if (Name == TEXT("chainlink"))
		{
			Material->BlendMode = BLEND_Masked;
			Material->TwoSided = true;
			auto* Coordinates = CastChecked<UMaterialExpressionTextureCoordinate>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureCoordinate::StaticClass()));
			auto* Fabric = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCustom::StaticClass()));
			Fabric->Inputs.Empty();
			Fabric->OutputType = CMOT_Float1;
			FCustomInput& Place = Fabric->Inputs.AddDefaulted_GetRef();
			Place.InputName = TEXT("UV");
			Place.Input.Connect(0, Coordinates);
			Fabric->Code = TEXT("float2 cell=abs(frac(float2(UV.x+UV.y,UV.x-UV.y)*10)-.5)*.1; float fw=max(length(fwidth(UV)),.0001); float nearCoverage=(1-smoothstep(max(0.,.001-fw),.002+fw,min(cell.x,cell.y)))*min(1.,.002/fw); return lerp(nearCoverage,.06,saturate((fw-.02)/.05));");
			auto* Dither = CastChecked<UMaterialExpressionMaterialFunctionCall>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionMaterialFunctionCall::StaticClass()));
			UMaterialFunction* Function = LoadObject<UMaterialFunction>(nullptr, TEXT("/Engine/Functions/Engine_MaterialFunctions02/Utility/DitherTemporalAA.DitherTemporalAA"));
			if (!Function || !Dither->SetMaterialFunction(Function) || Dither->FunctionInputs.IsEmpty()) return nullptr;
			Dither->FunctionInputs[0].Input.Connect(0, Fabric);
			UMaterialEditingLibrary::ConnectMaterialProperty(Dither, TEXT(""), MP_OpacityMask);
		}
		UMaterialEditingLibrary::RecompileMaterial(Material);
		return Material;
	}

	bool ReadJson(const FString& Path, TSharedPtr<FJsonObject>& Root)
	{
		FString Text;
		return FFileHelper::LoadFileToString(Text, *Path) && FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) && Root.IsValid();
	}

	bool Numbers(const TSharedPtr<FJsonValue>& Value, int32 Size, TArray<double>& Out)
	{
		if (!Value || Value->Type != EJson::Array || Value->AsArray().Num() != Size) return false;
		Out.Reset();
		for (const auto& Number : Value->AsArray())
		{
			if (!Number || Number->Type != EJson::Number || !FMath::IsFinite(Number->AsNumber())) return false;
			Out.Add(Number->AsNumber());
		}
		return true;
	}
}

bool BuildEnvGenStreetscape(UWorld* World, const FString& ManifestPath,
	TFunctionRef<double(double, double)> SurfaceHeight,
	TArray<UPackage*>& Packages, TArray<AActor*>& Actors, TSharedRef<FJsonObject> Receipt, FString& Error)
{
	TSharedPtr<FJsonObject> Manifest;
	if (!ReadJson(ManifestPath, Manifest))
	{
		Error = TEXT("cannot read streetscape build manifest");
		return false;
	}
	const TSharedPtr<FJsonObject>* Stage = nullptr;
	Receipt->SetNumberField(TEXT("streetscape_features"), 0);
	Receipt->SetNumberField(TEXT("streetscape_triangles"), 0);
	if (!Manifest->TryGetObjectField(TEXT("streetscape"), Stage))
	{
		if (Manifest->HasField(TEXT("streetscape")))
		{
			Error = TEXT("streetscape must be an object");
			return false;
		}
		return true;
	}
	TSharedPtr<FJsonObject> Inventory;
	const TArray<TSharedPtr<FJsonValue>>* Rows = nullptr;
	const TSharedPtr<FJsonObject>* Counts = nullptr;
	const TSharedPtr<FJsonObject>* Stencils = nullptr;
	FString InventoryFile;
	double Version = 0, FeatureCount = 0;
	if (!(*Stage)->TryGetStringField(TEXT("file"), InventoryFile) || InventoryFile.IsEmpty()
		|| !ReadJson(FPaths::GetPath(ManifestPath) / InventoryFile, Inventory)
		|| !Inventory->TryGetNumberField(TEXT("schema_version"), Version) || Version != 1
		|| !Inventory->TryGetNumberField(TEXT("feature_count"), FeatureCount) || !FMath::IsFinite(FeatureCount)
		|| FeatureCount < 0 || FeatureCount > MAX_int32 || FMath::FloorToDouble(FeatureCount) != FeatureCount
		|| !Inventory->TryGetObjectField(TEXT("counts"), Counts) || !Inventory->TryGetArrayField(TEXT("meshes"), Rows)
		|| (FeatureCount > 0 && Rows->IsEmpty())
		|| !Manifest->TryGetObjectField(TEXT("stencil_classes"), Stencils))
	{
		Error = TEXT("cannot read streetscape geometry schema 1");
		return false;
	}
	TMap<FString, int32> StencilIds;
	for (const FString& Key : {FString(TEXT("ground")), FString(TEXT("road")), FString(TEXT("prop")), FString(TEXT("marking"))})
	{
		double Id = 0;
		if (!(*Stencils)->TryGetNumberField(Key, Id) || !FMath::IsFinite(Id) || Id < 1 || Id > 255 || FMath::FloorToDouble(Id) != Id)
		{
			Error = TEXT("streetscape needs stencil class ") + Key;
			return false;
		}
		StencilIds.Add(Key, int32(Id));
	}
	TMap<FString, UMaterial*> Materials;
	struct FPendingMesh
	{
		FMeshDescription Description;
		FString Name;
		bool bCollision;
		bool bAnchored;
	};
	TArray<FPendingMesh> Pending;
	int32 TotalTriangles = 0;
	int32 PrecisionSlivers = 0;
	for (int32 Index = 0; Index < Rows->Num(); ++Index)
	{
		if (!(*Rows)[Index] || (*Rows)[Index]->Type != EJson::Object)
		{
			Error = FString::Printf(TEXT("streetscape mesh %d must be an object"), Index);
			return false;
		}
		const TSharedPtr<FJsonObject> Row = (*Rows)[Index]->AsObject();
		FString Name;
		const TArray<TSharedPtr<FJsonValue>>* Points = nullptr;
		const TArray<TSharedPtr<FJsonValue>>* Triangles = nullptr;
		bool bCollision = false;
		if (!Row || !Row->TryGetStringField(TEXT("material"), Name) || !Row->TryGetArrayField(TEXT("vertices"), Points)
			|| Points->IsEmpty() || !Row->TryGetArrayField(TEXT("triangles"), Triangles) || Triangles->IsEmpty()
			|| !Row->TryGetBoolField(TEXT("collision"), bCollision))
		{
			Error = FString::Printf(TEXT("streetscape mesh %d needs material, nonempty vertices/triangles and collision"), Index);
			return false;
		}
		const FFinish* Finish = Finishes.Find(Name);
		if (!Finish)
		{
			Error = TEXT("unknown streetscape finish: ") + Name;
			return false;
		}
		TArray<double> Anchor;
		const bool bAnchored = Row->HasField(TEXT("anchor_m"));
		if (bAnchored && !Numbers(Row->TryGetField(TEXT("anchor_m")), 2, Anchor))
		{
			Error = FString::Printf(TEXT("invalid anchor in streetscape mesh %d"), Index);
			return false;
		}
		const double Base = bAnchored ? SurfaceHeight(Anchor[1] * 100, Anchor[0] * 100) : 0;
		TArray<FVector3f> Vertices;
		TArray<FVector> PreciseVertices;
		for (const auto& Point : *Points)
		{
			TArray<double> P;
			if (!Numbers(Point, 3, P))
			{
				Error = FString::Printf(TEXT("invalid vertex in streetscape mesh %d"), Index);
				return false;
			}
			const double North = P[1] * 100, East = P[0] * 100;
			const double Ground = bAnchored ? Base : SurfaceHeight(North, East);
			const FVector3f Position(North, East, Ground + P[2] * 100);
			if (Position.ContainsNaN())
			{
				Error = FString::Printf(TEXT("vertex exceeds world precision in streetscape mesh %d"), Index);
				return false;
			}
			Vertices.Add(Position);
			PreciseVertices.Add(FVector(North, East, Ground + P[2] * 100));
		}
		FMeshDescription Description;
		FStaticMeshAttributes Attributes(Description);
		Attributes.Register();
		auto Positions = Attributes.GetVertexPositions();
		auto Normals = Attributes.GetVertexInstanceNormals();
		auto UVs = Attributes.GetVertexInstanceUVs();
		UVs.SetNumChannels(1);
		const FPolygonGroupID Group = Description.CreatePolygonGroup();
		Attributes.GetPolygonGroupMaterialSlotNames()[Group] = FName(*Name);
		for (const auto& Triangle : *Triangles)
		{
			TArray<double> T;
			if (!Numbers(Triangle, 3, T) || T.ContainsByPredicate([&](double V) { return V < 0 || V >= Vertices.Num() || FMath::FloorToDouble(V) != V; }))
			{
				Error = FString::Printf(TEXT("invalid triangle in streetscape mesh %d"), Index);
				return false;
			}
			// EN to NE swaps handedness: UE polygons face opposite their cross product, matching the inventory.
			const FVector3f A = Vertices[int32(T[0])], B = Vertices[int32(T[1])], C = Vertices[int32(T[2])];
			const FVector DA = PreciseVertices[int32(T[0])], DB = PreciseVertices[int32(T[1])], DC = PreciseVertices[int32(T[2])];
			if (T[0] == T[1] || T[1] == T[2] || T[0] == T[2])
			{
				Error = FString::Printf(TEXT("degenerate triangle in streetscape mesh %d"), Index);
				return false;
			}
			if (FVector::CrossProduct(DB - DA, DC - DA).SizeSquared() == 0 || FVector3f::CrossProduct(B - A, C - A).SizeSquared() <= 1.e-12f)
			{
				++PrecisionSlivers;
				continue;
			}
			const FVector3f Normal = -FVector3f::CrossProduct(B - A, C - A).GetSafeNormal();
			FVertexInstanceID Corners[3];
			const FVector3f P[] = {A, B, C};
			for (int32 I = 0; I < 3; ++I)
			{
				const FVertexID V = Description.CreateVertex();
				Positions[V] = P[I];
				Corners[I] = Description.CreateVertexInstance(V);
				Normals[Corners[I]] = Normal;
				FVector2f UV;
				if (Name == TEXT("chainlink"))
				{
					UV = FVector2f(FVector3f::DotProduct(P[I], FVector3f(-Normal.Y, Normal.X, 0)), P[I].Z);
				}
				else if (FMath::Abs(Normal.Z) > .5f)
				{
					UV = FVector2f(P[I].X, P[I].Y);
				}
				else
				{
					UV = FVector2f(FMath::Abs(Normal.X) > FMath::Abs(Normal.Y) ? P[I].Y : P[I].X, P[I].Z);
				}
				UVs.Set(Corners[I], 0, UV * .01f);
			}
			Description.CreatePolygon(Group, {Corners[0], Corners[1], Corners[2]});
		}
		if (Description.Triangles().Num() > 0) Pending.Add({MoveTemp(Description), Name, bCollision, bAnchored});
	}
	if (Pending.IsEmpty() && FeatureCount > 0)
	{
		Error = TEXT("streetscape has no representable geometry");
		return false;
	}
	if (!Pending.IsEmpty() && !World)
	{
		Error = TEXT("streetscape needs a world after validation");
		return false;
	}
	for (int32 Index = 0; Index < Pending.Num(); ++Index)
	{
		FPendingMesh& Item = Pending[Index];
		const FString& Name = Item.Name;
		FMeshDescription& Description = Item.Description;
		const bool bCollision = Item.bCollision, bAnchored = Item.bAnchored;
		if (!Materials.Contains(Name))
		{
			UMaterial* Material = MakeMaterial(Name, Finishes.FindChecked(Name), Packages);
			if (!Material)
			{
				Error = TEXT("cannot load the engine's DitherTemporalAA function for chainlink");
				return false;
			}
			Materials.Add(Name, Material);
		}
		UStaticMesh* Mesh = Asset<UStaticMesh>(FString::Printf(TEXT("SM_Streetscape_%04d"), Index), Packages);
		Mesh->GetStaticMaterials().Add(FStaticMaterial(Materials[Name], FName(*Name)));
		// Small surface ribbons retain their exact outline; solid props can use Nanite and Lumen mesh cards.
		Mesh->GetNaniteSettings().bEnabled = Name != TEXT("chainlink") && Name != TEXT("net") && (bCollision || !Name.StartsWith(TEXT("paint_")));
		Mesh->GetNaniteSettings().FallbackPercentTriangles = 1;
		Mesh->GetNaniteSettings().FallbackRelativeError = 0;
		UStaticMesh::FBuildMeshDescriptionsParams Params;
		Params.bFastBuild = false;
		Params.bBuildSimpleCollision = false;
		Mesh->BuildFromMeshDescriptions({&Description}, Params);
		FStaticMeshCompilingManager::Get().FinishCompilation({Mesh});
		if (bCollision)
		{
			Mesh->CreateBodySetup();
			Mesh->GetBodySetup()->CollisionTraceFlag = CTF_UseComplexAsSimple;
			Mesh->GetBodySetup()->bDoubleSidedGeometry = Name == TEXT("chainlink");
			Mesh->GetBodySetup()->InvalidatePhysicsData();
			Mesh->GetBodySetup()->CreatePhysicsMeshes();
		}
		AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>();
		Actor->SetActorLabel(FString::Printf(TEXT("EnvGenStreetscape_%04d_%s"), Index, *Name));
		Actor->Tags.Add(EnvGenStandingTag());
		Actors.Add(Actor);
		auto* Component = Actor->GetStaticMeshComponent();
		Component->SetMobility(EComponentMobility::Static);
		Component->SetStaticMesh(Mesh);
		Component->SetCollisionProfileName(bCollision ? TEXT("BlockAll") : TEXT("NoCollision"));
		Component->SetCastShadow(bCollision);
		Component->SetRenderCustomDepth(true);
		const FString StencilClass = bAnchored || bCollision ? TEXT("prop")
			: Name.StartsWith(TEXT("paint_")) ? TEXT("marking")
			: Name == TEXT("asphalt") || Name == TEXT("concrete") ? TEXT("road") : TEXT("ground");
		Component->SetCustomDepthStencilValue(StencilIds[StencilClass]);
		TotalTriangles += Description.Triangles().Num();
	}
	Receipt->SetNumberField(TEXT("streetscape_features"), FeatureCount);
	Receipt->SetNumberField(TEXT("streetscape_meshes"), Pending.Num());
	Receipt->SetNumberField(TEXT("streetscape_precision_slivers_skipped"), PrecisionSlivers);
	Receipt->SetNumberField(TEXT("streetscape_triangles"), TotalTriangles);
	Receipt->SetObjectField(TEXT("streetscape_counts"), *Counts);
	TSharedRef<FJsonObject> MaterialPriors = MakeShared<FJsonObject>();
	for (const auto& Pair : Finishes)
	{
		TSharedRef<FJsonObject> Values = MakeShared<FJsonObject>();
		Values->SetArrayField(TEXT("linear_albedo"), {MakeShared<FJsonValueNumber>(Pair.Value.Albedo.R), MakeShared<FJsonValueNumber>(Pair.Value.Albedo.G), MakeShared<FJsonValueNumber>(Pair.Value.Albedo.B)});
		Values->SetNumberField(TEXT("roughness"), Pair.Value.Roughness);
		Values->SetNumberField(TEXT("metallic"), Pair.Value.Metallic);
		MaterialPriors->SetObjectField(Pair.Key, Values);
	}
	MaterialPriors->SetNumberField(TEXT("aggregate_cells_per_m"), 140);
	MaterialPriors->SetNumberField(TEXT("concrete_joint_spacing_m"), 3);
	MaterialPriors->SetNumberField(TEXT("asphalt_crack_spacing_m"), 4);
	Receipt->SetObjectField(TEXT("streetscape_material_priors"), MaterialPriors);
	return true;
}
