import { PostgreSqlContainer } from "@testcontainers/postgresql";
let container;
export const startPostgres = async () => {
	container = await new PostgreSqlContainer("postgres:17-alpine").start();
	return container.getConnectionUri();
};
export const stopPostgres = async () => {
	await container?.stop();
};
