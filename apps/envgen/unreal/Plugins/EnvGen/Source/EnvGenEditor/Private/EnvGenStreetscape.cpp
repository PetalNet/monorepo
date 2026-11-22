#include "EnvGenStreetscape.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/StaticMeshComponent.h"
#include "Components/PrimitiveComponent.h"
#include "Components/DecalComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/DecalActor.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "EnvGenSiteInfo.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Landscape.h"
#include "LandscapeComponent.h"
#include "LandscapeGrassType.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionComponentMask.h"
#include "Materials/MaterialExpressionCameraPositionWS.h"
#include "Materials/MaterialExpressionAppendVector.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionLandscapeGrassOutput.h"
#include "Materials/MaterialExpressionLandscapeLayerCoords.h"
#include "Materials/MaterialExpressionVertexColor.h"
#include "Materials/MaterialExpressionMaterialFunctionCall.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Materials/MaterialExpressionPerInstanceRandom.h"
#include "Materials/MaterialExpressionPreSkinnedPosition.h"
#include "Materials/MaterialExpressionSubtract.h"
#include "Materials/MaterialExpressionWorldPosition.h"
#include "Materials/MaterialExpressionTextureCoordinate.h"
#include "Materials/MaterialExpressionTextureSample.h"
#include "Materials/MaterialExpressionTextureObject.h"
#include "Materials/MaterialExpressionTransform.h"
#include "Materials/MaterialExpressionTransformPosition.h"
#include "Materials/MaterialExpressionVertexNormalWS.h"
#include "Materials/MaterialExpressionVertexInterpolator.h"
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
		{TEXT("athletic_turf"), {FLinearColor::FromSRGBColor(FColor(48, 100, 56)), .50f, 0, 0}},
		{TEXT("grass_paint_white"), {FLinearColor(.723f, .716f, .791f), .96f, 0, 0}},
		{TEXT("grass_paint_yellow"), {FLinearColor(.72f, .48f, .045f), .96f, 0, 0}},
		{TEXT("paint_white"), {FLinearColor(.723f, .716f, .791f), .83f, 0, 5}},
		{TEXT("paint_yellow"), {FLinearColor(.72f, .48f, .045f), .8f, 0, 5}},
		{TEXT("paint_black"), {FLinearColor(.009f, .011f, .010f), .83f, 0, 5}},
		{TEXT("grass_paint_black"), {FLinearColor(.009f, .011f, .010f), .96f, 0, 0}},
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
		if (bOpaque)
		{
			// NPOT atlases cannot generate mips; stretching retains their full 0..1 registration.
			Texture->PowerOfTwoMode = ETexturePowerOfTwoSetting::StretchToPowerOfTwo;
			Texture->MipGenSettings = TMGS_SimpleAverage;
		}
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

	void ProjectGrassPaint(UWorld* World, int32 Index, const FMeshDescription& Description,
		const FDecalImage* Source, const FVector4d& Registration, const FLinearColor& Colour,
		TArray<UPackage*>& Packages, TArray<AActor*>& Actors)
	{
		const auto Positions = FStaticMeshConstAttributes(Description).GetVertexPositions();
		FBox Bounds(ForceInit);
		for (const FVertexID Vertex : Description.Vertices().GetElementIDs()) Bounds += FVector(Positions[Vertex]);
		const double Width = Bounds.Max.Y - Bounds.Min.Y, Height = Bounds.Max.X - Bounds.Min.X;
		const int32 WidthPx = int32(FMath::Clamp(FMath::CeilToDouble(Width / 2), 8., 4096.));
		const int32 HeightPx = int32(FMath::Clamp(FMath::CeilToDouble(Height / 2), 8., 4096.));
		TArray64<uint8> Pixels;
		Pixels.SetNumZeroed(int64(WidthPx) * HeightPx * 4);
		const FColor Solid = Colour.ToFColorSRGB();
		const auto Cross = [](FVector2D A, FVector2D B) { return A.X * B.Y - A.Y * B.X; };
		const auto Touches = [&](const FVector2D* Triangle, FVector2D Min, FVector2D Max)
		{
			if (Max.X <= FMath::Min3(Triangle[0].X, Triangle[1].X, Triangle[2].X)
				|| Min.X >= FMath::Max3(Triangle[0].X, Triangle[1].X, Triangle[2].X)
				|| Max.Y <= FMath::Min3(Triangle[0].Y, Triangle[1].Y, Triangle[2].Y)
				|| Min.Y >= FMath::Max3(Triangle[0].Y, Triangle[1].Y, Triangle[2].Y)) return false;
			const double Winding = FMath::Sign(Cross(Triangle[1] - Triangle[0], Triangle[2] - Triangle[0]));
			const FVector2D Middle = (Min + Max) * .5, Half = (Max - Min) * .5;
			for (int32 Edge = 0; Edge < 3; ++Edge)
			{
				const FVector2D Direction = Triangle[(Edge + 1) % 3] - Triangle[Edge];
				if (Cross(Direction, Middle - Triangle[Edge]) * Winding
					<= -(FMath::Abs(Direction.X) * Half.Y + FMath::Abs(Direction.Y) * Half.X)) return false;
			}
			return true;
		};
		const auto ColourAt = [&](int32 X, int32 Y, const FVector2D* Triangle = nullptr)
		{
			if (!Source) return Solid;
			const double East0 = Bounds.Min.Y + double(X) / WidthPx * Width;
			const double East1 = Bounds.Min.Y + double(X + 1) / WidthPx * Width;
			const double North0 = Bounds.Max.X - double(Y) / HeightPx * Height;
			const double North1 = Bounds.Max.X - double(Y + 1) / HeightPx * Height;
			const int32 U0 = FMath::Clamp(FMath::FloorToInt((East0 * .01 - Registration.X) / Registration.Z * Source->Width), 0, Source->Width - 1);
			const int32 U1 = FMath::Clamp(FMath::CeilToInt((East1 * .01 - Registration.X) / Registration.Z * Source->Width) - 1, U0, Source->Width - 1);
			const int32 V0 = FMath::Clamp(FMath::FloorToInt((Registration.Y - North0 * .01) / Registration.W * Source->Height), 0, Source->Height - 1);
			const int32 V1 = FMath::Clamp(FMath::CeilToInt((Registration.Y - North1 * .01) / Registration.W * Source->Height) - 1, V0, Source->Height - 1);
			FColor Result(0, 0, 0, 0);
			for (int32 V = V0; V <= V1; ++V) for (int32 U = U0; U <= U1; ++U)
			{
				if (Triangle)
				{
					const double X0 = ((Registration.X + double(U) / Source->Width * Registration.Z) * 100 - Bounds.Min.Y) / Width * WidthPx;
					const double X1 = X0 + Registration.Z * 100 / Source->Width / Width * WidthPx;
					const double Y0 = (Bounds.Max.X - (Registration.Y - double(V) / Source->Height * Registration.W) * 100) / Height * HeightPx;
					const double Y1 = Y0 + Registration.W * 100 / Source->Height / Height * HeightPx;
					if (!Touches(Triangle, FVector2D(FMath::Max(double(X), X0), FMath::Max(double(Y), Y0)),
						FVector2D(FMath::Min(double(X + 1), X1), FMath::Min(double(Y + 1), Y1)))) continue;
				}
				const uint8* At = Source->Pixels.GetData() + (int64(V) * Source->Width + U) * 4;
				if (At[3] >= Result.A) Result = FColor(At[2], At[1], At[0], At[3]);
			}
			return Result;
		};
		// Transparent texels retain paint RGB so filtering does not introduce a black fringe.
		for (int32 Y = 0; Y < HeightPx; ++Y) for (int32 X = 0; X < WidthPx; ++X)
		{
			const FColor Pixel = ColourAt(X, Y);
			uint8* At = Pixels.GetData() + (int64(Y) * WidthPx + X) * 4;
			At[0] = Pixel.B; At[1] = Pixel.G; At[2] = Pixel.R;
		}
		const auto UV = [&](const FVector3f& P) { return FVector2D((P.Y - Bounds.Min.Y) / Width * WidthPx, (Bounds.Max.X - P.X) / Height * HeightPx); };
		for (const FTriangleID Triangle : Description.Triangles().GetElementIDs())
		{
			const auto Corners = Description.GetTriangleVertices(Triangle);
			const FVector2D A = UV(Positions[Corners[0]]), B = UV(Positions[Corners[1]]), C = UV(Positions[Corners[2]]);
			const FVector2D Footprint[] = {A, B, C};
			const int32 X0 = FMath::Clamp(FMath::FloorToInt(FMath::Min3(A.X, B.X, C.X)), 0, WidthPx - 1);
			const int32 X1 = FMath::Clamp(FMath::CeilToInt(FMath::Max3(A.X, B.X, C.X)), 0, WidthPx - 1);
			const int32 Y0 = FMath::Clamp(FMath::FloorToInt(FMath::Min3(A.Y, B.Y, C.Y)), 0, HeightPx - 1);
			const int32 Y1 = FMath::Clamp(FMath::CeilToInt(FMath::Max3(A.Y, B.Y, C.Y)), 0, HeightPx - 1);
			for (int32 Y = Y0; Y <= Y1; ++Y) for (int32 X = X0; X <= X1; ++X)
			{
				if (!Touches(Footprint, FVector2D(X, Y), FVector2D(X + 1, Y + 1))) continue;
				const FColor Pixel = ColourAt(X, Y, Footprint);
				uint8* At = Pixels.GetData() + (int64(Y) * WidthPx + X) * 4;
				if (Pixel.A > At[3]) { At[0] = Pixel.B; At[1] = Pixel.G; At[2] = Pixel.R; At[3] = Pixel.A; }
			}
		}
		UTexture2D* Texture = Asset<UTexture2D>(FString::Printf(TEXT("T_GrassPaint_%04d"), Index), Packages);
		Texture->Source.Init(WidthPx, HeightPx, 1, 1, TSF_BGRA8, Pixels.GetData());
		Texture->SRGB = true;
		Texture->CompressionSettings = TC_Default;
		Texture->AddressX = Texture->AddressY = TA_Clamp;
		Texture->PowerOfTwoMode = ETexturePowerOfTwoSetting::StretchToPowerOfTwo;
		Texture->MipGenSettings = TMGS_SimpleAverage;
		Texture->bDoScaleMipsForAlphaCoverage = false;
		Texture->PostEditChange();

		UMaterial* Material = Asset<UMaterial>(FString::Printf(TEXT("M_ProjectedGrassPaint_%04d"), Index), Packages);
		Material->MaterialDomain = MD_DeferredDecal;
		Material->BlendMode = BLEND_Translucent;
		auto* Position = CastChecked<UMaterialExpressionWorldPosition>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionWorldPosition::StaticClass()));
		auto* Coords = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCustom::StaticClass()));
		Coords->Inputs.Empty();
		Coords->OutputType = CMOT_Float2;
		FCustomInput& PositionInput = Coords->Inputs.AddDefaulted_GetRef();
		PositionInput.InputName = TEXT("P"); PositionInput.Input.Connect(0, Position);
		Coords->Code = FString::Printf(TEXT("return float2((P.y-(%.17g))/%.17g,((%.17g)-P.x)/%.17g);"), Bounds.Min.Y, Width, Bounds.Max.X, Height);
		auto* Sample = CastChecked<UMaterialExpressionTextureSample>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureSample::StaticClass()));
		Sample->Texture = Texture;
		Sample->SamplerType = SAMPLERTYPE_Color;
		Sample->Coordinates.Connect(0, Coords);
		UMaterialEditingLibrary::ConnectMaterialProperty(Sample, TEXT("RGB"), MP_BaseColor);
		auto* Opacity = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCustom::StaticClass()));
		Opacity->Inputs.Empty();
		Opacity->OutputType = CMOT_Float1;
		FCustomInput& MaskInput = Opacity->Inputs.AddDefaulted_GetRef();
		MaskInput.InputName = TEXT("Mask"); MaskInput.Input.Connect(4, Sample);
		FCustomInput& PlaceInput = Opacity->Inputs.AddDefaulted_GetRef();
		PlaceInput.InputName = TEXT("P"); PlaceInput.Input.Connect(0, Position);
		Opacity->Code = TEXT(R"HLSL(
float2 q=(P.xy+P.z*float2(.37,.61))*.9, i=floor(q), f=frac(q); f=f*f*(3-2*f);
float a=frac(sin(dot(i,float2(127.1,311.7)))*43758.5453);
float b=frac(sin(dot(i+float2(1,0),float2(127.1,311.7)))*43758.5453);
float c=frac(sin(dot(i+float2(0,1),float2(127.1,311.7)))*43758.5453);
float d=frac(sin(dot(i+1,float2(127.1,311.7)))*43758.5453);
float visible=1-smoothstep(.25,1.,max(fwidth(q.x),fwidth(q.y)));
float grain=lerp(.5,lerp(lerp(a,b,f.x),lerp(c,d,f.x),f.y),visible);
float3 geometric=cross(ddx(P),ddy(P));
float upright=1-smoothstep(.45,.8,abs(geometric.z)/max(length(geometric),.000001));
return Mask*(.05+.70*grain)*upright;
)HLSL");
		UMaterialEditingLibrary::ConnectMaterialProperty(Opacity, TEXT(""), MP_Opacity);
		UMaterialEditingLibrary::RecompileMaterial(Material);
		ADecalActor* Actor = World->SpawnActor<ADecalActor>(Bounds.GetCenter(), FRotator::ZeroRotator);
		// The decal CDO already rotates its root. Set the final direction without composing it twice.
		Actor->SetActorRotation(FRotator(-90, 0, 0));
		Actor->SetActorLabel(FString::Printf(TEXT("EnvGenGrassPaint_%04d"), Index));
		Actor->Tags.Add(EnvGenStandingTag());
		auto* Decal = Actor->GetDecal();
		Decal->DecalSize = FVector((Bounds.Max.Z - Bounds.Min.Z) * .5 + 100, Width * .5, Height * .5);
		Decal->SetFadeScreenSize(0);
		Decal->SetDecalMaterial(Material);
		Actors.Add(Actor);
		for (TActorIterator<ALandscape> It(World); It; ++It)
		{
			if (It->GetActorLabel() != TEXT("EnvGenLandscape") || !It->LandscapeMaterial) continue;
			for (UMaterialExpression* Expression : It->LandscapeMaterial->GetMaterial()->GetExpressions())
			{
				const auto* Output = Cast<UMaterialExpressionLandscapeGrassOutput>(Expression);
				if (!Output) continue;
				for (const FGrassInput& Input : Output->GrassTypes)
				{
					if (!Input.GrassType || Input.GrassType->GetName().StartsWith(TEXT("LGT_AthleticPile_"))) continue;
					bool bChanged = false;
					for (FGrassVariety& Variety : Input.GrassType->GrassVarieties)
						if (!Variety.bReceivesDecals) { Variety.bReceivesDecals = true; bChanged = true; }
					if (bChanged) { Input.GrassType->MarkPackageDirty(); Input.GrassType->PostEditChange(); }
				}
			}
		}
	}

	UTexture2D* MakeAthleticInfillTexture(TArray<UPackage*>& Packages)
	{
		constexpr int32 Size = 1024, Cells = 64;
		FRandomStream Random(27011);
		struct FGrain
		{
			FVector2f Centre;
			FVector2f Radius;
			float Angle;
			float Height;
			float Reflectance;
		};
		TArray<FGrain> Grains;
		for (int32 I = 0; I < Cells * Cells; ++I)
		{
			const float Radius = Random.FRandRange(.3f, .7f);
			Grains.Add({FVector2f(Random.FRand(), Random.FRand()),
				FVector2f(Radius, Radius * Random.FRandRange(.55f, 1.f)),
				float(Random.FRand() * 2 * PI), float(Random.FRandRange(.35f, 1.f)), float(Random.FRandRange(.2f, 1.f))});
		}
		TArray<uint8> Pixels;
		Pixels.SetNumUninitialized(Size * Size * 4);
		for (int32 Y = 0; Y < Size; ++Y) for (int32 X = 0; X < Size; ++X)
		{
			const FVector2f P((X + .5f) * Cells / Size, (Y + .5f) * Cells / Size);
			const int32 CellX = FMath::FloorToInt(P.X), CellY = FMath::FloorToInt(P.Y);
			float Height = 0, Reflectance = 0, Coverage = 0;
			for (int32 DY = -1; DY <= 1; ++DY) for (int32 DX = -1; DX <= 1; ++DX)
			{
				const int32 GX = CellX + DX, GY = CellY + DY;
				const FGrain& Grain = Grains[((GY + Cells) % Cells) * Cells + (GX + Cells) % Cells];
				const FVector2f Offset = P - FVector2f(GX, GY) - Grain.Centre;
				const float C = FMath::Cos(Grain.Angle), S = FMath::Sin(Grain.Angle);
				const FVector2f Local((C * Offset.X + S * Offset.Y) / Grain.Radius.X,
					(-S * Offset.X + C * Offset.Y) / Grain.Radius.Y);
				const float Angle = FMath::Atan2(Local.Y, Local.X);
				const float Radius = Local.Size() / (1 + .12f * FMath::Sin(3 * Angle + Grain.Angle) + .08f * FMath::Cos(5 * Angle));
				const float Edge = 1 - FMath::SmoothStep(.82f, 1.f, Radius);
				const float Crown = FMath::Pow(FMath::Max(0.f, 1 - Radius * Radius), .35f);
				const float Surface = Grain.Height * Crown * Edge;
				// Independent footprints overlap; they never expand to fill a Voronoi cell.
				if (Surface > Height)
				{
					Height = Surface;
					Reflectance = Grain.Reflectance * Edge * FMath::Clamp(1 + .25f * Local.X - .2f * Local.Y, .5f, 1.f);
				}
				Coverage = FMath::Max(Coverage, Edge);
			}
			uint8* Pixel = Pixels.GetData() + (Y * Size + X) * 4;
			Pixel[0] = uint8(255 * Coverage);
			Pixel[1] = uint8(255 * Reflectance);
			Pixel[2] = uint8(255 * Height);
			Pixel[3] = 255;
		}
		UTexture2D* Texture = Asset<UTexture2D>(TEXT("T_AthleticInfill"), Packages);
		// Linear packed data: height, particle reflectance, intergranular coverage.
		Texture->Source.Init(Size, Size, 1, 1, TSF_BGRA8, Pixels.GetData());
		Texture->SRGB = false;
		Texture->CompressionSettings = TC_VectorDisplacementmap;
		Texture->MipGenSettings = TMGS_SimpleAverage;
		Texture->AddressX = Texture->AddressY = TA_Wrap;
		Texture->PostEditChange();
		return Texture;
	}

	UMaterial* MakeAthleticMaterial(int32 Index, UTexture2D* Texture, UTexture2D* InfillTexture, double Heading, double StripeWidth, TArray<UPackage*>& Packages)
	{
		UMaterial* Material = Asset<UMaterial>(FString::Printf(TEXT("M_StreetscapeAthletic_%04d"), Index), Packages);
		Material->BlendMode = BLEND_Opaque;
		Material->bTangentSpaceNormal = false;
		auto* Position = CastChecked<UMaterialExpressionWorldPosition>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionWorldPosition::StaticClass()));
		auto* Normal = CastChecked<UMaterialExpressionVertexNormalWS>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionVertexNormalWS::StaticClass()));
		auto* Eye = CastChecked<UMaterialExpressionCameraPositionWS>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCameraPositionWS::StaticClass()));
		auto* UV = CastChecked<UMaterialExpressionTextureCoordinate>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureCoordinate::StaticClass()));
		auto* Atlas = CastChecked<UMaterialExpressionTextureObject>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureObject::StaticClass()));
		Atlas->Texture = Texture;
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
		Input(TEXT("Eye"), Eye);
		Input(TEXT("UV"), UV);
		Input(TEXT("Atlas"), Atlas);
		auto* Infill = CastChecked<UMaterialExpressionTextureObject>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureObject::StaticClass()));
		Infill->Texture = InfillTexture;
		Infill->SamplerType = SAMPLERTYPE_LinearColor;
		Input(TEXT("Infill"), Infill);
		const double Radians = FMath::DegreesToRadians(FMath::Fmod(Heading, 360.));
		Scalar(TEXT("HeadingCos"), FMath::Cos(Radians));
		Scalar(TEXT("HeadingSin"), FMath::Sin(Radians));
		Scalar(TEXT("StripeWidth"), FMath::Max(StripeWidth, .001));
		Scalar(TEXT("StripeResolvable"), StripeWidth >= .001 ? 1 : 0);
		for (const auto& Output : {TPair<FName, ECustomMaterialOutputType>(TEXT("FiberNormal"), CMOT_Float3),
			TPair<FName, ECustomMaterialOutputType>(TEXT("Roughness"), CMOT_Float1),
			TPair<FName, ECustomMaterialOutputType>(TEXT("Specular"), CMOT_Float1)})
		{
			FCustomOutput& Value = Fiber->AdditionalOutputs.AddDefaulted_GetRef();
			Value.OutputName = Output.Key;
			Value.OutputType = Output.Value;
		}
		// Appearance priors: 10 mm tuft rows, 3 mm edge breakup, low ribbons and granular infill.
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
float infill=n.value(q*320)+.35*n.value(q*611+37.9);
float crumbNear=smoothstep(.52,.93,infill)*.85;
// Preserve the resolved noise mean when individual infill particles become sub-pixel.
float crumb=lerp(.36,crumbNear,detailVisible);
float2 clusterCell=q*40;
float cluster=n.value(clusterCell);
float clusterVisible=1-smoothstep(.25,1.,max(fwidth(clusterCell.x),fwidth(clusterCell.y)));
float pileNear=1-smoothstep(300.,1000.,distance(P,Eye));

float3 colour=Texture2DSampleGrad(Atlas,AtlasSampler,UV,ddx(UV),ddy(UV)).rgb;

float stripe=q.x/StripeWidth;
float stripeVisible=(1-smoothstep(.25,1.,fwidth(stripe)))*StripeResolvable;
float stripeFW=max(fwidth(stripe)*3.14159265,.001);
float direction=(2*smoothstep(-stripeFW,stripeFW,sin(stripe*3.14159265))-1)*stripeVisible;
float seamDistance=abs(frac(stripe+.5)-.5)*StripeWidth;
float seamFW=max(fwidth(q.x),.0001);
float seam=(1-smoothstep(max(0.,.008-seamFW),.008+seamFW,seamDistance))*min(1.,.008/seamFW)*stripeVisible;
float modulation=.65*(1.+.043*direction+.019*ribbon+.036*(fiber-.5)*detailVisible
 +.24*(cluster-.5)*clusterVisible+.043*(n.value(q*.8)-.5)-.095*seam);

float3 up=normalize(N);
float3 axis=float3(HeadingSin,HeadingCos,0);
float3 tangent=axis-up*dot(up,axis);
tangent=normalize(tangent+float3(0,0,1)*step(dot(tangent,tangent),.000001));
float3 side=normalize(cross(tangent,up));
float acrossSlope=.025*sin(row*6.2831853)*rowVisible+.25*(cluster-.5)*clusterVisible;
float alongSlope=.06*direction+.25*(n.value(clusterCell+27.1)-.5)*clusterVisible;
float3 grains=Texture2DSampleGrad(Infill,InfillSampler,q*4,ddx(q*4),ddy(q*4)).rgb;
float3 vx=ddx_fine(P), vy=ddy_fine(P), r1=cross(vy,up), r2=cross(up,vx);
float determinant=dot(vx,r1);
float3 bump=normalize(max(abs(determinant),.000001)*up-sign(determinant)*.08*(ddx_fine(grains.r)*r1+ddy_fine(grains.r)*r2));
FiberNormal=normalize(lerp(normalize(up+side*acrossSlope+tangent*alongSlope),bump,pileNear));
// Directional roughness and dielectric Fresnel give every inlaid color the same grazing sheen.
Roughness=lerp(clamp(.75+.03*direction+.10*(cluster-.5)*clusterVisible+.08*crumb,.70,.95),.88,pileNear);
Specular=lerp(.18-.05*crumb,.35,pileNear);
// At grazing angles, upright fibers hide more of the infill between their roots.
float crumbVisible=crumb*saturate(dot(up,normalize(Eye-P)));
float3 canopy=lerp(min(colour*modulation,.95),float3(.008,.009,.008),crumbVisible);
float3 bed=lerp(float3(.006,.007,.006),float3(.025,.027,.025),grains.g)*lerp(.35,1.,grains.b);
float contactNear=1-smoothstep(150.,250.,distance(P,Eye));
bed=lerp(bed,bed*float3(.22,.25,.3),contactNear);
return lerp(canopy,bed,pileNear);
)HLSL");
		Fiber->RebuildOutputs();
		UMaterialEditingLibrary::ConnectMaterialProperty(Fiber, TEXT(""), MP_BaseColor);
		UMaterialEditingLibrary::ConnectMaterialProperty(Fiber, TEXT("FiberNormal"), MP_Normal);
		UMaterialEditingLibrary::ConnectMaterialProperty(Fiber, TEXT("Roughness"), MP_Roughness);
		UMaterialEditingLibrary::ConnectMaterialProperty(Fiber, TEXT("Specular"), MP_Specular);
		UMaterialEditingLibrary::RecompileMaterial(Material);
		return Material;
	}

	struct FPatchCoordinates
	{
		UMaterialExpression* Root;
		UMaterialExpression* Delta;
	};

	FPatchCoordinates PatchCoordinates(UMaterial* Material, UMaterialExpressionPreSkinnedPosition* LocalPosition)
	{
		auto* RootUV = CastChecked<UMaterialExpressionTextureCoordinate>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureCoordinate::StaticClass()));
		RootUV->CoordinateIndex = 1;
		auto* Zero = CastChecked<UMaterialExpressionConstant>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionConstant::StaticClass()));
		Zero->R = 0;
		auto* LocalRoot = CastChecked<UMaterialExpressionAppendVector>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionAppendVector::StaticClass()));
		LocalRoot->A.Connect(0, RootUV); LocalRoot->B.Connect(0, Zero);
		auto* Root = CastChecked<UMaterialExpressionTransformPosition>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTransformPosition::StaticClass()));
		Root->Input.Connect(0, LocalRoot);
		Root->TransformSourceType = TRANSFORMPOSSOURCE_Local;
		Root->TransformType = TRANSFORMPOSSOURCE_World;
		UMaterialExpression* LocalDelta;
		if (LocalPosition)
		{
			auto* Difference = CastChecked<UMaterialExpressionSubtract>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionSubtract::StaticClass()));
			Difference->A.Connect(0, LocalPosition); Difference->B.Connect(0, LocalRoot);
			LocalDelta = Difference;
		}
		else
		{
			// Preserve the fiber's packed delta while infill uses the original mesh position.
			auto* DeltaUV = CastChecked<UMaterialExpressionTextureCoordinate>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureCoordinate::StaticClass()));
			DeltaUV->CoordinateIndex = 2;
			auto* HeightUV = CastChecked<UMaterialExpressionTextureCoordinate>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureCoordinate::StaticClass()));
			HeightUV->CoordinateIndex = 3;
			auto* Z = CastChecked<UMaterialExpressionComponentMask>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionComponentMask::StaticClass()));
			Z->Input.Connect(0, HeightUV); Z->R = true; Z->G = Z->B = Z->A = false;
			auto* EncodedDelta = CastChecked<UMaterialExpressionAppendVector>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionAppendVector::StaticClass()));
			EncodedDelta->A.Connect(0, DeltaUV); EncodedDelta->B.Connect(0, Z);
			LocalDelta = EncodedDelta;
		}
		auto* Delta = CastChecked<UMaterialExpressionTransform>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTransform::StaticClass()));
		Delta->Input.Connect(0, LocalDelta);
		Delta->TransformSourceType = TRANSFORMSOURCE_Local;
		Delta->TransformType = TRANSFORM_World;
		return {Root, Delta};
	}

	UStaticMesh* MakeAthleticInfillMesh(int32 Index, UMaterial* Material, TArray<UPackage*>& Packages)
	{
		const auto MakeLevel = [](bool Detailed)
		{
			FMeshDescription Description;
			FStaticMeshAttributes Attributes(Description);
			Attributes.Register();
			auto Positions = Attributes.GetVertexPositions();
			auto Normals = Attributes.GetVertexInstanceNormals();
			auto Tangents = Attributes.GetVertexInstanceTangents();
			auto BinormalSigns = Attributes.GetVertexInstanceBinormalSigns();
			auto UVs = Attributes.GetVertexInstanceUVs();
			auto Colours = Attributes.GetVertexInstanceColors();
			UVs.SetNumChannels(2);
			const FPolygonGroupID Group = Description.CreatePolygonGroup();
			Attributes.GetPolygonGroupMaterialSlotNames()[Group] = TEXT("Infill");
			FRandomStream Random(7219);
			for (int32 X = 0; X < 100; ++X) for (int32 Y = 0; Y < 100; ++Y)
			{
				const FVector2f Root(-9.9f + X * .2f + Random.FRandRange(-.06f, .06f),
					-9.9f + Y * .2f + Random.FRandRange(-.06f, .06f));
				const float SizeClass = Random.FRand();
				const float Radius = SizeClass < .5f ? Random.FRandRange(.05f, .15f)
					: SizeClass < .8f ? Random.FRandRange(.14f, .24f) : Random.FRandRange(.20f, .30f);
				const float Height = Radius * Random.FRandRange(.45f, 1.2f);
				const float Base = .06f + .045f * FMath::Sin(Root.X * .7f) * FMath::Cos(Root.Y * .6f) + Random.FRandRange(0, .035f) + (SizeClass > .9f ? .18f : 0.f);
				const float Aspect = Random.FRandRange(.55f, 1.3f), Inset = Random.FRandRange(.8f, .98f);
				const float Angle = Random.FRand() * 2 * PI, Seed = Random.FRand();
				const int32 Corners = Random.RandRange(8, 11), Notch = Random.RandRange(0, Corners - 1);
				TArray<FVector3f> Top, Belt;
				FVector2f Minimum(MAX_flt, MAX_flt), Maximum(-MAX_flt, -MAX_flt);
				float MeanHeight = 0;
				const auto Rotate = [&](FVector2f P)
				{
					return FVector2f(P.X * FMath::Cos(Angle) - P.Y * FMath::Sin(Angle),
						P.X * FMath::Sin(Angle) + P.Y * FMath::Cos(Angle));
				};
				for (int32 Corner = 0; Corner < Corners; ++Corner)
				{
					const float A = Corner * 2 * PI / Corners + Random.FRandRange(-.1f, .1f);
					const bool Chipped = Corner == Notch || Corner == (Notch + Corners / 2) % Corners;
					const float R = Radius * (Chipped ? Random.FRandRange(.35f, .6f) : Random.FRandRange(.75f, 1.f));
					const FVector2f Axis(FMath::Cos(A) * R * Aspect, FMath::Sin(A) * R), P = Rotate(Axis);
					Minimum.X = FMath::Min(Minimum.X, Axis.X); Minimum.Y = FMath::Min(Minimum.Y, Axis.Y);
					Maximum.X = FMath::Max(Maximum.X, Axis.X); Maximum.Y = FMath::Max(Maximum.Y, Axis.Y);
					const float Z = Base + Height * Random.FRandRange(.85f, 1.15f);
					Top.Add(FVector3f(Root.X + P.X * Inset, Root.Y + P.Y * Inset, Z));
					Belt.Add(FVector3f(Root.X + P.X, Root.Y + P.Y, Base + Height * Random.FRandRange(.35f, .55f)));
					MeanHeight += Z / Corners;
				}
				TArray<FVector3f> Points{FVector3f(Root.X, Root.Y, MeanHeight), FVector3f(Root.X, Root.Y, -.04f)};
				if (Detailed)
				{
					Points.Append(Top);
					Points.Append(Belt);
				}
				else
				{
					for (const FVector2f Axis : {Minimum, FVector2f(Maximum.X, Minimum.Y), Maximum, FVector2f(Minimum.X, Maximum.Y)})
					{
						const FVector2f P = Rotate(Axis);
						Points.Add(FVector3f(Root.X + P.X, Root.Y + P.Y, MeanHeight));
					}
				}
				TArray<FVertexID> Vertices;
				TArray<FVector3f> NormalSums;
				for (const FVector3f P : Points)
				{
					const FVertexID V = Description.CreateVertex();
					Positions[V] = P;
					Vertices.Add(V);
					NormalSums.Add(FVector3f::ZeroVector);
				}
				TArray<TPair<FVertexInstanceID, int32>> InstancePoints;
				const auto Triangle = [&](int32 A, int32 B, int32 C, bool bEmit = true)
				{
					const FVector3f Face = FVector3f::CrossProduct(Points[C] - Points[A], Points[B] - Points[A]);
					for (const int32 Point : {A, B, C}) NormalSums[Point] += Face;
					if (!bEmit) return;
					const FVector3f Normal = Face.GetSafeNormal(1.e-12f);
					TArray<FVertexInstanceID> Instances;
					for (const int32 Point : {A, B, C})
					{
						const FVector3f P = Points[Point];
						const FVertexInstanceID VI = Description.CreateVertexInstance(Vertices[Point]);
						Normals[VI] = Normal;
						InstancePoints.Emplace(VI, Point);
						UVs.Set(VI, 0, FVector2f(P.X, P.Y) - Root);
						UVs.Set(VI, 1, Root);
						Colours[VI] = FVector4f(Seed, 0, 0, 1);
						Instances.Add(VI);
					}
					Description.CreatePolygon(Group, Instances);
				};
				if (Detailed)
				{
					for (int32 Corner = 0; Corner < Corners; ++Corner)
					{
						const int32 Next = (Corner + 1) % Corners;
						Triangle(0, 2 + Next, 2 + Corner);
						Triangle(2 + Corners + Corner, 2 + Next, 2 + Corners + Next);
						Triangle(2 + Corners + Corner, 2 + Corner, 2 + Next);
						Triangle(1, 2 + Corners + Corner, 2 + Corners + Next, false);
					}
				}
				else
				{
					for (int32 Corner = 0; Corner < 4; ++Corner)
					{
						Triangle(0, 2 + (Corner + 1) % 4, 2 + Corner);
						// Keep the same rim normals without rendering the distant underside.
						Triangle(1, 2 + Corner, 2 + (Corner + 1) % 4, false);
					}
				}
				for (const auto& Instance : InstancePoints)
				{
					const FVector3f Smooth = NormalSums[Instance.Value].GetSafeNormal(1.e-12f);
					const FVector3f Face = Normals[Instance.Key];
					const FVector3f N = FVector3f::DotProduct(Smooth, Face) > .2f ? Smooth : Face;
					Normals[Instance.Key] = N;
					// This material has no tangent-space normal map; share a frame across smooth corners.
					const FVector3f Axis = FMath::Abs(N.Z) > .9f ? FVector3f(0, 1, 0) : FVector3f(0, 0, 1);
					Tangents[Instance.Key] = FVector3f::CrossProduct(Axis, N).GetSafeNormal(1.e-12f);
					BinormalSigns[Instance.Key] = 1;
				}
			}
			return Description;
		};
		FMeshDescription Near = MakeLevel(true), Far = MakeLevel(false);
		UStaticMesh* Mesh = Asset<UStaticMesh>(FString::Printf(TEXT("SM_AthleticPile_%04d_Infill"), Index), Packages);
		Mesh->GetStaticMaterials().Add(FStaticMaterial(Material, TEXT("Infill")));
		Mesh->SetAutoComputeLODScreenSize(false);
		Mesh->SetNumSourceModels(2);
		for (int32 LOD = 0; LOD < 2; ++LOD)
		{
			FStaticMeshSourceModel& Model = Mesh->GetSourceModel(LOD);
			Model.BuildSettings.bRecomputeNormals = false;
			Model.BuildSettings.bRecomputeTangents = false;
			Model.BuildSettings.bGenerateLightmapUVs = false;
			Model.BuildSettings.bUseFullPrecisionUVs = true;
			Model.ReductionSettings.PercentTriangles = 1;
			Model.ReductionSettings.PercentVertices = 1;
			Model.ReductionSettings.MaxDeviation = 0;
			Model.ReductionSettings.BaseLODModel = LOD;
		}
		Mesh->GetSourceModel(0).ScreenSize = 1.f;
		Mesh->GetSourceModel(1).ScreenSize = .22f;
		UStaticMesh::FBuildMeshDescriptionsParams Params;
		Params.bFastBuild = false;
		Params.bBuildSimpleCollision = false;
		Mesh->BuildFromMeshDescriptions({&Near, &Far}, Params);
		FStaticMeshCompilingManager::Get().FinishCompilation({Mesh});
		return Mesh;
	}

	bool AddAthleticPile(UWorld* World, int32 Index, UTexture2D* Atlas, double West, double North,
		double Width, double Height, double Heading, const TArray<const FMeshDescription*>& Surfaces,
		TArray<UPackage*>& Packages, FString& Error)
	{
		ALandscape* Landscape = nullptr;
		for (TActorIterator<ALandscape> It(World); It; ++It)
		{
			if (It->GetActorLabel() == TEXT("EnvGenLandscape")) { Landscape = *It; break; }
		}
		if (!Landscape || !Landscape->LandscapeMaterial)
		{
			Error = TEXT("athletic pile needs EnvGenLandscape with its ground material");
			return false;
		}
		const double Radians = FMath::DegreesToRadians(FMath::Fmod(Heading, 360.));
		UMaterial* Ground = Landscape->LandscapeMaterial->GetMaterial();
		UMaterialExpressionLandscapeGrassOutput* Output = nullptr;
		for (UMaterialExpression* Expression : Ground->GetExpressions())
			if (auto* Grass = Cast<UMaterialExpressionLandscapeGrassOutput>(Expression)) { Output = Grass; break; }
		if (!Output)
		{
			Output = CastChecked<UMaterialExpressionLandscapeGrassOutput>(UMaterialEditingLibrary::CreateMaterialExpression(Ground, UMaterialExpressionLandscapeGrassOutput::StaticClass()));
			Output->GrassTypes.Empty();
		}

		// Rasterize the supplied field triangles, not their bounding rectangle, so nearby natural grass stays intact.
		constexpr int32 Resolution = 4096;
		TArray<uint8> Coverage;
		Coverage.SetNumZeroed(Resolution * Resolution);
		for (const FMeshDescription* Surface : Surfaces)
		{
			const auto UVs = FStaticMeshConstAttributes(*Surface).GetVertexInstanceUVs();
			for (const FTriangleID Triangle : Surface->Triangles().GetElementIDs())
			{
				const auto Corners = Surface->GetTriangleVertexInstances(Triangle);
				const FVector2f A = UVs.Get(Corners[0], 0) * Resolution;
				const FVector2f B = UVs.Get(Corners[1], 0) * Resolution;
				const FVector2f C = UVs.Get(Corners[2], 0) * Resolution;
				const auto Cross = [](FVector2f P, FVector2f Q) { return P.X * Q.Y - P.Y * Q.X; };
				const float Area = Cross(B - A, C - A);
				if (FMath::Abs(Area) < 1.e-8f) continue;
				const int32 MinX = FMath::Clamp(FMath::FloorToInt(FMath::Min3(A.X, B.X, C.X)), 0, Resolution - 1);
				const int32 MaxX = FMath::Clamp(FMath::FloorToInt(FMath::Max3(A.X, B.X, C.X)), 0, Resolution - 1);
				const int32 MinY = FMath::Clamp(FMath::FloorToInt(FMath::Min3(A.Y, B.Y, C.Y)), 0, Resolution - 1);
				const int32 MaxY = FMath::Clamp(FMath::FloorToInt(FMath::Max3(A.Y, B.Y, C.Y)), 0, Resolution - 1);
				const float Winding = FMath::Sign(Area);
				const auto OverlapsEdge = [&](FVector2f Start, FVector2f End, FVector2f P)
				{
					const FVector2f Edge = End - Start;
					return Cross(Edge, P - Start) * Winding >= -.5f * (FMath::Abs(Edge.X) + FMath::Abs(Edge.Y));
				};
				for (int32 Y = MinY; Y <= MaxY; ++Y) for (int32 X = MinX; X <= MaxX; ++X)
				{
					const FVector2f P(X + .5f, Y + .5f);
					if (OverlapsEdge(A, B, P) && OverlapsEdge(B, C, P) && OverlapsEdge(C, A, P))
						Coverage[Y * Resolution + X] = 255;
				}
			}
		}
		const auto MaskTexture = [&](const TCHAR* Name, const TArray<uint8>& Pixels)
		{
			UTexture2D* Texture = Asset<UTexture2D>(FString::Printf(TEXT("T_Athletic%s_%04d"), Name, Index), Packages);
			Texture->Source.Init(Resolution, Resolution, 1, 1, TSF_G8, Pixels.GetData());
			Texture->SRGB = false;
			Texture->CompressionSettings = TC_Grayscale;
			Texture->AddressX = Texture->AddressY = TA_Clamp;
			Texture->PostEditChange();
			return Texture;
		};
		UTexture2D* Mask = MaskTexture(TEXT("PileMask"), Coverage);
		// Grass maps sample at Landscape resolution. Spawn beyond edges, then clip the final fibers to the fine mask.
		const double PaddingM = FMath::Max(Landscape->GetActorScale3D().X, Landscape->GetActorScale3D().Y) * .02 + .16;
		const int32 RadiusX = int32(FMath::Clamp(FMath::CeilToDouble(PaddingM / Width * Resolution), 0., double(Resolution)));
		const int32 RadiusY = int32(FMath::Clamp(FMath::CeilToDouble(PaddingM / Height * Resolution), 0., double(Resolution)));
		TArray<uint8> Horizontal, Expanded;
		Horizontal.SetNumUninitialized(Coverage.Num());
		Expanded.SetNumUninitialized(Coverage.Num());
		for (int32 Y = 0; Y < Resolution; ++Y)
		{
			int32 Count = 0;
			for (int32 X = 0; X <= FMath::Min(RadiusX, Resolution - 1); ++X) Count += Coverage[Y * Resolution + X] > 0;
			for (int32 X = 0; X < Resolution; ++X)
			{
				Horizontal[Y * Resolution + X] = Count > 0 ? 255 : 0;
				if (X - RadiusX >= 0) Count -= Coverage[Y * Resolution + X - RadiusX] > 0;
				if (X + RadiusX + 1 < Resolution) Count += Coverage[Y * Resolution + X + RadiusX + 1] > 0;
			}
		}
		for (int32 X = 0; X < Resolution; ++X)
		{
			int32 Count = 0;
			for (int32 Y = 0; Y <= FMath::Min(RadiusY, Resolution - 1); ++Y) Count += Horizontal[Y * Resolution + X] > 0;
			for (int32 Y = 0; Y < Resolution; ++Y)
			{
				Expanded[Y * Resolution + X] = Count > 0 ? 255 : 0;
				if (Y - RadiusY >= 0) Count -= Horizontal[(Y - RadiusY) * Resolution + X] > 0;
				if (Y + RadiusY + 1 < Resolution) Count += Horizontal[(Y + RadiusY + 1) * Resolution + X] > 0;
			}
		}
		UTexture2D* PlacementMask = MaskTexture(TEXT("PilePlacement"), Expanded);

		const auto WorldUV = [&](UMaterial* Material)
		{
			UMaterialExpression* Position;
			if (Material == Ground)
			{
				auto* Coords = CastChecked<UMaterialExpressionLandscapeLayerCoords>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionLandscapeLayerCoords::StaticClass()));
				Coords->MappingScale = 1;
				Position = Coords;
			}
			else
			{
				auto* WorldPosition = CastChecked<UMaterialExpressionWorldPosition>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionWorldPosition::StaticClass()));
				WorldPosition->WorldPositionShaderOffset = WPT_Default;
				Position = WorldPosition;
			}
			auto* UV = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCustom::StaticClass()));
			UV->Inputs.Empty();
			FCustomInput& Input = UV->Inputs.AddDefaulted_GetRef();
			Input.InputName = TEXT("P");
			Input.Input.Connect(0, Position);
			UV->OutputType = CMOT_Float2;
			if (Material == Ground)
			{
				const FVector Scale = Landscape->GetActorScale3D(), Location = Landscape->GetActorLocation();
				UV->Code = FString::Printf(TEXT("return float2((P.y*%.17g+%.17g-(%.17g))/%.17g,((%.17g)-(P.x*%.17g+%.17g))/%.17g);"),
					Scale.Y * .01, Location.Y * .01, West, Width, North, Scale.X * .01, Location.X * .01, Height);
			}
			else
				UV->Code = FString::Printf(TEXT("return float2((P.y*.01-(%.17g))/%.17g,((%.17g)-P.x*.01)/%.17g);"), West, Width, North, Height);
			return UV;
		};
		const auto CoverageAt = [&](UMaterial* Target, bool bPlacement)
		{
			auto* Density = CastChecked<UMaterialExpressionTextureSample>(UMaterialEditingLibrary::CreateMaterialExpression(Target, UMaterialExpressionTextureSample::StaticClass()));
			Density->Texture = bPlacement ? PlacementMask : Mask;
			Density->SamplerType = SAMPLERTYPE_LinearGrayscale;
			Density->Coordinates.Connect(0, WorldUV(Target));
			// Clamped sampling alone would extend edge texels over the entire landscape.
			auto* Inside = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Target, UMaterialExpressionCustom::StaticClass()));
			Inside->Inputs.Empty();
			Inside->OutputType = CMOT_Float1;
			FCustomInput& MaskInput = Inside->Inputs.AddDefaulted_GetRef();
			MaskInput.InputName = TEXT("Mask"); MaskInput.Input.Connect(1, Density);
			FCustomInput& UVInput = Inside->Inputs.AddDefaulted_GetRef();
			UVInput.InputName = TEXT("UV"); UVInput.Input.Connect(0, Density->Coordinates.Expression);
			const double U = bPlacement ? PaddingM / Width : 0, V = bPlacement ? PaddingM / Height : 0;
			Inside->Code = FString::Printf(TEXT("return Mask*step(%.17g,UV.x)*step(UV.x,%.17g)*step(%.17g,UV.y)*step(UV.y,%.17g);"), -U, 1 + U, -V, 1 + V);
			return Inside;
		};

		UMaterial* Material = Asset<UMaterial>(FString::Printf(TEXT("M_AthleticPile_%04d"), Index), Packages);
		Material->TwoSided = true;
		Material->SetShadingModel(MSM_TwoSidedFoliage);
		Material->bTangentSpaceNormal = false;
		Material->MaxWorldPositionOffsetDisplacement = 18;
		// Avoid the bare band seen with UE 5.8 HISM dithering and this bounded WPO.
		Material->DitheredLODTransition = false;
		Material->BlendMode = BLEND_Masked;
		Material->OpacityMaskClipValue = .5f;
		Material->bUsedWithInstancedStaticMeshes = true;
		auto* Colour = CastChecked<UMaterialExpressionTextureSample>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureSample::StaticClass()));
		Colour->Texture = Atlas;
		Colour->SamplerType = SAMPLERTYPE_Color;
		auto* Vertex = CastChecked<UMaterialExpressionVertexColor>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionVertexColor::StaticClass()));
		UMaterialEditingLibrary::ConnectMaterialProperty(CoverageAt(Material, false), TEXT(""), MP_OpacityMask);
		auto* Instance = CastChecked<UMaterialExpressionPerInstanceRandom>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionPerInstanceRandom::StaticClass()));
		auto* BladeUV = CastChecked<UMaterialExpressionTextureCoordinate>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureCoordinate::StaticClass()));
		BladeUV->CoordinateIndex = 0;
		const FPatchCoordinates Coordinates = PatchCoordinates(Material, nullptr);
		UMaterialExpression* Root = Coordinates.Root;
		// One placement value keeps dye, geometry and normal rotation on the same strand.
		auto* Placement = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCustom::StaticClass()));
		Placement->Inputs.Empty(); Placement->OutputType = CMOT_Float4;
		for (const auto& Pair : {TPair<FName, UMaterialExpression*>(TEXT("Root"), Root),
			TPair<FName, UMaterialExpression*>(TEXT("Seed"), Vertex), TPair<FName, UMaterialExpression*>(TEXT("Instance"), Instance)})
		{
			FCustomInput& Input = Placement->Inputs.AddDefaulted_GetRef();
			Input.InputName = Pair.Key; Input.Input.Connect(Pair.Key == TEXT("Seed") ? 3 : 0, Pair.Value);
		}
		Placement->Code = FString::Printf(TEXT(R"HLSL(
float2 across=float2(%.17g,%.17g), along=float2(-across.y,across.x);
float r=frac(sin(Seed*127.1+Instance*311.7)*43758.5453);
float s=frac(sin(Seed*269.5+Instance*183.3)*2578.543);
float row=dot(Root.xy,across);
float2 shift=across*(floor(row+.5)-row+(r-.5)*1.)+along*((s-.5)*1.2);
return float4(shift,r,s);
)HLSL"), FMath::Cos(Radians), -FMath::Sin(Radians));
		auto* RootColourUV = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCustom::StaticClass()));
		RootColourUV->Inputs.Empty(); RootColourUV->OutputType = CMOT_Float2;
		for (const auto& Pair : {TPair<FName, UMaterialExpression*>(TEXT("Root"), Root), TPair<FName, UMaterialExpression*>(TEXT("Placement"), Placement)})
		{
			FCustomInput& Input = RootColourUV->Inputs.AddDefaulted_GetRef();
			Input.InputName = Pair.Key; Input.Input.Connect(0, Pair.Value);
		}
		RootColourUV->Code = FString::Printf(TEXT("return float2(((Root.y+Placement.y)*.01-(%.17g))/%.17g,((%.17g)-(Root.x+Placement.x)*.01)/%.17g);"), West, Width, North, Height);
		auto* FixedColourUV = CastChecked<UMaterialExpressionVertexInterpolator>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionVertexInterpolator::StaticClass()));
		FixedColourUV->Input.Connect(0, RootColourUV);
		Colour->Coordinates.Connect(0, FixedColourUV);
		auto* VariationValue = CastChecked<UMaterialExpressionComponentMask>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionComponentMask::StaticClass()));
		VariationValue->Input.Connect(0, Placement); VariationValue->A = true; VariationValue->R = VariationValue->G = VariationValue->B = false;
		auto* Variation = CastChecked<UMaterialExpressionVertexInterpolator>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionVertexInterpolator::StaticClass()));
		Variation->Input.Connect(0, VariationValue);
		auto* BladeNormal = CastChecked<UMaterialExpressionVertexNormalWS>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionVertexNormalWS::StaticClass()));
		auto* Finish = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCustom::StaticClass()));
		Finish->Inputs.Empty();
		Finish->OutputType = CMOT_Float3;
		for (const auto& Pair : {TPair<FName, UMaterialExpression*>(TEXT("N"), BladeNormal), TPair<FName, UMaterialExpression*>(TEXT("CutEnd"), Vertex),
			TPair<FName, UMaterialExpression*>(TEXT("Seed"), Vertex), TPair<FName, UMaterialExpression*>(TEXT("Variation"), Variation), TPair<FName, UMaterialExpression*>(TEXT("UV"), BladeUV)})
		{
			FCustomInput& Input = Finish->Inputs.AddDefaulted_GetRef();
			Input.InputName = Pair.Key; Input.Input.Connect(Pair.Key == TEXT("Seed") ? 3 : Pair.Key == TEXT("CutEnd") ? 2 : 0, Pair.Value);
		}
		FCustomOutput& Roughness = Finish->AdditionalOutputs.AddDefaulted_GetRef();
		Roughness.OutputName = TEXT("Roughness"); Roughness.OutputType = CMOT_Float1;
		Finish->Code = TEXT(R"HLSL(
float angle=(Variation-.5)*.6;
float3 n=float3(cos(angle)*N.x-sin(angle)*N.y,sin(angle)*N.x+cos(angle)*N.y,N.z);
if(CutEnd>.5){Roughness=.48+.05*Seed;return normalize(n);}
Roughness=.38+.12*Seed;
float3 across=normalize(cross(n,float3(0,0,1))+float3(.0001,0,0));
return normalize(n*.8+float3(0,0,.65)+across*sin((UV.x-.5)*3.14159265)*.35);
)HLSL");
		Finish->RebuildOutputs();
		UMaterialEditingLibrary::ConnectMaterialProperty(Finish, TEXT(""), MP_Normal);
		UMaterialEditingLibrary::ConnectMaterialProperty(Finish, TEXT("Roughness"), MP_Roughness);

		auto* Shade = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCustom::StaticClass()));
		Shade->Inputs.Empty();
		Shade->OutputType = CMOT_Float3;
		FCustomInput& ColourInput = Shade->Inputs.AddDefaulted_GetRef();
		ColourInput.InputName = TEXT("Colour"); ColourInput.Input.Connect(0, Colour);
		FCustomInput& HeightInput = Shade->Inputs.AddDefaulted_GetRef();
		HeightInput.InputName = TEXT("Height"); HeightInput.Input.Connect(1, Vertex);
		FCustomInput& ShadeSeed = Shade->Inputs.AddDefaulted_GetRef();
		ShadeSeed.InputName = TEXT("Seed"); ShadeSeed.Input.Connect(3, Vertex);
		Shade->Code = TEXT("float exposed=smoothstep(.05,.45,Height); return min(Colour*lerp(.1,lerp(.55,1.45,Height),exposed)*lerp(.85,1.15,Seed),.95);");
		UMaterialEditingLibrary::ConnectMaterialProperty(Shade, TEXT(""), MP_BaseColor);
		auto* Transmitted = CastChecked<UMaterialExpressionMultiply>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionMultiply::StaticClass()));
		Transmitted->A.Connect(0, Shade);
		Transmitted->ConstB = .2f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Transmitted, TEXT(""), MP_SubsurfaceColor);
		auto* Up = CastChecked<UMaterialExpressionConstant3Vector>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionConstant3Vector::StaticClass()));
		Up->Constant = FLinearColor(0, 0, 1);
		for (const auto& Property : {TPair<EMaterialProperty, float>(MP_Specular, .45f)})
		{
			auto* Value = CastChecked<UMaterialExpressionConstant>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionConstant::StaticClass()));
			Value->R = Property.Value;
			UMaterialEditingLibrary::ConnectMaterialProperty(Value, TEXT(""), Property.Key);
		}
		auto* Eye = CastChecked<UMaterialExpressionCameraPositionWS>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCameraPositionWS::StaticClass()));
		auto* Sink = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCustom::StaticClass()));
		Sink->Inputs.Empty();
		Sink->OutputType = CMOT_Float3;
		FCustomInput& EyeInput = Sink->Inputs.AddDefaulted_GetRef();
		EyeInput.InputName = TEXT("Eye"); EyeInput.Input.Connect(0, Eye);
		auto* Normal = CastChecked<UMaterialExpressionTransform>(UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTransform::StaticClass()));
		Normal->Input.Connect(0, Up);
		Normal->TransformSourceType = TRANSFORMSOURCE_Local;
		Normal->TransformType = TRANSFORM_World;
		FCustomInput& PositionInput = Sink->Inputs.AddDefaulted_GetRef();
		PositionInput.InputName = TEXT("Root"); PositionInput.Input.Connect(0, Root);
		FCustomInput& DeltaInput = Sink->Inputs.AddDefaulted_GetRef();
		DeltaInput.InputName = TEXT("Delta"); DeltaInput.Input.Connect(0, Coordinates.Delta);
		FCustomInput& NormalInput = Sink->Inputs.AddDefaulted_GetRef();
		NormalInput.InputName = TEXT("N"); NormalInput.Input.Connect(0, Normal);
		FCustomInput& PlacementInput = Sink->Inputs.AddDefaulted_GetRef();
		PlacementInput.InputName = TEXT("Placement"); PlacementInput.Input.Connect(0, Placement);
		Sink->Code = TEXT(R"HLSL(
float3 root=Root;
float2 shift=Placement.xy;
float turn=(Placement.w-.5)*.6;
float2 tilted=float2(cos(turn)*Delta.x-sin(turn)*Delta.y,sin(turn)*Delta.x+cos(turn)*Delta.y);
float3 varied=float3(tilted,Delta.z*(.92+.16*Placement.z));
float fade=1-smoothstep(300.,1000.,distance(root,Eye));
return float3(shift,2.5-dot(shift,N.xy)/max(N.z,.1))+varied*fade-Delta;
)HLSL");
		UMaterialEditingLibrary::ConnectMaterialProperty(Sink, TEXT(""), MP_WorldPositionOffset);
		UMaterialEditingLibrary::RecompileMaterial(Material);

		UStaticMesh* Mesh = Asset<UStaticMesh>(FString::Printf(TEXT("SM_AthleticPile_%04d"), Index), Packages);
		const auto MakePatch = [&](int32 Segments, bool bTipCaps)
		{
			FMeshDescription Description;
			FStaticMeshAttributes Attributes(Description);
			Attributes.Register();
			auto Positions = Attributes.GetVertexPositions();
			auto Normals = Attributes.GetVertexInstanceNormals();
			auto UVs = Attributes.GetVertexInstanceUVs();
			auto Colours = Attributes.GetVertexInstanceColors();
			UVs.SetNumChannels(4);
			const FPolygonGroupID Group = Description.CreatePolygonGroup();
			Attributes.GetPolygonGroupMaterialSlotNames()[Group] = TEXT("Fiber");
			FRandomStream Random(5107);
			const float Angle = float(Radians);
			const FVector2f Along(FMath::Sin(Angle), FMath::Cos(Angle));
			const FVector2f Across(-Along.Y, Along.X);
			for (int32 Row = 0; Row < 20; ++Row) for (int32 Stitch = 0; Stitch < 20; ++Stitch)
			for (int32 Strand = 0; Strand < 8; ++Strand)
			{
				// Keep every strand in both LODs; simplify its curve and omit unresolved cut ends at distance.
				const FVector2f Root(-9.5f + Row, -9.5f + Stitch);
				const float BladeHeight = Random.FRandRange(.6f, 1.4f);
				const FVector2f Lean = Along * Random.FRandRange(-.45f, .45f) + Across * Random.FRandRange(-.35f, .35f);
				const float Facing = Random.FRand() * PI;
				const FVector2f Side = FVector2f(FMath::Cos(Facing), FMath::Sin(Facing)) * Random.FRandRange(.05f, .08f);
				const float Seed = Random.FRand();
				const auto Point = [&](float T, float Edge) { return Root + Lean * (T * T) + Side * Edge; };
				const auto AddVertex = [&](FVector3f P, FVector3f Normal, FVector2f UV, bool bCutEnd)
				{
					const FVertexID V = Description.CreateVertex();
					Positions[V] = P;
					const FVertexInstanceID VI = Description.CreateVertexInstance(V);
					Normals[VI] = Normal;
					UVs.Set(VI, 0, UV);
					UVs.Set(VI, 1, Root);
					UVs.Set(VI, 2, FVector2f(P.X, P.Y) - Root);
					UVs.Set(VI, 3, FVector2f(P.Z, 0));
					// R is height, G marks cut ends, and B retains the strand seed.
					Colours[VI] = FVector4f(UV.Y, bCutEnd ? 1.f : 0.f, Seed, 1);
					return VI;
				};
				const FVector3f Side3(Side.X, Side.Y, 0);
				const auto AddRibbon = [&](float T, float Edge)
				{
					const FVector2f P = Point(T, Edge);
					const FVector3f Tangent(2 * T * Lean.X, 2 * T * Lean.Y, BladeHeight);
					return AddVertex(FVector3f(P.X, P.Y, BladeHeight * T),
						FVector3f::CrossProduct(Tangent, Side3).GetSafeNormal(), FVector2f(Edge * .5f + .5f, T), false);
				};
				for (int32 Segment = 0; Segment < Segments; ++Segment)
				{
					const float T0 = float(Segment) / Segments, T1 = float(Segment + 1) / Segments;
					const auto L0 = AddRibbon(T0, -1), R0 = AddRibbon(T0, 1), L1 = AddRibbon(T1, -1), R1 = AddRibbon(T1, 1);
					Description.CreatePolygon(Group, {L0, R0, R1});
					Description.CreatePolygon(Group, {L0, R1, L1});
				}
				if (bTipCaps)
				{
					const FVector2f P = Point(1, 0);
					const FVector3f Tip(P.X, P.Y, BladeHeight);
					const FVector3f Face = FVector3f::CrossProduct(FVector3f(2 * Lean.X, 2 * Lean.Y, BladeHeight), Side3).GetSafeNormal();
					const FVector3f CutNormal = FVector3f::CrossProduct(Side3, Face).GetSafeNormal();
					const FVector3f HalfThickness = Face * .005f;
					const auto L0 = AddVertex(Tip - Side3 - HalfThickness, CutNormal, FVector2f(0, 1), true);
					const auto R0 = AddVertex(Tip + Side3 - HalfThickness, CutNormal, FVector2f(1, 1), true);
					const auto L1 = AddVertex(Tip - Side3 + HalfThickness, CutNormal, FVector2f(0, 1), true);
					const auto R1 = AddVertex(Tip + Side3 + HalfThickness, CutNormal, FVector2f(1, 1), true);
					Description.CreatePolygon(Group, {L0, R1, R0});
					Description.CreatePolygon(Group, {L0, L1, R1});
				}
			}
			return Description;
		};
		FMeshDescription Near = MakePatch(5, true), Far = MakePatch(2, false);
		Mesh->GetStaticMaterials().Add(FStaticMaterial(Material, TEXT("Fiber")));
		Mesh->SetAutoComputeLODScreenSize(false);
		Mesh->SetNumSourceModels(2);
		// UV1 stores constant fiber roots; lightmap unwrapping would overwrite them.
		for (int32 LOD = 0; LOD < 2; ++LOD)
		{
			FStaticMeshSourceModel& Model = Mesh->GetSourceModel(LOD);
			// Preserve smooth ribbon normals and flat cut-end normals.
			Model.BuildSettings.bRecomputeNormals = false;
			Model.BuildSettings.bGenerateLightmapUVs = false;
			// Both LODs are authored; the default reduction would replace the far mesh with half of LOD0.
			Model.ReductionSettings.PercentTriangles = 1;
			Model.ReductionSettings.PercentVertices = 1;
			Model.ReductionSettings.MaxDeviation = 0;
			Model.ReductionSettings.BaseLODModel = LOD;
		}
		Mesh->GetSourceModel(0).ScreenSize = 1.f;
		Mesh->GetSourceModel(1).ScreenSize = .12f;
		UStaticMesh::FBuildMeshDescriptionsParams Params;
		Params.bFastBuild = false;
		Params.bBuildSimpleCollision = false;
		Mesh->BuildFromMeshDescriptions({&Near, &Far}, Params);
		FStaticMeshCompilingManager::Get().FinishCompilation({Mesh});

		UMaterial* Infill = Asset<UMaterial>(FString::Printf(TEXT("M_AthleticInfill_%04d"), Index), Packages);
		Infill->SetShadingModel(MSM_DefaultLit);
		Infill->bTangentSpaceNormal = false;
		Infill->BlendMode = BLEND_Masked;
		Infill->OpacityMaskClipValue = .5f;
		Infill->bUsedWithInstancedStaticMeshes = true;
		Infill->MaxWorldPositionOffsetDisplacement = 4;
		Infill->DitheredLODTransition = false;
		UMaterialEditingLibrary::ConnectMaterialProperty(CoverageAt(Infill, false), TEXT(""), MP_OpacityMask);
		auto* InfillPosition = CastChecked<UMaterialExpressionPreSkinnedPosition>(UMaterialEditingLibrary::CreateMaterialExpression(Infill, UMaterialExpressionPreSkinnedPosition::StaticClass()));
		const FPatchCoordinates InfillCoordinates = PatchCoordinates(Infill, InfillPosition);
		auto* InfillEye = CastChecked<UMaterialExpressionCameraPositionWS>(UMaterialEditingLibrary::CreateMaterialExpression(Infill, UMaterialExpressionCameraPositionWS::StaticClass()));
		auto* InfillOffset = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Infill, UMaterialExpressionCustom::StaticClass()));
		InfillOffset->Inputs.Empty(); InfillOffset->OutputType = CMOT_Float3;
		for (const auto& Pair : {TPair<FName, UMaterialExpression*>(TEXT("Root"), InfillCoordinates.Root),
			TPair<FName, UMaterialExpression*>(TEXT("Delta"), InfillCoordinates.Delta), TPair<FName, UMaterialExpression*>(TEXT("Eye"), InfillEye)})
		{
			FCustomInput& Input = InfillOffset->Inputs.AddDefaulted_GetRef();
			Input.InputName = Pair.Key; Input.Input.Connect(0, Pair.Value);
		}
		// Collapse each crumb to its own root before culling; the fine bed texture remains underneath.
		InfillOffset->Code = TEXT("return float3(0,0,2.5)-Delta*smoothstep(200.,400.,distance(Root,Eye));");
		UMaterialEditingLibrary::ConnectMaterialProperty(InfillOffset, TEXT(""), MP_WorldPositionOffset);
		auto* InfillSeed = CastChecked<UMaterialExpressionVertexColor>(UMaterialEditingLibrary::CreateMaterialExpression(Infill, UMaterialExpressionVertexColor::StaticClass()));
		auto* InfillInstance = CastChecked<UMaterialExpressionPerInstanceRandom>(UMaterialEditingLibrary::CreateMaterialExpression(Infill, UMaterialExpressionPerInstanceRandom::StaticClass()));
		auto* InfillLocalZ = CastChecked<UMaterialExpressionComponentMask>(UMaterialEditingLibrary::CreateMaterialExpression(Infill, UMaterialExpressionComponentMask::StaticClass()));
		InfillLocalZ->Input.Connect(0, InfillPosition); InfillLocalZ->B = true; InfillLocalZ->R = InfillLocalZ->G = InfillLocalZ->A = false;
		auto* InfillHeight = CastChecked<UMaterialExpressionVertexInterpolator>(UMaterialEditingLibrary::CreateMaterialExpression(Infill, UMaterialExpressionVertexInterpolator::StaticClass()));
		InfillHeight->Input.Connect(0, InfillLocalZ);
		auto* InfillShade = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Infill, UMaterialExpressionCustom::StaticClass()));
		InfillShade->Inputs.Empty(); InfillShade->OutputType = CMOT_Float3;
		for (const auto& Pair : {TPair<FName, UMaterialExpression*>(TEXT("Seed"), InfillSeed), TPair<FName, UMaterialExpression*>(TEXT("Instance"), InfillInstance),
			TPair<FName, UMaterialExpression*>(TEXT("Height"), InfillHeight)})
		{
			FCustomInput& Input = InfillShade->Inputs.AddDefaulted_GetRef();
			Input.InputName = Pair.Key; Input.Input.Connect(Pair.Key == TEXT("Seed") ? 1 : 0, Pair.Value);
		}
		FCustomOutput& InfillRoughness = InfillShade->AdditionalOutputs.AddDefaulted_GetRef();
		InfillRoughness.OutputName = TEXT("Roughness"); InfillRoughness.OutputType = CMOT_Float1;
		InfillShade->Code = TEXT("float v=frac(Seed+Instance*.75487766); float contact=lerp(.1,1.,smoothstep(.02,.03,Height)); Roughness=lerp(.45,.78,v); return float3(.008,.012,.018)*lerp(.55,2.2,v)*contact;");
		InfillShade->RebuildOutputs();
		UMaterialEditingLibrary::ConnectMaterialProperty(InfillShade, TEXT(""), MP_BaseColor);
		UMaterialEditingLibrary::ConnectMaterialProperty(InfillShade, TEXT("Roughness"), MP_Roughness);
		auto* InfillSpecular = CastChecked<UMaterialExpressionConstant>(UMaterialEditingLibrary::CreateMaterialExpression(Infill, UMaterialExpressionConstant::StaticClass()));
		InfillSpecular->R = .55f;
		UMaterialEditingLibrary::ConnectMaterialProperty(InfillSpecular, TEXT(""), MP_Specular);
		auto* GrainPosition = CastChecked<UMaterialExpressionWorldPosition>(UMaterialEditingLibrary::CreateMaterialExpression(Infill, UMaterialExpressionWorldPosition::StaticClass()));
		GrainPosition->WorldPositionShaderOffset = WPT_CameraRelative;
		auto* GrainNormal = CastChecked<UMaterialExpressionVertexNormalWS>(UMaterialEditingLibrary::CreateMaterialExpression(Infill, UMaterialExpressionVertexNormalWS::StaticClass()));
		auto* GrainFacet = CastChecked<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpression(Infill, UMaterialExpressionCustom::StaticClass()));
		GrainFacet->Inputs.Empty(); GrainFacet->OutputType = CMOT_Float3;
		for (const auto& Pair : {TPair<FName, UMaterialExpression*>(TEXT("P"), GrainPosition), TPair<FName, UMaterialExpression*>(TEXT("N"), GrainNormal)})
		{
			FCustomInput& Input = GrainFacet->Inputs.AddDefaulted_GetRef();
			Input.InputName = Pair.Key; Input.Input.Connect(0, Pair.Value);
		}
		GrainFacet->Code = TEXT(R"HLSL(
float3 n=normalize(N);
float3 f=cross(ddx_fine(P),ddy_fine(P));
float d=dot(f,f);
f=d>1.e-12 ? f*rsqrt(max(d,1.e-12)) : n;
f*=dot(f,n)<0 ? -1 : 1;
return normalize(f*.55+n*.45);
)HLSL");
		UMaterialEditingLibrary::ConnectMaterialProperty(GrainFacet, TEXT(""), MP_Normal);
		UMaterialEditingLibrary::RecompileMaterial(Infill);

		ULandscapeGrassType* Grass = Asset<ULandscapeGrassType>(FString::Printf(TEXT("LGT_AthleticPile_%04d"), Index), Packages);
		Grass->bEnableDensityScaling = false;
		const FPerPlatformFloat PatchDensity(2500);
		FGrassVariety& Variety = Grass->GrassVarieties.AddDefaulted_GetRef();
		Variety.GrassMesh = Mesh;
		Variety.GrassDensity = PatchDensity;
		Variety.GrassDensityQuality.Default = Variety.GrassDensity.GetValue();
		Variety.StartCullDistance = FPerPlatformInt(900);
		Variety.StartCullDistanceQuality.Default = Variety.StartCullDistance.GetValue();
		Variety.EndCullDistance = FPerPlatformInt(1100);
		Variety.EndCullDistanceQuality.Default = Variety.EndCullDistance.GetValue();
		Variety.bUseGrid = true;
		Variety.PlacementJitter = 0;
		Variety.RandomRotation = false;
		Variety.AlignToSurface = true;
		Variety.bCastDynamicShadow = false;
		FGrassVariety& Crumbs = Grass->GrassVarieties.AddDefaulted_GetRef();
		Crumbs.GrassMesh = MakeAthleticInfillMesh(Index, Infill, Packages);
		Crumbs.GrassDensity = PatchDensity;
		Crumbs.GrassDensityQuality.Default = Crumbs.GrassDensity.GetValue();
		Crumbs.StartCullDistance = FPerPlatformInt(400);
		Crumbs.StartCullDistanceQuality.Default = Crumbs.StartCullDistance.GetValue();
		Crumbs.EndCullDistance = FPerPlatformInt(450);
		Crumbs.EndCullDistanceQuality.Default = Crumbs.EndCullDistance.GetValue();
		Crumbs.bUseGrid = true;
		Crumbs.PlacementJitter = 0;
		Crumbs.RandomRotation = false;
		Crumbs.AlignToSurface = true;
		Crumbs.bCastDynamicShadow = false;
		FGrassInput& Input = Output->GrassTypes.AddDefaulted_GetRef();
		Input.Name = FName(*FString::Printf(TEXT("AthleticPile_%04d"), Index));
		Input.GrassType = Grass;
		Input.Input.Connect(0, CoverageAt(Ground, true));
		UMaterialEditingLibrary::RecompileMaterial(Ground);
		return true;
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
	UTexture2D* InfillTexture = nullptr;
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
		double West;
		double North;
		bool bCollision;
		bool bAnchored;
		FString MaterialKey() const
		{
			return FString::Printf(TEXT("%s|%s|%.17g|%.17g|%.17g|%.17g|%.17g|%.17g"),
				*Name, *Image, Heading, StripeWidth, Width, Height, West, North);
		}
	};
	TArray<FPendingMesh> Pending;
	int32 TotalTriangles = 0;
	int32 ProjectedPaintCount = 0;
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
		const bool bGrassPaint = Name.StartsWith(TEXT("grass_paint_"));
		if (!Finish && !bDecal)
		{
			Error = TEXT("unknown streetscape finish: ") + Name;
			return false;
		}
		TArray<double> Anchor;
		const bool bAnchored = Row->HasField(TEXT("anchor_m"));
		if (bGrassPaint && (bCollision || bAnchored))
		{
			Error = TEXT("grass paint cannot have collision or a prop anchor");
			return false;
		}
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
			if (bAthletic && !FMath::IsNearlyEqual(P[2], .025, 1.e-6))
			{
				Error = TEXT("athletic turf must follow the landscape at a 0.025 m offset for streamed pile");
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
			if (bGrassPaint && (FMath::Abs((DB.X - DA.X) * (DC.Y - DA.Y) - (DB.Y - DA.Y) * (DC.X - DA.X)) <= 1.e-12
				|| FMath::Abs(double(B.X - A.X) * (C.Y - A.Y) - double(B.Y - A.Y) * (C.X - A.X)) <= 1.e-12))
			{
				Error = FString::Printf(TEXT("grass paint triangle in mesh %d needs a nonzero horizontal footprint"), Index);
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
			bRegistered ? Bounds[2] - Bounds[0] : 0, bRegistered ? Bounds[3] - Bounds[1] : 0,
			bRegistered ? Bounds[0] : 0, bRegistered ? Bounds[3] : 0, bCollision, bAnchored});
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
			UTexture2D* Atlas = Name == TEXT("athletic_turf") ? MakeRegisteredTexture(Index, Decals.FindChecked(Item.Image), true, Packages) : nullptr;
			if (Atlas && !InfillTexture) InfillTexture = MakeAthleticInfillTexture(Packages);
			UMaterial* Material = Name == TEXT("athletic_turf")
				? MakeAthleticMaterial(Index, Atlas, InfillTexture, Item.Heading, Item.StripeWidth, Packages)
				: Item.Image.IsEmpty() ? MakeMaterial(Name, Finishes.FindChecked(Name), Packages)
				: MakeDecalMaterial(Index, Decals.FindChecked(Item.Image), Packages, Name == TEXT("grass_paint_decal"));
			if (!Material)
			{
				Error = TEXT("cannot load the engine's DitherTemporalAA function for chainlink");
				return false;
			}
			Materials.Add(MaterialKey, Material);
			if (Atlas)
			{
				TArray<const FMeshDescription*> Surfaces;
				for (const FPendingMesh& Surface : Pending)
					if (Surface.MaterialKey() == MaterialKey) Surfaces.Add(&Surface.Description);
				if (!AddAthleticPile(World, Index, Atlas, Item.West, Item.North, Item.Width, Item.Height, Item.Heading, Surfaces, Packages, Error)) return false;
			}
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
		if (!Item.Image.IsEmpty()) Params.PerLODOverrides.AddDefaulted_GetRef().bUseFullPrecisionUVs = true;
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
		if (Name.StartsWith(TEXT("grass_paint_")))
		{
			// Keep the footprint's semantic mask while visible paint is restricted to grass-like receivers.
			Component->SetRenderInMainPass(false);
			Component->SetRenderInDepthPass(false);
			ProjectGrassPaint(World, Index, Description, Item.Image.IsEmpty() ? nullptr : &Decals.FindChecked(Item.Image),
				FVector4d(Item.West, Item.North, Item.Width, Item.Height),
				Finishes.FindChecked(Item.Image.IsEmpty() ? Name : TEXT("grass_paint_white")).Albedo, Packages, Actors);
			++ProjectedPaintCount;
		}
		TotalTriangles += Description.Triangles().Num();
	}
	if (ProjectedPaintCount > 0)
	{
		for (TActorIterator<AActor> It(World); It; ++It)
		{
			if (!It->ActorHasTag(EnvGenStandingTag()) || It->ActorHasTag(FName(TEXT("EnvGenPaving")))) continue;
			TInlineComponentArray<UPrimitiveComponent*> Components;
			It->GetComponents(Components);
			for (UPrimitiveComponent* Component : Components) Component->SetReceivesDecals(false);
		}
	}
	Receipt->SetNumberField(TEXT("streetscape_features"), FeatureCount);
	Receipt->SetNumberField(TEXT("streetscape_meshes"), Pending.Num());
	Receipt->SetNumberField(TEXT("streetscape_projected_paint"), ProjectedPaintCount);
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
			Values->SetNumberField(TEXT("pile_height_min_m"), .00552);
			Values->SetNumberField(TEXT("pile_height_max_m"), .015174);
			Values->SetNumberField(TEXT("pile_end_cull_m"), 11);
			Values->SetNumberField(TEXT("roll_seam_half_width_m"), .008);
			Values->SetNumberField(TEXT("distant_crumb_fraction"), .36);
			Values->SetNumberField(TEXT("specular"), .45);
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
