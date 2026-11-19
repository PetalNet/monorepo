#include "EnvGenGameMode.h"

#include "Engine/World.h"
#include "EnvGenTour.h"
#include "EnvGenWalker.h"
#include "GameFramework/PlayerController.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

AEnvGenGameMode::AEnvGenGameMode()
{
	DefaultPawnClass = AEnvGenWalker::StaticClass();
}

void AEnvGenGameMode::StartPlay()
{
	Super::StartPlay();

	FString TourName;
	if (!FParse::Value(FCommandLine::Get(), TEXT("EnvGenTour="), TourName))
	{
		return;
	}
	AEnvGenTour* Tour = GetWorld()->SpawnActor<AEnvGenTour>();
	if (!Tour->Configure(TourName))
	{
		UE_LOG(LogTemp, Error, TEXT("EnvGen: unknown tour '%s'; expected walk, fly or overview"), *TourName);
		Tour->Destroy();
		return;
	}
	FParse::Value(FCommandLine::Get(), TEXT("EnvGenTourSeconds="), Tour->MeasuredSeconds);
	Tour->bExitWhenDone = !FParse::Param(FCommandLine::Get(), TEXT("EnvGenTourStay"));
	Tour->bCsvProfile = FParse::Param(FCommandLine::Get(), TEXT("EnvGenTourCsv"));
	FParse::Value(FCommandLine::Get(), TEXT("EnvGenTourFrames="), Tour->FrameDirectory);
	if (APlayerController* Player = GetWorld()->GetFirstPlayerController())
	{
		Player->SetViewTarget(Tour);
		if (APawn* Pawn = Player->GetPawn())
		{
			Pawn->SetActorHiddenInGame(true);
			Pawn->SetActorTickEnabled(false);
		}
	}
}
