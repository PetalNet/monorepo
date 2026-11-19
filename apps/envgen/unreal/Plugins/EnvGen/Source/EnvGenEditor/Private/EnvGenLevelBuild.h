#pragma once

#include "CoreMinimal.h"

/**
 * Regenerates a level from an envgen build manifest, from scratch, inside a running editor.
 *
 * Start() deletes what an earlier run generated, creates the assets and the level, and imports the
 * Landscape. The engine then merges the Landscape's edit layers on the GPU over the following frames,
 * so the caller polls Finish() once per frame until it returns true. Finish() checks the collision
 * surface against the imported heights, saves, and writes Saved/EnvGen/build_receipt.json.
 */
class FEnvGenLevelBuild
{
public:
	/** Returns false, with a logged reason, when the manifest or its files cannot be used. */
	bool Start(const FString& ManifestPath, const FString& MapPath, const FString& MaterialsDirectory);

	/** Returns true when the build has ended; bSucceeded then says how. */
	bool Finish(float DeltaSeconds, bool& bSucceeded);

private:
	struct FState;
	TSharedPtr<FState> State;
};
