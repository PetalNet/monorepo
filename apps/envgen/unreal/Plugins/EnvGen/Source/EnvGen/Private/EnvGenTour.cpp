#include "EnvGenTour.h"

#include "Camera/CameraComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "EnvGenSiteInfo.h"
#include "HAL/PlatformTime.h"
#include "Kismet/KismetSystemLibrary.h"
#include "Misc/App.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "DynamicRHI.h"
#include "RenderTimer.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UnrealClient.h"

namespace
{
	constexpr float TraceTopCm = 200000;
	constexpr float LookAheadCm = 600;

	/** The ground under a point: the first thing a trace from above meets that does not stand on the ground itself. */
	bool GroundHeight(const UWorld* World, const FVector& At, float& OutZ)
	{
		const FVector Top(At.X, At.Y, TraceTopCm);
		const FVector Bottom(At.X, At.Y, -TraceTopCm);
		FCollisionQueryParams Params;
		FHitResult Hit;
		while (World->LineTraceSingleByChannel(Hit, Top, Bottom, ECC_WorldStatic, Params))
		{
			const AActor* Met = Hit.GetActor();
			if (!Met || !Met->ActorHasTag(EnvGenStandingTag()))
			{
				OutZ = Hit.Location.Z;
				return true;
			}
			Params.AddIgnoredActor(Met);
		}
		return false;
	}

	/** Nearest-rank percentile of sorted values: the smallest value with at least Fraction of them at or below it. */
	double Percentile(const TArray<float>& Sorted, double Fraction)
	{
		return Sorted.IsEmpty() ? 0.0 : Sorted[FMath::Clamp(FMath::CeilToInt32(Fraction * Sorted.Num()) - 1, 0, Sorted.Num() - 1)];
	}

	double Median(const TArray<float>& Sorted)
	{
		if (Sorted.IsEmpty())
		{
			return 0.0;
		}
		const int32 Upper = Sorted.Num() / 2;
		return Sorted.Num() % 2 ? Sorted[Upper] : (double(Sorted[Upper - 1]) + Sorted[Upper]) / 2;
	}

	TSharedRef<FJsonObject> Summarise(TArray<float> Values)
	{
		Values.Sort();
		double Sum = 0;
		for (const float Value : Values)
		{
			Sum += Value;
		}
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetNumberField(TEXT("mean"), Values.IsEmpty() ? 0 : Sum / Values.Num());
		Out->SetNumberField(TEXT("median"), Median(Values));
		Out->SetNumberField(TEXT("p95"), Percentile(Values, 0.95));
		Out->SetNumberField(TEXT("p99"), Percentile(Values, 0.99));
		Out->SetNumberField(TEXT("max"), Values.IsEmpty() ? 0 : Values.Last());
		return Out;
	}
}

AEnvGenTour::AEnvGenTour()
{
	PrimaryActorTick.bCanEverTick = true;
	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	RootComponent = Camera;
}

bool AEnvGenTour::Configure(const FString& TourName)
{
	Name = TourName;
	if (TourName == TEXT("walk"))
	{
		HeightAboveGroundCm = 170;
		SpeedCmPerSec = 400;
		RadiiOfTile = FVector2D(0.09, 0.14);
		PitchDeg = 0;
		return true;
	}
	if (TourName == TEXT("stand"))
	{
		// The walk's first point, held still: for checking that what streams in around a camera stays.
		HeightAboveGroundCm = 170;
		SpeedCmPerSec = 0;
		RadiiOfTile = FVector2D(0.09, 0.0);
		PitchDeg = 0;
		return true;
	}
	if (TourName == TEXT("fly"))
	{
		HeightAboveGroundCm = 3000;
		SpeedCmPerSec = 1500;
		RadiiOfTile = FVector2D(0.22, 0.30);
		PitchDeg = -15;
		return true;
	}
	if (TourName == TEXT("overview"))
	{
		// Straight down from high above the centre, north up and east right: for comparing with a map.
		HeightAboveGroundCm = 70000;
		SpeedCmPerSec = 0;
		RadiiOfTile = FVector2D::ZeroVector;
		PitchDeg = -90;
		return true;
	}
	return false;
}

FVector AEnvGenTour::PointAt(float Angle) const
{
	const float Wobble = 1 + 0.25f * FMath::Sin(Angle * 3);
	return FVector(RadiiOfTile.X * TileSizeCm * Wobble * FMath::Cos(Angle), RadiiOfTile.Y * TileSizeCm * Wobble * FMath::Sin(Angle), 0);
}

void AEnvGenTour::BeginPlay()
{
	Super::BeginPlay();
	if (const AEnvGenSiteInfo* Site = AEnvGenSiteInfo::Find(GetWorld()))
	{
		TileSizeCm = Site->TileSizeCm;
	}
	FrameMs.Reserve(FMath::CeilToInt32(MeasuredSeconds * 240));
}

void AEnvGenTour::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (bFinished)
	{
		return;
	}

	// Advance by angle; the mean radius turns the nominal speed into an angular rate.
	const double MeanRadiusCm = (RadiiOfTile.X + RadiiOfTile.Y) / 2 * TileSizeCm;
	const float Step = MeanRadiusCm > 0 ? SpeedCmPerSec * DeltaSeconds / MeanRadiusCm : 0.f;
	const float AheadStep = MeanRadiusCm > 0 ? LookAheadCm / MeanRadiusCm : 0.f;
	Parameter += Step;
	FVector Here = PointAt(Parameter);
	FVector Ahead = PointAt(Parameter + AheadStep);
	float Ground = 0;
	if (!GroundHeight(GetWorld(), Here, Ground) && GroundMisses++ == 0)
	{
		UE_LOG(LogTemp, Warning, TEXT("EnvGen: tour '%s' is over a point with no ground; holding height from Z = 0"), *Name);
	}
	Here.Z = Ground + HeightAboveGroundCm;
	float GroundAhead = Ground;
	GroundHeight(GetWorld(), Ahead, GroundAhead);
	Ahead.Z = GroundAhead + HeightAboveGroundCm;
	FRotator Look = Step > 0 ? (Ahead - Here).Rotation() : FRotator::ZeroRotator;
	Look.Pitch = PitchDeg;
	if (Elapsed > 0)
	{
		PathLengthCm += FVector::Dist(GetActorLocation(), Here);
	}
	SetActorLocationAndRotation(Here, Step > 0 ? FMath::RInterpTo(GetActorRotation(), Look, DeltaSeconds, 4) : Look);

	Elapsed += DeltaSeconds;
	if (!bRecording && Elapsed >= WarmUpSeconds)
	{
		bRecording = true;
		PathLengthCm = 0;
		if (bCsvProfile)
		{
			UKismetSystemLibrary::ExecuteConsoleCommand(this, TEXT("csvprofile start"));
		}
		return;
	}
	if (bRecording)
	{
		if (!FrameDirectory.IsEmpty() && FrameMs.Num() % FMath::Max(FrameEvery, 1) == 0)
		{
			FScreenshotRequest::RequestScreenshot(FrameDirectory / FString::Printf(TEXT("frame_%05d.png"), FrameMs.Num()), false, false);
		}
		FrameMs.Add(FApp::GetDeltaTime() * 1000);
		GpuMs.Add(FPlatformTime::ToMilliseconds(RHIGetGPUFrameCycles()));
		GameThreadMs.Add(FPlatformTime::ToMilliseconds(GGameThreadTime));
		RenderThreadMs.Add(FPlatformTime::ToMilliseconds(GRenderThreadTime));
		if (Elapsed >= WarmUpSeconds + MeasuredSeconds)
		{
			Finish();
		}
	}
}

void AEnvGenTour::Finish()
{
	bFinished = true;
	if (bCsvProfile)
	{
		UKismetSystemLibrary::ExecuteConsoleCommand(this, TEXT("csvprofile stop"));
	}

	FVector2D Viewport(0, 0);
	if (GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->GetViewportSize(Viewport);
	}
	int32 Over33 = 0, Over16 = 0;
	for (const float Ms : FrameMs)
	{
		Over33 += Ms > 33.33f;
		Over16 += Ms > 16.67f;
	}

	TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("tour"), Name);
	Out->SetNumberField(TEXT("viewport_width"), Viewport.X);
	Out->SetNumberField(TEXT("viewport_height"), Viewport.Y);
	Out->SetNumberField(TEXT("frames"), FrameMs.Num());
	Out->SetBoolField(TEXT("frames_written_to_disk"), !FrameDirectory.IsEmpty());
	Out->SetNumberField(TEXT("measured_seconds"), MeasuredSeconds);
	Out->SetNumberField(TEXT("warm_up_seconds"), WarmUpSeconds);
	Out->SetNumberField(TEXT("distance_m"), PathLengthCm / 100);
	Out->SetNumberField(TEXT("frames_with_no_ground_under_the_camera"), GroundMisses);
	Out->SetNumberField(TEXT("height_above_ground_m"), HeightAboveGroundCm / 100);
	Out->SetNumberField(TEXT("frames_over_33ms"), Over33);
	Out->SetNumberField(TEXT("frames_over_16_7ms"), Over16);
	Out->SetObjectField(TEXT("frame_ms"), Summarise(FrameMs));
	Out->SetObjectField(TEXT("gpu_ms"), Summarise(GpuMs));
	Out->SetObjectField(TEXT("game_thread_ms"), Summarise(GameThreadMs));
	Out->SetObjectField(TEXT("render_thread_ms"), Summarise(RenderThreadMs));

	FString Json;
	FJsonSerializer::Serialize(Out, TJsonWriterFactory<>::Create(&Json));
	const FString Stem = FPaths::ProjectSavedDir() / TEXT("EnvGen") / (TEXT("tour_") + Name);
	FFileHelper::SaveStringToFile(Json, *(Stem + TEXT(".json")));

	FString Csv = TEXT("frame_ms,gpu_ms,game_thread_ms,render_thread_ms\n");
	for (int32 Index = 0; Index < FrameMs.Num(); ++Index)
	{
		Csv += FString::Printf(TEXT("%.3f,%.3f,%.3f,%.3f\n"), FrameMs[Index], GpuMs[Index], GameThreadMs[Index], RenderThreadMs[Index]);
	}
	FFileHelper::SaveStringToFile(Csv, *(Stem + TEXT(".csv")));
	UE_LOG(LogTemp, Display, TEXT("EnvGen: tour '%s' wrote %s.json (%d frames)"), *Name, *Stem, FrameMs.Num());

	if (bExitWhenDone)
	{
		FPlatformMisc::RequestExit(false);
	}
}
