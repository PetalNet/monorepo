#include "EnvGenArchitecture.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonObject.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionTextureCoordinate.h"
#include "MeshDescription.h"
#include "PhysicsEngine/BodySetup.h"
#include "StaticMeshAttributes.h"
#include "StaticMeshCompiler.h"
#include "UObject/Package.h"

namespace EnvGenArchitecture
{
namespace
{
FVector World(const FVector2D& Point, double Z) { return FVector(Point.Y * 100, Point.X * 100, Z); }

void Quad(FVector A, FVector B, FVector C, FVector D, FVector Normal, FLinearColor Colour, FTriangle Emit)
{
	Emit(A, B, C, Normal, Colour);
	Emit(A, C, D, Normal, Colour);
}

void Box(FVector Centre, FVector Along, FVector Out, FVector Size, FLinearColor Colour, FTriangle Emit)
{
	const FVector U = Along * Size.X * 0.5, V = Out * Size.Y * 0.5, W(0, 0, Size.Z * 0.5);
	Quad(Centre-U-V+W, Centre+U-V+W, Centre+U+V+W, Centre-U+V+W, FVector::UpVector, Colour, Emit);
	Quad(Centre-U-V-W, Centre-U+V-W, Centre+U+V-W, Centre+U-V-W, -FVector::UpVector, Colour, Emit);
	Quad(Centre-U+V-W, Centre-U+V+W, Centre+U+V+W, Centre+U+V-W, Out, Colour, Emit);
	Quad(Centre+U-V-W, Centre+U-V+W, Centre-U-V+W, Centre-U-V-W, -Out, Colour, Emit);
	Quad(Centre+U+V-W, Centre+U+V+W, Centre+U-V+W, Centre+U-V-W, Along, Colour, Emit);
	Quad(Centre-U-V-W, Centre-U-V+W, Centre-U+V+W, Centre-U+V-W, -Along, Colour, Emit);
}

bool InRing(FVector2D Point, const TArray<FVector2D>& Ring)
{
	bool bInside = false;
	for (int32 I = 0, J = Ring.Num()-1; I < Ring.Num(); J = I++)
	{
		const FVector2D A = Ring[I], B = Ring[J];
		if ((A.Y > Point.Y) != (B.Y > Point.Y) && Point.X < (B.X-A.X)*(Point.Y-A.Y)/(B.Y-A.Y)+A.X)
		{
			bInside = !bInside;
		}
	}
	return bInside;
}

bool Inside(FVector2D Point, const TArray<TArray<FVector2D>>& Rings)
{
	if (!InRing(Point, Rings[0])) { return false; }
	for (int32 I = 1; I < Rings.Num(); ++I) { if (InRing(Point, Rings[I])) { return false; } }
	return true;
}

bool Fits(FVector2D Point, FVector2D U, FVector2D V, double HalfLength, double HalfWidth, const TArray<TArray<FVector2D>>& Rings)
{
	const TArray<FVector2D> Corners{Point-U*HalfLength-V*HalfWidth, Point+U*HalfLength-V*HalfWidth,
		Point+U*HalfLength+V*HalfWidth, Point-U*HalfLength+V*HalfWidth};
	for (const FVector2D Corner : Corners) { if (!Inside(Corner, Rings)) { return false; } }
	const auto Cross = [](FVector2D A, FVector2D B) { return A.X*B.Y-A.Y*B.X; };
	for (int32 RingIndex = 0; RingIndex < Rings.Num(); ++RingIndex)
	{
		const auto& Ring = Rings[RingIndex];
		if (RingIndex > 0 && FMath::Abs(FVector2D::DotProduct(Ring[0]-Point, U)) <= HalfLength
			&& FMath::Abs(FVector2D::DotProduct(Ring[0]-Point, V)) <= HalfWidth) { return false; }
		for (int32 I = 0; I < 4; ++I)
		{
			const FVector2D A = Corners[I], B = Corners[(I+1)%4];
			for (int32 J = 0; J < Ring.Num(); ++J)
			{
				const FVector2D C = Ring[J], D = Ring[(J+1)%Ring.Num()];
				if (FMath::Max(FMath::Min(A.X,B.X),FMath::Min(C.X,D.X)) > FMath::Min(FMath::Max(A.X,B.X),FMath::Max(C.X,D.X))
					|| FMath::Max(FMath::Min(A.Y,B.Y),FMath::Min(C.Y,D.Y)) > FMath::Min(FMath::Max(A.Y,B.Y),FMath::Max(C.Y,D.Y))) { continue; }
				if (Cross(B-A,C-A)*Cross(B-A,D-A) <= 0 && Cross(D-C,A-C)*Cross(D-C,B-C) <= 0) { return false; }
			}
		}
	}
	return Inside(Point, Rings);
}
}

void FStyle::Read(const TSharedPtr<FJsonObject>& Building)
{
	const TSharedPtr<FJsonObject>* Architecture = nullptr;
	if (!Building->TryGetObjectField(TEXT("architecture"), Architecture)) { return; }
	const TSharedPtr<FJsonObject>& A = *Architecture;
	bDetailed = true;
	Role = A->GetStringField(TEXT("role"));
	const auto& Colour = A->GetArrayField(TEXT("facade_albedo"));
	const FString Facade = A->GetStringField(TEXT("facade"));
	Wall = FLinearColor(Colour[0]->AsNumber(), Colour[1]->AsNumber(), Colour[2]->AsNumber(),
		Facade == TEXT("brick") ? Brick : Facade == TEXT("siding") ? Siding : Concrete);
	const auto& C = A->GetArrayField(TEXT("centre_m"));
	const auto& U = A->GetArrayField(TEXT("along"));
	Centre = FVector2D(C[0]->AsNumber(), C[1]->AsNumber());
	Along = FVector2D(U[0]->AsNumber(), U[1]->AsNumber());
	LengthM = A->GetNumberField(TEXT("length_m")); WidthM = A->GetNumberField(TEXT("width_m"));
	RiseM = A->GetNumberField(TEXT("rise_m")); ParapetM = A->GetNumberField(TEXT("parapet_m"));
	StandRows = int32(A->GetNumberField(TEXT("stand_rows"))); StandStepM = A->GetNumberField(TEXT("stand_step_m"));
	A->TryGetBoolField(TEXT("measured_roof"), bMeasuredRoof);
	A->TryGetBoolField(TEXT("press_box_prior"), bPressBoxPrior);
	const TArray<TSharedPtr<FJsonValue>>* Aisles = nullptr;
	if (A->TryGetArrayField(TEXT("stand_aisles"), Aisles))
	{
		StandAisles.Reset();
		for (const auto& Aisle : *Aisles) { StandAisles.Add(Aisle->AsNumber()); }
	}
	const FString Shape = A->GetStringField(TEXT("roof_shape"));
	RoofFinish = Shape == TEXT("gabled") || Shape == TEXT("hip") || Shape == TEXT("shed") ? Shingle : Membrane;
	FString Material;
	if (A->TryGetStringField(TEXT("roof_material"), Material))
	{
		RoofFinish = Material == TEXT("metal") ? Metal : Material == TEXT("shingle") ? Shingle : Membrane;
	}
	const TArray<TSharedPtr<FJsonValue>>* Segments = nullptr;
	if (A->TryGetArrayField(TEXT("wall_segments"), Segments))
	{
		for (const auto& Segment : *Segments)
		{
			const auto& Ends = Segment->AsArray();
			const auto ReadPoint = [](const TSharedPtr<FJsonValue>& Value) {
				const auto& P = Value->AsArray(); return FVector(P[0]->AsNumber(), P[1]->AsNumber(), P[2]->AsNumber());
			};
			WallSegments.Emplace(ReadPoint(Ends[0]), ReadPoint(Ends[1]));
		}
	}
	for (const auto& V : A->GetArrayField(TEXT("roof_vertices")))
	{
		const auto& P = V->AsArray(); RoofVertices.Add(FVector(P[0]->AsNumber(), P[1]->AsNumber(), P[2]->AsNumber()));
	}
	for (const auto& V : A->GetArrayField(TEXT("roof_triangles")))
	{
		const auto& P = V->AsArray(); RoofTriangles.Add(FIntVector(P[0]->AsNumber(), P[1]->AsNumber(), P[2]->AsNumber()));
	}
	const TArray<TSharedPtr<FJsonValue>>* Forms = nullptr;
	if (Building->TryGetArrayField(TEXT("roof_forms"), Forms))
	{
		for (const auto& Value : *Forms)
		{
			const auto Form = Value->AsObject();
			FRoofForm& F = RoofForms.AddDefaulted_GetRef();
			F.At = FVector2D(Form->GetNumberField(TEXT("east_m")), Form->GetNumberField(TEXT("north_m")));
			F.WidthM = Form->GetNumberField(TEXT("width_m")); F.DepthM = Form->GetNumberField(TEXT("depth_m")); F.HeightM = Form->GetNumberField(TEXT("height_m"));
			Form->TryGetBoolField(TEXT("observed_plan"), F.bObservedPlan);
			FString Kind; Form->TryGetStringField(TEXT("kind"), Kind); F.bSkylight = Kind == TEXT("skylight");
		}
	}
}

double FStyle::RoofOffsetM(const FVector2D& Point) const
{
	if (bMeasuredRoof)
	{
		for (const FIntVector& T : RoofTriangles)
		{
			const FVector A = RoofVertices[T.X], B = RoofVertices[T.Y], C = RoofVertices[T.Z];
			const double Den = (B.Y-C.Y)*(A.X-C.X)+(C.X-B.X)*(A.Y-C.Y);
			if (FMath::Abs(Den) < 1.e-8) { continue; }
			const double U = ((B.Y-C.Y)*(Point.X-C.X)+(C.X-B.X)*(Point.Y-C.Y))/Den;
			const double V = ((C.Y-A.Y)*(Point.X-C.X)+(A.X-C.X)*(Point.Y-C.Y))/Den;
			if (U >= -1.e-5 && V >= -1.e-5 && U+V <= 1+1.e-5) { return U*A.Z+V*B.Z+(1-U-V)*C.Z; }
		}
		return 0;
	}
	const double Across = FVector2D::DotProduct(Point-Centre, FVector2D(-Along.Y, Along.X));
	if (StandRows > 0)
	{
		const int32 Row = FMath::Clamp(FMath::FloorToInt((Across / WidthM + 0.5) * StandRows), 0, StandRows-1);
		return (Row+1-StandRows*0.5)*StandStepM;
	}
	return RiseM > 0 ? RiseM * (0.5-FMath::Abs(Across)/(WidthM*0.5)) : 0;
}

TOptional<double> FStyle::WallOffsetM(const FVector2D& Point, const FVector2D& Direction, double HalfWidth) const
{
	if (!bMeasuredRoof)
	{
		return FMath::Min(RoofOffsetM(Point-Direction*HalfWidth), RoofOffsetM(Point+Direction*HalfWidth));
	}
	double Covered = 0, Lowest = TNumericLimits<double>::Max();
	for (const auto& Segment : WallSegments)
	{
		const FVector2D A(Segment.Key.X, Segment.Key.Y), B(Segment.Value.X, Segment.Value.Y);
		const double From = FVector2D::DotProduct(A-Point, Direction), To = FVector2D::DotProduct(B-Point, Direction);
		if ((A-Point-Direction*From).Size() > 0.001 || (B-Point-Direction*To).Size() > 0.001 || FMath::Abs(To-From) < 1.e-6) { continue; }
		const double Lo = FMath::Max(-HalfWidth, FMath::Min(From, To));
		const double Hi = FMath::Min(HalfWidth, FMath::Max(From, To));
		if (Hi <= Lo) { continue; }
		Covered += Hi-Lo;
		for (const double At : {Lo, Hi})
		{
			Lowest = FMath::Min(Lowest, FMath::Lerp(Segment.Key.Z, Segment.Value.Z, (At-From)/(To-From)));
		}
	}
	return Covered >= HalfWidth*2-1.e-4 ? TOptional<double>(Lowest) : TOptional<double>();
}

FLinearColor FStyle::RoofColour(FLinearColor Colour) const
{
	Colour.A = !bDetailed ? Plain : StandRows > 0 ? Concrete : RoofFinish;
	return Colour;
}

FVector2D FStyle::RoofCheckPoint(FVector2D Anchor) const
{
	if (StandRows == 0) { return Anchor; }
	double Largest = 0;
	for (const FIntVector& T : RoofTriangles)
	{
		const FVector A = RoofVertices[T.X], B = RoofVertices[T.Y], C = RoofVertices[T.Z];
		const double Area = FMath::Abs((B.X-A.X)*(C.Y-A.Y)-(B.Y-A.Y)*(C.X-A.X));
		if (Area > Largest)
		{
			Largest = Area;
			Anchor = FVector2D((A.X+B.X+C.X)/3, (A.Y+B.Y+C.Y)/3);
		}
	}
	return Anchor;
}

bool FStyle::AddRoof(double RoofZ, FLinearColor Colour, FTriangle Emit) const
{
	if (RoofTriangles.IsEmpty()) { return false; }
	for (const FIntVector& T : RoofTriangles)
	{
		const auto At = [&](int32 I) { const FVector P = RoofVertices[I]; return World(FVector2D(P.X, P.Y), RoofZ+P.Z*100); };
		const FVector A = At(T.X), B = At(T.Y), C = At(T.Z);
		FVector Normal = FVector::CrossProduct(B-A, C-A).GetSafeNormal();
		const FVector Across(Along.X, -Along.Y, 0);
		// Measured EN faces are outward-wound; swapping EN into UE axes reverses that winding.
		if (bMeasuredRoof || Normal.Z < 0 || (FMath::Abs(Normal.Z) < 0.01 && Normal.Dot(Across) > 0)) { Normal *= -1; }
		Emit(A, B, C, Normal, Colour);
	}
	return true;
}

void FStyle::AddWall(FVector2D A, FVector2D B, double GroundA, double GroundB, double RoofZ, FLinearColor Colour, FTriangle Emit) const
{
	const FVector2D Delta = B-A, Across(-Along.Y, Along.X);
	const FVector Out(-Delta.X, Delta.Y, 0);
	if (bMeasuredRoof)
	{
		const double LengthSquared = Delta.SizeSquared();
		if (LengthSquared < 1.e-8) { return; }
		for (const auto& Segment : WallSegments)
		{
			const FVector2D P(Segment.Key.X, Segment.Key.Y), Q(Segment.Value.X, Segment.Value.Y);
			const double From = FVector2D::DotProduct(P-A, Delta)/LengthSquared;
			const double To = FVector2D::DotProduct(Q-A, Delta)/LengthSquared;
			if (From < -1.e-5 || From > 1+1.e-5 || To < -1.e-5 || To > 1+1.e-5
				|| (P-A-Delta*From).Size() > 0.001 || (Q-A-Delta*To).Size() > 0.001) { continue; }
			Quad(World(P, FMath::Lerp(GroundA, GroundB, From)), World(Q, FMath::Lerp(GroundA, GroundB, To)),
				World(Q, RoofZ+Segment.Value.Z*100), World(P, RoofZ+Segment.Key.Z*100), Out.GetSafeNormal(), Colour, Emit);
		}
		return;
	}
	const double SideA = FVector2D::DotProduct(A-Centre, Across), SideB = FVector2D::DotProduct(B-Centre, Across);
	TArray<double> Cuts{0, 1};
	if (!FMath::IsNearlyEqual(SideA, SideB, 1.e-8))
	{
		for (int32 Row = StandRows > 0 ? 1 : 0; Row < (StandRows > 0 ? StandRows : 1); ++Row)
		{
			const double Boundary = StandRows > 0 ? WidthM*(double(Row)/StandRows-0.5) : 0;
			const double T = (Boundary-SideA)/(SideB-SideA);
			if ((StandRows > 0 || RiseM > 0) && T > 0 && T < 1) { Cuts.Add(T); }
		}
	}
	Cuts.Sort();
	for (int32 I = 1; I < Cuts.Num(); ++I)
	{
		const double From = Cuts[I-1], To = Cuts[I];
		const FVector2D P = A+Delta*From, Q = A+Delta*To;
		const double TopA = RoofZ+RoofOffsetM(StandRows > 0 ? (P+Q)*0.5 : P)*100;
		const double TopB = RoofZ+RoofOffsetM(StandRows > 0 ? (P+Q)*0.5 : Q)*100;
		Quad(World(P, FMath::Lerp(GroundA, GroundB, From)), World(Q, FMath::Lerp(GroundA, GroundB, To)),
			World(Q, TopB), World(P, TopA), Out.GetSafeNormal(), Colour, Emit);
	}
}

void FStyle::AddDetails(const TArray<TArray<FVector2D>>& Rings, double RoofZ, const FVector2D& TracePoint,
	TFunctionRef<double(double, double)> Ground, FTriangle Emit) const
{
	if (!bDetailed) { return; }
	const FLinearColor Trim(0.52f, 0.51f, 0.46f, Plain), DarkMetal(0.095f, 0.105f, 0.11f, Metal);
	const FLinearColor Window(0.028f, 0.046f, 0.060f, Glass), ConcreteColour(0.4f, 0.39f, 0.35f, Concrete);
	const FVector2D Across(-Along.Y, Along.X);
	const FVector U(Along.Y, Along.X, 0), V(Across.Y, Across.X, 0);
	if (StandRows > 0)
	{
		const double Tread = WidthM/StandRows, FirstZ = RoofZ-StandRows*StandStepM*50;
		for (int32 Row = 0; Row < StandRows; ++Row)
		{
			const double Y = -WidthM*0.5+(Row+0.5)*Tread, Top = FirstZ+(Row+1)*StandStepM*100;
			TArray<double> Cuts{-LengthM*0.5};
			for (const double Aisle : StandAisles) { Cuts.Add(Aisle*LengthM); }
			Cuts.Add(LengthM*0.5);
			for (int32 Section = 1; Section < Cuts.Num(); ++Section)
			{
				double SeatLength = FMath::Max(0.0, Cuts[Section]-Cuts[Section-1]-1.2);
				const FVector2D At = Centre + Along*((Cuts[Section]+Cuts[Section-1])*0.5) + Across*Y;
				while (SeatLength > 1 && !Fits(At, Along, Across, SeatLength*0.5, 0.2, Rings)) { SeatLength -= 0.25; }
				if (SeatLength > 1 && Fits(At, Along, Across, SeatLength*0.5, 0.2, Rings))
				{
					Box(World(At, Top+43), U, V, FVector(SeatLength*100, 32, 5), FLinearColor(0.49f, 0.51f, 0.52f, Metal), Emit);
					const int32 Supports = FMath::Max(2, FMath::CeilToInt(SeatLength/2.4));
					for (int32 Support = 0; Support < Supports; ++Support)
					{
						const FVector2D Leg = At+Along*(SeatLength*((Support+0.5)/Supports-0.5));
						Box(World(Leg, Top+21), U, V, FVector(6, 6, 40), FLinearColor(0.28f, 0.29f, 0.30f, Metal), Emit);
					}
				}
			}
		}
		const double BackZ = FirstZ+StandRows*StandStepM*100;
		for (double X = -LengthM*0.5; X <= LengthM*0.5; X += 3)
		{
			const FVector2D At = Centre + Along*X + Across*(WidthM*0.5-0.15);
			if (Fits(At, Along, Across, 0.03, 0.03, Rings)) { Box(World(At, BackZ+50), U, V, FVector(5, 5, 100), DarkMetal, Emit); }
			const FVector2D Rail = At+Along*1.5;
			if (Fits(Rail, Along, Across, 1.5, 0.03, Rings)) { Box(World(Rail, BackZ+100), U, V, FVector(300, 5, 5), DarkMetal, Emit); }
		}
		// The larger stand carries a modest press box; its footprint and fittings are architectural priors.
		if (bPressBoxPrior && LengthM*WidthM > 1000)
		{
			const FVector2D At = Centre+Across*(WidthM*0.5-1.6);
			if (Fits(At, Along, Across, 5.2, 1.55, Rings))
			{
				Box(World(At, BackZ+130), U, V, FVector(1000, 280, 260), ConcreteColour, Emit);
				Box(World(At-Across*1.42, BackZ+150), U, V, FVector(900, 5, 95), Window, Emit);
				Box(World(At, BackZ+268), U, V, FVector(1040, 310, 16), DarkMetal, Emit);
				for (int32 I = -4; I <= 4; ++I) { Box(World(At+Along*I-Across*1.46, BackZ+150), U, V, FVector(4, 6, 100), Trim, Emit); }
			}
		}
		return;
	}

	if (Role == TEXT("grandstand")) { return; }
	int32 EntranceEdge = 0;
	double Longest = 0;
	for (int32 I = 0; I < Rings[0].Num(); ++I)
	{
		const double L = (Rings[0][(I+1)%Rings[0].Num()]-Rings[0][I]).Size();
		if (L > Longest) { Longest = L; EntranceEdge = I; }
	}
	for (int32 RingIndex = 0; RingIndex < Rings.Num(); ++RingIndex)
	{
		const auto& Ring = Rings[RingIndex];
		for (int32 Edge = 0; Edge < Ring.Num(); ++Edge)
		{
			const FVector2D A = Ring[Edge], B = Ring[(Edge+1)%Ring.Num()], Delta = B-A;
			const double Length = Delta.Size();
			if (Length < 0.01) { continue; }
			const FVector2D Direction = Delta/Length;
			const FVector Tangent(Direction.Y, Direction.X, 0), Out(-Direction.X, Direction.Y, 0);
			const FVector2D Middle = (A+B)*0.5;
			const double Eave = RoofZ+RoofOffsetM(Middle)*100;
			const auto EdgeTop = WallOffsetM(Middle, Direction, Length*0.5);
			const bool bLevelEdge = EdgeTop.IsSet() && FMath::Abs(RoofOffsetM(Middle)-EdgeTop.GetValue()) < 0.02
				&& FMath::Abs(RoofOffsetM(A)-RoofOffsetM(B)) < 0.02;
			if (bLevelEdge)
			{
				Box(World(Middle, Eave-12)+Out*4, Tangent, Out, FVector(Length*100, 18, 20), Trim, Emit);
			}
			if (ParapetM > 0 && bLevelEdge)
			{
				Box(World(Middle, Eave+ParapetM*50)-Out*11, Tangent, Out, FVector(Length*100, 22, ParapetM*100), Wall, Emit);
				Box(World(Middle, Eave+ParapetM*100+3)-Out*11, Tangent, Out, FVector(Length*100+10, 30, 6), DarkMetal, Emit);
			}
			const auto EntranceTop = WallOffsetM(Middle, Direction, 1.1);
			const bool bEntrance = RingIndex == 0 && Edge == EntranceEdge && Length > 3
				&& EntranceTop.IsSet() && RoofZ+EntranceTop.GetValue()*100-Ground(Middle.X, Middle.Y) > 260;
			const double DoorGround = Ground(Middle.X, Middle.Y);
			if (bEntrance)
			{
				Box(World(Middle, DoorGround+110)+Out*7, Tangent, Out, FVector(150, 15, 220), DarkMetal, Emit);
				Box(World(Middle, DoorGround+150)+Out*16, Tangent, Out, FVector(125, 5, 115), Window, Emit);
				Box(World(Middle, DoorGround+110)+Out*20, Tangent, Out, FVector(5, 5, 220), Trim, Emit);
				Box(World(Middle, DoorGround+245)+Out*65, Tangent, Out, FVector(220, 140, 14), DarkMetal, Emit);
				double StepBottom = DoorGround-15;
				const FVector2D OutEN(Direction.Y, -Direction.X);
				for (const double X : {-1.2, 1.2})
				{
					for (const double Y : {-0.05, 1.55})
					{
						const FVector2D P = Middle+Direction*X+OutEN*Y;
						StepBottom = FMath::Min(StepBottom, Ground(P.X, P.Y)-15);
					}
				}
				Box(World(Middle, (DoorGround+16+StepBottom)*0.5)+Out*75, Tangent, Out, FVector(240, 160, DoorGround+16-StepBottom), ConcreteColour, Emit);
			}
			if (Role == TEXT("utility")) { continue; }
			const double Spacing = Role == TEXT("residential") ? 3.2 : 3.6;
			const int32 Bays = FMath::FloorToInt(Length/Spacing);
			for (int32 Bay = 0; Bay < Bays; ++Bay)
			{
				const double Distance = Length*(Bay+0.5)/Bays;
				const FVector2D Point = A+Direction*Distance;
				const auto WallTop = WallOffsetM(Point, Direction, 0.78);
				if (!WallTop.IsSet()) { continue; }
				const double Base = Ground(Point.X, Point.Y), Top = RoofZ+WallTop.GetValue()*100;
				const int32 Floors = FMath::Clamp(FMath::FloorToInt((Top-Base)/300), 1, 5);
				for (int32 Floor = 0; Floor < Floors; ++Floor)
				{
					if (Floor == 0 && bEntrance && FMath::Abs(Distance-Length*0.5) < 2.1) { continue; }
					const double FloorBase = Base+Floor*300;
					const double Scale = FMath::Min(1.0, (Top-FloorBase-95)/171);
					if (Scale < 0.65) { continue; }
					const double Z = FMath::Min(FloorBase+175, Top-35-85.5*Scale);
					const FVector At = World(Point, Z)+Out*7;
					for (const double Side : {-1.0, 1.0})
					{
						Box(At+Tangent*(Side*68.25), Tangent, Out, FVector(8.5, 14, 155*Scale), Trim, Emit);
						Box(At+FVector(0, 0, Side*73*Scale), Tangent, Out, FVector(128, 14, 9*Scale), Trim, Emit);
					}
					Box(At+Out*3, Tangent, Out, FVector(128, 5, 137*Scale), Window, Emit);
					Box(At+Out*6, Tangent, Out, FVector(4, 5, 140*Scale), DarkMetal, Emit);
					Box(At-FVector(0, 0, 81*Scale)+Out*10, Tangent, Out, FVector(156, 30, 9*Scale), Trim, Emit);
				}
			}
		}
	}
	if (RiseM > 0)
	{
		Box(World(Centre, RoofZ+RiseM*50+1), U, V, FVector(LengthM*100, 18, 2), DarkMetal, Emit);
	}
	if (RiseM == 0 && (Role == TEXT("institution") || Role == TEXT("commercial")) && LengthM*WidthM > 180)
	{
		if (!RoofForms.IsEmpty())
		{
			const FVector East = FVector::RightVector, North = FVector::ForwardVector;
			for (const FRoofForm& Form : RoofForms)
			{
				if (!Fits(Form.At, FVector2D(1,0), FVector2D(0,1), Form.WidthM*0.5, Form.DepthM*0.5, Rings)) { continue; }
				const double Width = FMath::Max(0.4, Form.WidthM-(Form.bObservedPlan ? 0.16 : 2*FMath::Min(1.25, Form.WidthM*0.4)));
				const double Depth = FMath::Max(0.4, Form.DepthM-(Form.bObservedPlan ? 0.16 : 2*FMath::Min(1.25, Form.DepthM*0.4)));
				const double FormZ = RoofZ+RoofOffsetM(Form.At)*100;
				Box(World(Form.At, FormZ+6), East, North, FVector(Width*100+16, Depth*100+16, 12), DarkMetal, Emit);
				Box(World(Form.At, FormZ+12+(Form.HeightM*100-12)*0.5), East, North,
					FVector(Width*100, Depth*100, Form.HeightM*100-12), Form.bSkylight ? Window : FLinearColor(0.38f,0.40f,0.40f,Metal), Emit);
				if (Form.bSkylight) { continue; }
				for (int32 Slat = 0; Slat < 6; ++Slat)
				{
					const FVector2D At = Form.At+FVector2D(Width*(Slat-2.5)/8,0);
					Box(World(At, FormZ+Form.HeightM*100+1), East, North, FVector(Width*7, Depth*65, 2), DarkMetal, Emit);
				}
			}
			return;
		}
		if (bMeasuredRoof) { return; }
		const int32 Units = FMath::Clamp(FMath::FloorToInt(LengthM*WidthM/700), 1, 8);
		for (int32 I = 0; I < Units; ++I)
		{
			const FVector2D Point = Centre+Along*((double(I+1)/(Units+1)-0.5)*LengthM*0.7)+Across*(WidthM*0.23);
			if ((Point-TracePoint).Size() < 3) { continue; }
			if (!Fits(Point, Along, Across, 1.3, 1.0, Rings)) { continue; }
			Box(World(Point, RoofZ+14), U, V, FVector(240, 180, 28), DarkMetal, Emit);
			Box(World(Point, RoofZ+72), U, V, FVector(210, 150, 88), FLinearColor(0.42f, 0.44f, 0.43f, Metal), Emit);
			for (int32 Slat = 0; Slat < 6; ++Slat) { Box(World(Point+Along*(Slat*0.23-0.575), RoofZ+118), U, V, FVector(12, 100, 4), DarkMetal, Emit); }
		}
	}
}

UMaterial* MakeMaterial(const FString& GeneratedPath, float Roughness, TArray<UPackage*>& Packages)
{
	UPackage* Package = CreatePackage(*(GeneratedPath/TEXT("M_Building")));
	UMaterial* Material = NewObject<UMaterial>(Package, TEXT("M_Building"), RF_Public|RF_Standalone);
	FAssetRegistryModule::AssetCreated(Material); Package->MarkPackageDirty(); Packages.Add(Package);
	auto Uv = [&](int32 Index)
	{
		auto* Node = NewObject<UMaterialExpressionTextureCoordinate>(Material);
		Node->CoordinateIndex = Index; Material->GetExpressionCollection().AddExpression(Node); return Node;
	};
	auto* ColourRG = Uv(2); auto* ColourBFinish = Uv(3); auto* Metres = Uv(0);
	auto Custom = [&](EMaterialProperty Property, ECustomMaterialOutputType Type, const FString& Code)
	{
		auto* Node = NewObject<UMaterialExpressionCustom>(Material);
		Node->OutputType = Type; Node->Code = Code;
		Node->Inputs.Reset();
		for (const auto& Entry : TArray<TPair<FName, UMaterialExpression*>>{{TEXT("ColourRG"), ColourRG}, {TEXT("ColourBFinish"), ColourBFinish}, {TEXT("Metres"), Metres}})
		{
			FCustomInput Input; Input.InputName = Entry.Key; Input.Input.Connect(0, Entry.Value); Node->Inputs.Add(Input);
		}
		Material->GetExpressionCollection().AddExpression(Node);
		UMaterialEditingLibrary::ConnectMaterialProperty(Node, TEXT(""), Property);
	};
	Custom(MP_BaseColor, CMOT_Float3, TEXT(R"(
float3 colour = float3(ColourRG.xy, ColourBFinish.x);
int kind = (int)round(ColourBFinish.y);
float2 uv = Metres.xy;
float2 aa = max(fwidth(uv), 0.0005);
float shade = 1;
if (kind == 1) {
    float row = floor(uv.y / 0.075);
    float2 cell = float2(uv.x / 0.24 + fmod(row, 2) * 0.5, uv.y / 0.075);
    float2 edge = min(frac(cell), 1-frac(cell)) * float2(0.24, 0.075);
    float mortar = 1 - min(smoothstep(0.001, 0.004, edge.x), smoothstep(0.001, 0.003, edge.y));
    float variation = frac(sin(dot(floor(cell), float2(127.1,311.7)))*43758.5453);
    float fade = 1-smoothstep(0.02, 0.075, max(aa.x,aa.y));
    colour = lerp(colour, lerp(colour*(0.85+variation*0.3), float3(0.32,0.30,0.26), mortar*0.55), fade);
} else if (kind == 2) {
    shade = 1+0.07*cos(6.2831853*uv.y/0.18)*(1-smoothstep(0.04,0.18,aa.y));
} else if (kind == 4) {
    shade = 1+0.07*cos(6.2831853*uv.y/0.16)*(1-smoothstep(0.04,0.16,aa.y));
} else if (kind == 5) {
    shade = 1+0.025*(cos(3.1415927*uv.x)+cos(3.1415927*uv.y))*(1-smoothstep(0.5,2,max(aa.x,aa.y)));
}
return colour*shade;
)"));
	Custom(MP_Roughness, CMOT_Float1, FString::Printf(TEXT("int k=(int)round(ColourBFinish.y); return k==7 ? 0.18 : k==6 ? 0.4 : %.4f;"), Roughness));
	Custom(MP_Metallic, CMOT_Float1, TEXT("return round(ColourBFinish.y)==6 ? 0.65 : 0.0;"));
	UMaterialEditingLibrary::RecompileMaterial(Material);
	return Material;
}

void AppendCollisionTriangle(FMeshDescription& Description, FVector A, FVector B, FVector C, const FVector& Normal)
{
	FStaticMeshAttributes Attributes(Description);
	auto Positions = Attributes.GetVertexPositions();
	auto Normals = Attributes.GetVertexInstanceNormals();
	auto Uvs = Attributes.GetVertexInstanceUVs();
	FVertexInstanceID Corners[3];
	const FVector Points[3] = {A, B, C};
	for (int32 I = 0; I < 3; ++I)
	{
		const FVertexID Vertex = Description.CreateVertex(); Positions[Vertex] = FVector3f(Points[I]);
		Corners[I] = Description.CreateVertexInstance(Vertex); Normals[Corners[I]] = FVector3f(Normal);
		Uvs.Set(Corners[I], 0, FVector2f(I == 1 ? 1 : 0, I == 2 ? 1 : 0));
	}
	Description.CreatePolygon(FPolygonGroupID(0), {Corners[0], Corners[1], Corners[2]});
}

void AttachCollision(AStaticMeshActor* Actor, const FMeshDescription& Description, const FString& GeneratedPath, const FString& Name, TArray<UPackage*>& Packages)
{
	UPackage* Package = CreatePackage(*(GeneratedPath/Name));
	UStaticMesh* Mesh = NewObject<UStaticMesh>(Package, *Name, RF_Public|RF_Standalone);
	FAssetRegistryModule::AssetCreated(Mesh); Package->MarkPackageDirty(); Packages.Add(Package);
	Mesh->GetStaticMaterials().Add(FStaticMaterial());
	Mesh->SetNumSourceModels(1);
	Mesh->GetSourceModel(0).BuildSettings.DistanceFieldResolutionScale = 0;
	UStaticMesh::FBuildMeshDescriptionsParams Params;
	Params.bFastBuild = false; Params.bBuildSimpleCollision = false;
	Mesh->BuildFromMeshDescriptions({&Description}, Params);
	FStaticMeshCompilingManager::Get().FinishCompilation({Mesh});
	Mesh->CreateBodySetup();
	Mesh->GetBodySetup()->CollisionTraceFlag = CTF_UseComplexAsSimple;
	Mesh->GetBodySetup()->InvalidatePhysicsData(); Mesh->GetBodySetup()->CreatePhysicsMeshes();
	UStaticMeshComponent* Component = NewObject<UStaticMeshComponent>(Actor);
	Actor->AddInstanceComponent(Component); Component->SetupAttachment(Actor->GetRootComponent());
	Component->SetMobility(EComponentMobility::Static); Component->SetStaticMesh(Mesh);
	Component->SetVisibility(false); Component->SetHiddenInGame(true); Component->SetCastShadow(false);
	Component->SetCollisionProfileName(TEXT("BlockAll")); Component->RegisterComponent();
}
}
