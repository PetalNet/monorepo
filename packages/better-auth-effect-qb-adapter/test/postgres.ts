import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

let container: StartedPostgreSqlContainer | undefined;

export const startPostgres = async () => {
	container = await new PostgreSqlContainer("postgres:17-alpine").start();
	return container.getConnectionUri();
};

export const stopPostgres = async (): Promise<void> => {
	await container?.stop();
};
