#include "EnvGenStreetscape.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "EnvGenSiteInfo.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Landscape.h"
#include "LandscapeComponent.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionComponentMask.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionMaterialFunctionCall.h"
#include "Materials/MaterialExpressionWorldPosition.h"
#include "Materials/MaterialExpressionTextureCoordinate.h"
#include "Materials/MaterialExpressionTextureSample.h"
#include "Materials/MaterialExpressionTextureObject.h"
#include "Materials/MaterialExpressionVertexNormalWS.h"
#include "Materials/MaterialFunction.h"
#include "MeshDescription.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
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
		{TEXT("turf"), {FLinearColor(.065f, .08f, .0375f), .96f, 0, 0}},
		{TEXT("natural_grass"), {FLinearColor(.065f, .08f, .0375f), .96f, 0, 0}},
		{TEXT("athletic_turf"), {FLinearColor::FromSRGBColor(FColor(48, 100, 56)), .78f, 0, 0}},
		{TEXT("grass_paint_white"), {FLinearColor(.723f, .716f, .791f), .96f, 0, 0}},
		{TEXT("grass_paint_yellow"), {FLinearColor(.72f, .48f, .045f), .96f, 0, 0}},
		{TEXT("paint_white"), {FLinearColor(.723f, .716f, .791f), .83f, 0, 5}},
		{TEXT("paint_yellow"), {FLinearColor(.72f, .48f, .045f), .8f, 0, 5}},
		{TEXT("steel"), {FLinearColor(.26f, .28f, .29f), .55f, .8f, 0}},
		{TEXT("aluminum"), {FLinearColor(.46f, .48f, .49f), .46f, .85f, 0}},
		{TEXT("wood"), {FLinearColor(.19f, .115f, .058f), .87f, 0, 4}},
		{TEXT("steel_yellow"), {FLinearColor(.72f, .47f, .035f), .65f, .1f, 0}},
		{TEXT("lamp_dark"), {FLinearColor(.025f, .029f, .033f), .4f, .2f, 0}},
		{TEXT("net"), {FLinearColor(.32f, .34f, .32f), .9f, 0, 0}},
		{TEXT("chainlink"), {FLinearColor(.26f, .28f, .29f), .6f, .8f, 0}},
	};

	UMaterial* MakeMaterial(const FString& Name, const FFinish& Finish, TArray<UPackage*>& Packages, UTexture2D* PaintImage = nullptr)
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
if (%d==5) modulation=1;
#if %d
float3 colour=PaintColour*modulation;
#else
float3 colour=float3(%.5f,%.5f,%.5f)*modulation;
#endif
#if %d
float2 blade=q*float2(65,230);
float bladeVisible=1-smoothstep(.25,1.,max(fwidth(blade.x),fwidth(blade.y)));
float grain=lerp(.5,n.value(blade),bladeVisible);
Coverage=lerp(1.,smoothstep(.08,.20,grain),bladeVisible);
#if %d
Coverage*=PaintAlpha;
#endif
float fade=.84+.12*grain;
colour=lerp(float3(.065,.08,.0375)*modulation,colour,fade);
#endif
return float4(colour,saturate(%.5f+.08*(wear-.5)+.08*crack));
)HLSL"), Finish.Pattern, Finish.Pattern, Finish.Pattern, Finish.Pattern, Finish.Pattern,
			PaintImage ? 1 : 0, Finish.Albedo.R, Finish.Albedo.G, Finish.Albedo.B,
			Name.StartsWith(TEXT("grass_paint_")) ? 1 : 0, PaintImage ? 1 : 0, Finish.Roughness);
		if (PaintImage)
		{
			auto* Sample = CastChecked<UMaterialExpressionTextureSample>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureSample::StaticClass()));
			Sample->Texture = PaintImage;
			Sample->SamplerType = SAMPLERTYPE_Color;
			FCustomInput& ColourInput = Pattern->Inputs.AddDefaulted_GetRef();
			ColourInput.InputName = TEXT("PaintColour");
			ColourInput.Input.Connect(0, Sample);
			FCustomInput& AlphaInput = Pattern->Inputs.AddDefaulted_GetRef();
			AlphaInput.InputName = TEXT("PaintAlpha");
			AlphaInput.Input.Connect(4, Sample);
		}
		if (Name.StartsWith(TEXT("grass_paint_")))
		{
			Material->BlendMode = BLEND_Masked;
			Material->OpacityMaskClipValue = .333f;
			FCustomOutput& Coverage = Pattern->AdditionalOutputs.AddDefaulted_GetRef();
			Coverage.OutputName = TEXT("Coverage");
			Coverage.OutputType = CMOT_Float1;
			// Match turf's world-space distribution; a thin paint coat keeps the terrain normal.
			Pattern->RebuildOutputs();
			UMaterialEditingLibrary::ConnectMaterialProperty(Pattern, TEXT("Coverage"), MP_OpacityMask);
		}
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

	struct FDecalImage
	{
		TArray64<uint8> Pixels;
		int32 Width = 0;
		int32 Height = 0;
		bool bOpaque = true;
	};

	bool ReadDecal(const FString& Path, FDecalImage& Out)
	{
		TArray64<uint8> Compressed;
		if (!FFileHelper::LoadFileToArray(Compressed, *Path) || Compressed.Num() < 33
			|| Compressed[24] != 8 || Compressed[25] != 6) return false;
		IImageWrapperModule& Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
		const TSharedPtr<IImageWrapper> Wrapper = Module.CreateImageWrapper(EImageFormat::PNG);
		if (!Wrapper || !Wrapper->SetCompressed(Compressed.GetData(), Compressed.Num())
			|| !Wrapper->GetRaw(ERGBFormat::BGRA, 8, Out.Pixels)) return false;
		Out.Width = Wrapper->GetWidth();
		Out.Height = Wrapper->GetHeight();
		if (Out.Width <= 0 || Out.Height <= 0 || Out.Pixels.Num() != int64(Out.Width) * Out.Height * 4) return false;
		bool bVisible = false;
		Out.bOpaque = true;
		for (int64 I = 3; I < Out.Pixels.Num(); I += 4)
		{
			bVisible |= Out.Pixels[I] >= 85;
			Out.bOpaque &= Out.Pixels[I] == 255;
		}
		return bVisible;
	}

	UTexture2D* MakeRegisteredTexture(int32 Index, const FDecalImage& Image, bool bOpaque, TArray<UPackage*>& Packages)
	{
		UTexture2D* Texture = Asset<UTexture2D>(FString::Printf(TEXT("T_StreetscapeDecal_%04d"), Index), Packages);
		Texture->Source.Init(Image.Width, Image.Height, 1, 1, TSF_BGRA8, Image.Pixels.GetData());
		Texture->SRGB = true;
		Texture->CompressionSettings = TC_Default;
		Texture->LODGroup = TEXTUREGROUP_World;
		Texture->AddressX = Texture->AddressY = TA_Clamp;
		Texture->bDoScaleMipsForAlphaCoverage = !bOpaque;
		if (!bOpaque) Texture->AlphaCoverageThresholds = FVector4(0, 0, 0, .333f);
		Texture->PostEditChange();
		return Texture;
	}

	UMaterial* MakeDecalMaterial(int32 Index, const FDecalImage& Image, TArray<UPackage*>& Packages, bool bGrassPaint)
	{
		UTexture2D* Texture = MakeRegisteredTexture(Index, Image, false, Packages);
		if (bGrassPaint)
			return MakeMaterial(FString::Printf(TEXT("grass_paint_decal_%04d"), Index), Finishes.FindChecked(TEXT("grass_paint_white")), Packages, Texture);
		UMaterial* Material = Asset<UMaterial>(FString::Printf(TEXT("M_StreetscapeDecal_%04d"), Index), Packages);
		Material->BlendMode = BLEND_Masked;
		Material->OpacityMaskClipValue = .333f;
		auto* Sample = CastChecked<UMaterialExpressionTextureSample>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureSample::StaticClass()));
		Sample->Texture = Texture;
		Sample->SamplerType = SAMPLERTYPE_Color;
		UMaterialEditingLibrary::ConnectMaterialProperty(Sample, TEXT("RGB"), MP_BaseColor);
		UMaterialEditingLibrary::ConnectMaterialProperty(Sample, TEXT("A"), MP_OpacityMask);
		auto* Roughness = CastChecked<UMaterialExpressionConstant>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionConstant::StaticClass()));
		Roughness->R = .83f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Roughness, TEXT(""), MP_Roughness);
		UMaterialEditingLibrary::RecompileMaterial(Material);
		return Material;
	}

	UMaterial* MakeAthleticMaterial(int32 Index, const FDecalImage& Image, double Heading, double StripeWidth,
		double Width, double Height, TArray<UPackage*>& Packages)
	{
		UMaterial* Material = Asset<UMaterial>(FString::Printf(TEXT("M_StreetscapeAthletic_%04d"), Index), Packages);
		Material->BlendMode = BLEND_Opaque;
		Material->bTangentSpaceNormal = false;
		auto* Position = CastChecked<UMaterialExpressionWorldPosition>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionWorldPosition::StaticClass()));
		auto* Normal = CastChecked<UMaterialExpressionVertexNormalWS>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionVertexNormalWS::StaticClass()));
		auto* UV = CastChecked<UMaterialExpressionTextureCoordinate>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureCoordinate::StaticClass()));
		auto* Atlas = CastChecked<UMaterialExpressionTextureObject>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureObject::StaticClass()));
		Atlas->Texture = MakeRegisteredTexture(Index, Image, true, Packages);
		Atlas->SamplerType = SAMPLERTYPE_Color;
		auto* Fiber = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCustom::StaticClass()));
		Fiber->Inputs.Empty();
		Fiber->OutputType = CMOT_Float3;
		const auto Input = [&](const TCHAR* Name, UMaterialExpression* Expression)
		{
			FCustomInput& Value = Fiber->Inputs.AddDefaulted_GetRef();
			Value.InputName = Name;
			Value.Input.Connect(0, Expression);
		};
		const auto Scalar = [&](const TCHAR* Name, double Value)
		{
			auto* Expression = CastChecked<UMaterialExpressionConstant>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionConstant::StaticClass()));
			Expression->R = float(Value);
			Input(Name, Expression);
		};
		Input(TEXT("P"), Position);
		Input(TEXT("N"), Normal);
		Input(TEXT("UV"), UV);
		Input(TEXT("Atlas"), Atlas);
		const double Radians = FMath::DegreesToRadians(FMath::Fmod(Heading, 360.));
		Scalar(TEXT("HeadingCos"), FMath::Cos(Radians));
		Scalar(TEXT("HeadingSin"), FMath::Sin(Radians));
		Scalar(TEXT("StripeWidth"), FMath::Max(StripeWidth, .001));
		Scalar(TEXT("StripeResolvable"), StripeWidth >= .001 ? 1 : 0);
		Scalar(TEXT("InvWidth"), 1. / FMath::Max(Width, .003));
		Scalar(TEXT("InvHeight"), 1. / FMath::Max(Height, .003));
		for (const auto& Output : {TPair<FName, ECustomMaterialOutputType>(TEXT("FiberNormal"), CMOT_Float3),
			TPair<FName, ECustomMaterialOutputType>(TEXT("Roughness"), CMOT_Float1),
			TPair<FName, ECustomMaterialOutputType>(TEXT("Specular"), CMOT_Float1)})
		{
			FCustomOutput& Value = Fiber->AdditionalOutputs.AddDefaulted_GetRef();
			Value.OutputName = Output.Key;
			Value.OutputType = Output.Value;
		}
		// Appearance priors: 10 mm tuft rows, 3 mm edge breakup, low ribbons and sparse infill.
		// Every atlas RGB (including its default green) goes through this one fiber finish.
		Fiber->Code = TEXT(R"HLSL(
struct Noise {
 float hash(float2 p) { return frac(sin(dot(p,float2(127.1,311.7)))*43758.5453); }
 float value(float2 p) {
  float2 i=floor(p), f=frac(p); f=f*f*(3-2*f);
  return lerp(lerp(hash(i),hash(i+float2(1,0)),f.x),lerp(hash(i+float2(0,1)),hash(i+1),f.x),f.y);
 }
};
Noise n;
float2 along=float2(HeadingCos,HeadingSin), across=float2(-HeadingSin,HeadingCos);
float2 en=P.yx*.01;
float2 q=float2(dot(en,along),dot(en,across));
float row=q.y/.01;
float rowVisible=1-smoothstep(.25,1.,fwidth(row));
float ribbon=cos(row*6.2831853)*rowVisible;
float2 fiberCell=q*float2(200,333.3333);
float detailVisible=1-smoothstep(.25,1.,max(fwidth(fiberCell.x),fwidth(fiberCell.y)));
float fiber=n.value(fiberCell);
float crumbNear=smoothstep(.79,.94,n.hash(floor(fiberCell)))*smoothstep(.25,.75,-ribbon);
float crumb=lerp(.012,crumbNear,detailVisible);

// Jitter only the artwork by at most 1.5 mm per axis. Preserve the unjittered gradients for mips.
float2 jitter=(float2(fiber,n.value(fiberCell+17.3))-.5)*.003*detailVisible;
float2 jitterEN=along*jitter.x+across*jitter.y;
float2 atlasUV=saturate(UV+float2(jitterEN.x*InvWidth,-jitterEN.y*InvHeight));
float3 colour=Texture2DSampleGrad(Atlas,AtlasSampler,atlasUV,ddx(UV),ddy(UV)).rgb;

float stripe=q.x/StripeWidth;
float stripeVisible=(1-smoothstep(.25,1.,fwidth(stripe)))*StripeResolvable;
float stripeFW=max(fwidth(stripe)*3.14159265,.001);
float direction=(2*smoothstep(-stripeFW,stripeFW,sin(stripe*3.14159265))-1)*stripeVisible;
float seamDistance=abs(frac(stripe+.5)-.5)*StripeWidth;
float seamFW=max(fwidth(q.x),.0001);
float seam=(1-smoothstep(max(0.,.002-seamFW),.002+seamFW,seamDistance))*min(1.,.002/seamFW)*stripeVisible;
float modulation=1.+.035*direction+.035*ribbon+.025*(fiber-.5)*detailVisible-.035*seam;

float3 up=normalize(N);
float3 axis=float3(HeadingSin,HeadingCos,0);
float3 tangent=axis-up*dot(up,axis);
tangent=normalize(tangent+float3(0,0,1)*step(dot(tangent,tangent),.000001));
float3 side=normalize(cross(tangent,up));
float acrossSlope=.08*sin(row*6.2831853)*rowVisible;
float alongSlope=.025*(fiber-.5)*detailVisible;
FiberNormal=normalize(up+side*acrossSlope+tangent*alongSlope);
// Directional roughness and dielectric Fresnel give every inlaid color the same grazing sheen.
Roughness=clamp(.78+.035*direction-.035*ribbon+.08*crumb,.65,.9);
Specular=.32-.12*crumb;
return lerp(colour*modulation,float3(.008,.009,.008),crumb);
)HLSL");
		Fiber->RebuildOutputs();
		UMaterialEditingLibrary::ConnectMaterialProperty(Fiber, TEXT(""), MP_BaseColor);
		UMaterialEditingLibrary::ConnectMaterialProperty(Fiber, TEXT("FiberNormal"), MP_Normal);
		UMaterialEditingLibrary::ConnectMaterialProperty(Fiber, TEXT("Roughness"), MP_Roughness);
		UMaterialEditingLibrary::ConnectMaterialProperty(Fiber, TEXT("Specular"), MP_Specular);
		UMaterialEditingLibrary::RecompileMaterial(Material);
		return Material;
	}
}

static bool ProcessStreetscape(UWorld* World, const FString& ManifestPath,
	TFunctionRef<double(double, double)> SurfaceHeight,
	TArray<UPackage*>& Packages, TArray<AActor*>& Actors, TSharedRef<FJsonObject> Receipt, FString& Error, bool bValidateOnly)
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
		|| !Manifest->TryGetObjectField(TEXT("stencil_classes"), Stencils))
	{
		Error = TEXT("cannot read streetscape geometry schema 1");
		return false;
	}
	bool bLandscapeOnly = false;
	if (FeatureCount > 0 && Rows->IsEmpty())
	{
		const TArray<TSharedPtr<FJsonValue>>* Fields = nullptr;
		double SurfaceCount = 0;
		bLandscapeOnly = Inventory->TryGetArrayField(TEXT("fields"), Fields) && Fields->Num() == int32(FeatureCount)
			&& (*Counts)->Values.Num() == 1 && (*Counts)->TryGetNumberField(TEXT("surface"), SurfaceCount)
			&& SurfaceCount == FeatureCount;
		TSet<FString> Ids;
		if (bLandscapeOnly)
		{
			for (const auto& Field : *Fields)
			{
				FString Id, Surface;
				if (!Field || Field->Type != EJson::Object
					|| !Field->AsObject()->TryGetStringField(TEXT("surface_id"), Id) || Id.IsEmpty() || Ids.Contains(Id)
					|| !Field->AsObject()->TryGetStringField(TEXT("effective_surface"), Surface) || Surface != TEXT("natural_grass"))
				{
					bLandscapeOnly = false;
					break;
				}
				Ids.Add(Id);
			}
		}
		if (!bLandscapeOnly)
		{
			Error = TEXT("empty streetscape geometry requires only classified natural-grass surfaces");
			return false;
		}
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
	TMap<FString, FDecalImage> Decals;
	struct FPendingMesh
	{
		FMeshDescription Description;
		FString Name;
		FString Image;
		double Heading;
		double StripeWidth;
		double Width;
		double Height;
		bool bCollision;
		bool bAnchored;
		FString MaterialKey() const
		{
			return FString::Printf(TEXT("%s|%s|%.17g|%.17g|%.17g|%.17g"),
				*Name, *Image, Heading, StripeWidth, Width, Height);
		}
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
		const bool bDecal = Name == TEXT("paint_decal") || Name == TEXT("grass_paint_decal");
		const bool bAthletic = Name == TEXT("athletic_turf");
		const bool bRegistered = bDecal || bAthletic;
		if (!Finish && !bDecal)
		{
			Error = TEXT("unknown streetscape finish: ") + Name;
			return false;
		}
		TArray<double> Anchor;
		const bool bAnchored = Row->HasField(TEXT("anchor_m"));
		FString Image;
		TArray<double> Bounds;
		double Heading = 0, StripeWidth = 0;
		if (bAthletic)
		{
			const auto HeadingValue = Row->TryGetField(TEXT("heading_deg"));
			const auto StripeValue = Row->TryGetField(TEXT("stripe_width_m"));
			if (!HeadingValue || HeadingValue->Type != EJson::Number || !StripeValue || StripeValue->Type != EJson::Number
				|| !Row->TryGetNumberField(TEXT("heading_deg"), Heading) || !FMath::IsFinite(Heading)
				|| !Row->TryGetNumberField(TEXT("stripe_width_m"), StripeWidth) || !FMath::IsFinite(StripeWidth)
				|| StripeWidth <= 0 || StripeWidth > 100)
			{
				Error = FString::Printf(TEXT("athletic turf mesh %d needs finite heading_deg and stripe_width_m in (0,100]"), Index);
				return false;
			}
		}
		if (bRegistered)
		{
			if (bCollision || bAnchored || !Row->TryGetStringField(TEXT("image"), Image) || Image.IsEmpty()
				|| Image.Contains(TEXT("/")) || Image.Contains(TEXT("\\")) || Image.Contains(TEXT(":"))
				|| !Image.EndsWith(TEXT(".png")) || !Numbers(Row->TryGetField(TEXT("bounds_m")), 4, Bounds)
				|| Bounds[0] >= Bounds[2] || Bounds[1] >= Bounds[3]
				|| !FMath::IsFinite(Bounds[2] - Bounds[0]) || !FMath::IsFinite(Bounds[3] - Bounds[1]))
			{
				Error = FString::Printf(TEXT("invalid registered image in streetscape mesh %d"), Index);
				return false;
			}
			if (!Decals.Contains(Image))
			{
				FDecalImage Decal;
				if (!ReadDecal(FPaths::GetPath(FPaths::GetPath(ManifestPath) / InventoryFile) / Image, Decal))
				{
					Error = TEXT("cannot decode visible 8-bit RGBA streetscape decal: ") + Image;
					return false;
				}
				Decals.Add(Image, MoveTemp(Decal));
			}
			if (bAthletic && !Decals.FindChecked(Image).bOpaque)
			{
				Error = TEXT("athletic turf atlas must have alpha 255 in every pixel: ") + Image;
				return false;
			}
		}
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
			if (bRegistered && (P[0] < Bounds[0] - 1.e-9 || P[0] > Bounds[2] + 1.e-9
				|| P[1] < Bounds[1] - 1.e-9 || P[1] > Bounds[3] + 1.e-9))
			{
				Error = FString::Printf(TEXT("vertex outside registered image bounds in streetscape mesh %d"), Index);
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
				if (bRegistered)
				{
					const FVector& EN = PreciseVertices[int32(T[I])];
					// World X is north, Y is east. PNG row zero is the north edge.
					UV = FVector2f((EN.Y * .01 - Bounds[0]) / (Bounds[2] - Bounds[0]),
						(Bounds[3] - EN.X * .01) / (Bounds[3] - Bounds[1]));
				}
				else if (Name == TEXT("chainlink"))
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
				UVs.Set(Corners[I], 0, bRegistered ? UV : UV * .01f);
			}
			Description.CreatePolygon(Group, {Corners[0], Corners[1], Corners[2]});
		}
		if (Description.Triangles().Num() > 0) Pending.Add({MoveTemp(Description), Name, Image, Heading, StripeWidth,
			bRegistered ? Bounds[2] - Bounds[0] : 0, bRegistered ? Bounds[3] - Bounds[1] : 0, bCollision, bAnchored});
	}
	if (Pending.IsEmpty() && FeatureCount > 0 && !bLandscapeOnly)
	{
		Error = TEXT("streetscape has no representable geometry");
		return false;
	}
	if (bValidateOnly) return true;
	if (!Pending.IsEmpty() && !World)
	{
		Error = TEXT("streetscape needs a world after validation");
		return false;
	}
	for (int32 Index = 0; Index < Pending.Num(); ++Index)
	{
		FPendingMesh& Item = Pending[Index];
		const FString& Name = Item.Name;
		const FString MaterialKey = Item.MaterialKey();
		FMeshDescription& Description = Item.Description;
		const bool bCollision = Item.bCollision, bAnchored = Item.bAnchored;
		if (!Materials.Contains(MaterialKey))
		{
			UMaterial* Material = Name == TEXT("athletic_turf")
				? MakeAthleticMaterial(Index, Decals.FindChecked(Item.Image), Item.Heading, Item.StripeWidth, Item.Width, Item.Height, Packages)
				: Item.Image.IsEmpty() ? MakeMaterial(Name, Finishes.FindChecked(Name), Packages)
				: MakeDecalMaterial(Index, Decals.FindChecked(Item.Image), Packages, Name == TEXT("grass_paint_decal"));
			if (!Material)
			{
				Error = TEXT("cannot load the engine's DitherTemporalAA function for chainlink");
				return false;
			}
			Materials.Add(MaterialKey, Material);
		}
		UStaticMesh* Mesh = Asset<UStaticMesh>(FString::Printf(TEXT("SM_Streetscape_%04d"), Index), Packages);
		Mesh->GetStaticMaterials().Add(FStaticMaterial(Materials[MaterialKey], FName(*Name)));
		// Terrain-contact surfaces retain their exact planes; solid props use Nanite.
		Mesh->GetNaniteSettings().bEnabled = Name != TEXT("chainlink") && Name != TEXT("net") && (bCollision || bAnchored);
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
		if (!bAnchored && !bCollision) Actor->Tags.Add(FName(TEXT("EnvGenPaving")));
		Actors.Add(Actor);
		auto* Component = Actor->GetStaticMeshComponent();
		Component->SetMobility(EComponentMobility::Static);
		Component->SetStaticMesh(Mesh);
		Component->SetCollisionProfileName(bCollision ? TEXT("BlockAll") : TEXT("NoCollision"));
		Component->SetCastShadow(bCollision);
		Component->SetRenderCustomDepth(true);
		const FString StencilClass = bAnchored || bCollision ? TEXT("prop")
			: Name.StartsWith(TEXT("paint_")) || Name.StartsWith(TEXT("grass_paint_")) ? TEXT("marking")
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
		if (Pair.Key == TEXT("athletic_turf"))
		{
			Values->SetStringField(TEXT("basis"), TEXT("documented appearance priors; not a measured physical survey"));
			Values->SetStringField(TEXT("colour_source"), TEXT("opaque registered atlas RGB, including default green and inlaid markings"));
			Values->SetStringField(TEXT("heading_convention"), TEXT("EN degrees counterclockwise from east"));
			Values->SetNumberField(TEXT("machine_row_spacing_m"), .01);
			Values->SetNumberField(TEXT("artwork_edge_breakup_m"), .003);
			Values->SetNumberField(TEXT("roll_seam_half_width_m"), .002);
			Values->SetNumberField(TEXT("distant_crumb_fraction"), .012);
			Values->SetNumberField(TEXT("specular"), .32);
			Values->SetNumberField(TEXT("minimum_resolved_stripe_width_m"), .001);
			TArray<TSharedPtr<FJsonValue>> Registrations;
			TSet<FString> Seen;
			for (const FPendingMesh& Item : Pending)
			{
				if (Item.Name != Pair.Key) continue;
				const FString Key = Item.MaterialKey();
				if (Seen.Contains(Key)) continue;
				Seen.Add(Key);
				TSharedRef<FJsonObject> Registration = MakeShared<FJsonObject>();
				Registration->SetStringField(TEXT("image"), Item.Image);
				Registration->SetNumberField(TEXT("heading_deg"), Item.Heading);
				Registration->SetNumberField(TEXT("stripe_width_m"), Item.StripeWidth);
				Registration->SetNumberField(TEXT("atlas_width_m"), Item.Width);
				Registration->SetNumberField(TEXT("atlas_height_m"), Item.Height);
				Registrations.Add(MakeShared<FJsonValueObject>(Registration));
			}
			Values->SetArrayField(TEXT("registrations"), Registrations);
		}
		MaterialPriors->SetObjectField(Pair.Key, Values);
	}
	MaterialPriors->SetNumberField(TEXT("aggregate_cells_per_m"), 140);
	MaterialPriors->SetNumberField(TEXT("concrete_joint_spacing_m"), 3);
	MaterialPriors->SetNumberField(TEXT("asphalt_crack_spacing_m"), 4);
	Receipt->SetObjectField(TEXT("streetscape_material_priors"), MaterialPriors);
	return true;
}

bool BuildEnvGenStreetscape(UWorld* World, const FString& ManifestPath,
	TFunctionRef<double(double, double)> SurfaceHeight,
	TArray<UPackage*>& Packages, TArray<AActor*>& Actors, TSharedRef<FJsonObject> Receipt, FString& Error)
{
	return ProcessStreetscape(World, ManifestPath, SurfaceHeight, Packages, Actors, Receipt, Error, false);
}

bool ValidateEnvGenStreetscape(const FString& ManifestPath,
	TFunctionRef<double(double, double)> SurfaceHeight, FString& Error)
{
	TArray<UPackage*> Packages;
	TArray<AActor*> Actors;
	return ProcessStreetscape(nullptr, ManifestPath, SurfaceHeight, Packages, Actors, MakeShared<FJsonObject>(), Error, true);
}

double EnvGenStreetscapeHeight(const TArray64<uint8>& HeightBytes, int32 Vertices,
	const FVector& LocationCm, const FVector& Scale, double NorthCm, double EastCm)
{
	const uint16* Heights = reinterpret_cast<const uint16*>(HeightBytes.GetData());
	const int32 Last = Vertices - 1;
	const double North = FMath::Clamp((NorthCm - LocationCm.X) / Scale.X, 0.0, double(Last));
	const double East = FMath::Clamp((EastCm - LocationCm.Y) / Scale.Y, 0.0, double(Last));
	const int32 N0 = FMath::Min(int32(North), Last - 1), E0 = FMath::Min(int32(East), Last - 1);
	const auto At = [&](int32 N, int32 E) { return double(Heights[E * Vertices + N]); };
	const double N = North - N0, E = East - E0;
	const double Height = N >= E
		? (1 - N) * At(N0, E0) + (N - E) * At(N0 + 1, E0) + E * At(N0 + 1, E0 + 1)
		: (1 - E) * At(N0, E0) + (E - N) * At(N0, E0 + 1) + N * At(N0 + 1, E0 + 1);
	return LocationCm.Z + (Height - 32768.0) * Scale.Z / 128.0;
}

int32 LockEnvGenStreetscapeTerrainLOD(ALandscape* Landscape, const TArray<AActor*>& Actors)
{
	TArray<FBox> Paving;
	for (const AActor* Actor : Actors)
	{
		if (Actor->ActorHasTag(FName(TEXT("EnvGenPaving")))) Paving.Add(Actor->GetComponentsBoundingBox(true));
	}
	const FVector Scale = Landscape->GetActorScale3D();
	const double Margin = FMath::Max(FMath::Abs(Scale.X), FMath::Abs(Scale.Y)) * 2;
	int32 Locked = 0;
	for (ULandscapeComponent* Component : Landscape->LandscapeComponents)
	{
		const FBox Ground = Component->Bounds.GetBox();
		if (Paving.ContainsByPredicate([&](const FBox& Surface) {
			return Ground.Min.X <= Surface.Max.X + Margin && Ground.Max.X >= Surface.Min.X - Margin
				&& Ground.Min.Y <= Surface.Max.Y + Margin && Ground.Max.Y >= Surface.Min.Y - Margin;
		}))
		{
			// A coarser Landscape can rise through a mesh sampled on its LOD0 triangles.
			Component->SetForcedLOD(0);
			++Locked;
		}
	}
	return Locked;
}
