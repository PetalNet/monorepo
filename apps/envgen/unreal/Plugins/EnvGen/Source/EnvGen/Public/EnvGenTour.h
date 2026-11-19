#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EnvGenTour.generated.h"

class UCameraComponent;

/**
 * A scripted camera run over the terrain that measures frame times.
 *
 * It follows a closed loop around the tile centre at a fixed height above the ground, sized from the
 * tile, waits for a warm-up period, records every frame for the measured period, writes a summary and
 * the raw frame times under Saved/EnvGen, then exits the game unless asked to stay.
 */
UCLASS()
class ENVGEN_API AEnvGenTour : public AActor
{
	GENERATED_BODY()

public:
	AEnvGenTour();
	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	/** Sets the path from a tour name: "walk", "fly" or "overview". Returns false for an unknown name. */
	bool Configure(const FString& TourName);

	UPROPERTY(VisibleAnywhere, Category = "Camera")
	TObjectPtr<UCameraComponent> Camera;

	UPROPERTY(EditAnywhere, Category = "Tour")
	FString Name = TEXT("walk");

	UPROPERTY(EditAnywhere, Category = "Tour")
	float HeightAboveGroundCm = 170;

	/** Nominal pace. The loop's radial wobble makes the true ground speed vary around it. */
	UPROPERTY(EditAnywhere, Category = "Tour")
	float SpeedCmPerSec = 400;

	/** The loop is an ellipse with a slow radial wobble, so the view crosses different ground. Fractions of the tile side. */
	UPROPERTY(EditAnywhere, Category = "Tour")
	FVector2D RadiiOfTile = FVector2D(0.09, 0.14);

	UPROPERTY(EditAnywhere, Category = "Tour")
	float PitchDeg = 0;

	UPROPERTY(EditAnywhere, Category = "Tour")
	float WarmUpSeconds = 8;

	UPROPERTY(EditAnywhere, Category = "Tour")
	float MeasuredSeconds = 60;

	UPROPERTY(EditAnywhere, Category = "Tour")
	bool bExitWhenDone = true;

	/** Also record the engine's CSV profile for the measured period. It draws a frame counter on screen. */
	UPROPERTY(EditAnywhere, Category = "Tour")
	bool bCsvProfile = false;

	/**
	 * When set, every measured frame is also written here as a PNG, for making a video. Run with
	 * -UseFixedTimeStep -FPS=30 so the frames are evenly spaced. Frame times from such a run mean nothing.
	 */
	UPROPERTY(EditAnywhere, Category = "Tour")
	FString FrameDirectory;

private:
	FVector PointAt(float Angle) const;
	void Finish();

	double TileSizeCm = 100800;
	float Elapsed = 0;
	float Parameter = 0;
	double PathLengthCm = 0;
	int32 GroundMisses = 0;
	bool bRecording = false;
	bool bFinished = false;
	TArray<float> FrameMs;
	TArray<float> GpuMs;
	TArray<float> GameThreadMs;
	TArray<float> RenderThreadMs;
};
