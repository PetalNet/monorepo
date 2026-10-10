import { Schema } from "effect";

import { ProjectCreate, ProjectPlan, ReviewSubmit, TaskComplete } from "./schema";

const CreateProject = ProjectCreate;

const PlanTask = Schema.Struct({
	commandId: ProjectPlan.fields.commandId,
	projectId: ProjectPlan.fields.projectId,
	expectedVersionId: ProjectPlan.fields.expectedVersionId,
	title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	objective: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
});

const ReviewOutput = Schema.Struct({
	...ReviewSubmit.fields,
	projectId: Schema.String,
	comments: Schema.Trim.check(Schema.isMaxLength(4_000)),
});

const CompleteTask = Schema.Struct({
	...TaskComplete.fields,
	projectId: Schema.String,
});

export const OpenProjectValidator = Schema.toStandardSchemaV1(
	Schema.Struct({
		projectId: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
		view: Schema.Literals(["work", "library"]),
	}),
);
export const FindArtifactsValidator = Schema.toStandardSchemaV1(
	Schema.Struct({
		projectId: Schema.String,
		query: Schema.Trim.check(Schema.isMaxLength(256)),
	}),
);

export const CreateProjectValidator = Schema.toStandardSchemaV1(CreateProject);
export const PlanTaskValidator = Schema.toStandardSchemaV1(PlanTask);
export const ReviewOutputValidator = Schema.toStandardSchemaV1(ReviewOutput);
export const CompleteTaskValidator = Schema.toStandardSchemaV1(CompleteTask);
