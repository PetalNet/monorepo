#include "EnvGenWalker.h"

#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "Engine/World.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/PlayerController.h"
#include "InputCoreTypes.h"

namespace
{
	constexpr float EyeHeightCm = 170;
	constexpr float CapsuleHalfHeightCm = 90;
	constexpr float MouseDegPerCount = 0.12f;
	constexpr float StickDegPerSec = 140;
}

AEnvGenWalker::AEnvGenWalker()
{
	PrimaryActorTick.bCanEverTick = true;
	GetCapsuleComponent()->InitCapsuleSize(35, CapsuleHalfHeightCm);
	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(GetCapsuleComponent());
	Camera->SetRelativeLocation(FVector(0, 0, EyeHeightCm - CapsuleHalfHeightCm));
	Camera->bUsePawnControlRotation = true;
	bUseControllerRotationYaw = true;
	GetCharacterMovement()->MaxStepHeight = 45;
	GetCharacterMovement()->SetWalkableFloorAngle(50);
}

void AEnvGenWalker::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	APlayerController* Player = Cast<APlayerController>(GetController());
	if (!Player)
	{
		return;
	}

	const auto Axis = [Player](const FKey& Positive, const FKey& Negative, const FKey& Stick)
	{
		const float Keys = (Player->IsInputKeyDown(Positive) ? 1.f : 0.f) - (Player->IsInputKeyDown(Negative) ? 1.f : 0.f);
		return FMath::Clamp(Keys + Player->GetInputAnalogKeyState(Stick), -1.f, 1.f);
	};

	float MouseX = 0, MouseY = 0;
	Player->GetInputMouseDelta(MouseX, MouseY);
	AddControllerYawInput(MouseX * MouseDegPerCount + Player->GetInputAnalogKeyState(EKeys::Gamepad_RightX) * StickDegPerSec * DeltaSeconds);
	// Mouse Y is positive when pushed forward; negated so that looks up under the default pitch scale.
	AddControllerPitchInput(-MouseY * MouseDegPerCount + Player->GetInputAnalogKeyState(EKeys::Gamepad_RightY) * StickDegPerSec * DeltaSeconds);

	const bool bRun = Player->IsInputKeyDown(EKeys::LeftShift) || Player->IsInputKeyDown(EKeys::Gamepad_LeftThumbstick);
	GetCharacterMovement()->MaxWalkSpeed = bRun ? RunSpeedCmPerSec : WalkSpeedCmPerSec;
	const FRotator Heading(0, GetControlRotation().Yaw, 0);
	AddMovementInput(Heading.Vector(), Axis(EKeys::W, EKeys::S, EKeys::Gamepad_LeftY));
	AddMovementInput(FRotationMatrix(Heading).GetUnitAxis(EAxis::Y), Axis(EKeys::D, EKeys::A, EKeys::Gamepad_LeftX));
	if (Player->WasInputKeyJustPressed(EKeys::SpaceBar) || Player->WasInputKeyJustPressed(EKeys::Gamepad_FaceButton_Bottom))
	{
		Jump();
	}

	if (Player->WasInputKeyJustPressed(EKeys::F))
	{
		if (UClass* Drone = DroneClass.TryLoadClass<APawn>())
		{
			FActorSpawnParameters Spawn;
			Spawn.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
			const FVector Above = GetActorLocation() + FVector(0, 0, 300);
			if (APawn* Spawned = GetWorld()->SpawnActor<APawn>(Drone, Above, Heading, Spawn))
			{
				Player->Possess(Spawned);
				Destroy();
			}
		}
		else
		{
			UE_LOG(LogTemp, Warning, TEXT("EnvGen: no drone class at '%s'; staying on foot"), *DroneClass.ToString());
		}
	}
}
