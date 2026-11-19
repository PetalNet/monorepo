#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "EnvGenWalker.generated.h"

class UCameraComponent;

/**
 * A person on foot: WASD or left stick to move, mouse or right stick to look, Shift to run, Space to jump.
 * F swaps to the pawn named by DroneClass, when the project configures one.
 */
UCLASS(Config = Game)
class ENVGEN_API AEnvGenWalker : public ACharacter
{
	GENERATED_BODY()

public:
	AEnvGenWalker();
	virtual void Tick(float DeltaSeconds) override;

	UPROPERTY(VisibleAnywhere, Category = "Camera")
	TObjectPtr<UCameraComponent> Camera;

	UPROPERTY(EditAnywhere, Category = "Movement")
	float WalkSpeedCmPerSec = 160;

	UPROPERTY(EditAnywhere, Category = "Movement")
	float RunSpeedCmPerSec = 550;

	/** A flying pawn from another plugin, set in DefaultGame.ini. Empty means walking only. */
	UPROPERTY(Config, EditAnywhere, Category = "Drone")
	FSoftClassPath DroneClass;
};
