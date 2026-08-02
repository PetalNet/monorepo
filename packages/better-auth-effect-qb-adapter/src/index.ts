import { AsyncLocalStorage } from "node:async_hooks";

import * as PgClient from "@effect/sql-pg/PgClient";
import type {
	CleanedWhere,
	CustomAdapter,
	DBTransactionAdapter,
	JoinConfig,
} from "better-auth/adapters";
import { createAdapterFactory } from "better-auth/adapters";
import { Context, Effect, ManagedRuntime, Redacted } from "effect";

const MAX_LIMIT = 1000;
const MAX_OFFSET = 100_000;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

type RuntimeContext = Context.Context<never>;
type DatabaseRow = Record<string, unknown>;
type AdapterFactory = ReturnType<typeof createAdapterFactory> & { close: () => Promise<void> };
interface FindOneArguments {
	model: string;
	where: CleanedWhere[];
	select?: string[] | undefined;
	join?: JoinConfig | undefined;
}
interface FindManyArguments {
	model: string;
	where?: CleanedWhere[] | undefined;
	limit: number;
	select?: string[] | undefined;
	sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
	offset?: number | undefined;
	join?: JoinConfig | undefined;
}
interface IncrementArguments {
	model: string;
	where: CleanedWhere[];
	increment: Record<string, number>;
	set?: DatabaseRow | undefined;
}
interface UpdateArguments<T> {
	model: string;
	where: CleanedWhere[];
	update: T;
}

const quote = (value: string) => {
	if (!identifierPattern.test(value)) throw new Error(`Invalid database identifier: ${value}`);
	return `"${value}"`;
};

const boundedInteger = (value: number, maximum: number, name: string) => {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
		throw new RangeError(`${name} must be between 0 and ${String(maximum)}`);
	return value;
};

const escapeLike = (value: unknown) => String(value).replace(/[\\%_]/g, "\\$&");
const query = <T extends object>(text: string, values: readonly unknown[] = []) =>
	Effect.flatMap(PgClient.PgClient, (sql) => sql.unsafe<T>(text, values));
const databaseRow = (value: unknown): DatabaseRow => {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError("Expected a database row object");
	return value as DatabaseRow;
};
const scalarString = (value: unknown) => {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean")
		return String(value);
	if (value instanceof Date) return value.toISOString();
	throw new TypeError("Expected a scalar database value");
};

export const createEffectQbAdapter = (databaseUrl: string): AdapterFactory => {
	const runtime = ManagedRuntime.make(
		PgClient.layer({ url: Redacted.make(databaseUrl), maxConnections: 10 }),
	);
	const transactionContext = new AsyncLocalStorage<RuntimeContext>();
	let transactionAdapter: DBTransactionAdapter | undefined;
	const run = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>) => {
		const context = transactionContext.getStore();
		return runtime.runPromise(context ? Effect.provide(effect, context) : effect);
	};

	const factory = createAdapterFactory({
		config: {
			adapterId: "effect-qb-postgres",
			supportsJSON: true,
			supportsDates: true,
			supportsBooleans: true,
			supportsNumericIds: false,
			supportsUUIDs: true,
			supportsArrays: true,
			disableIdGeneration: false,
			async transaction(callback) {
				const adapter = transactionAdapter;
				if (!adapter) throw new Error("Adapter transaction used before initialization");
				return run(
					Effect.flatMap(PgClient.PgClient, (sql) =>
						sql.withTransaction(
							Effect.flatMap(Effect.context(), (context) =>
								Effect.promise(() => transactionContext.run(context, () => callback(adapter))),
							),
						),
					),
				);
			},
		},
		adapter: ({ schema, getModelName, getDefaultModelName, getFieldName }) => {
			const fieldsFor = (name: string) => {
				const modelName = getDefaultModelName(name);
				const model = Object.entries(schema).find(([key]) => key === modelName)?.[1];
				if (!model) throw new Error(`Unknown model ${name}`);
				return model.fields;
			};
			const tableName = (name: string) => quote(getModelName(name));
			const fieldName = (name: string, field: string) => {
				const fields = fieldsFor(name);
				if (field === "id") return "id";
				if (field in fields) return getFieldName({ model: name, field });
				if (Object.values(fields).some((attributes) => attributes.fieldName === field))
					return field;
				throw new Error(`Unknown field ${name}.${field}`);
			};
			const fieldIdentifier = (name: string, field: string) => quote(fieldName(name, field));
			const selectedFields = (name: string, select?: string[]) =>
				[...new Set(["id", ...(select?.length ? select : Object.keys(fieldsFor(name)))])]
					.map((field) => fieldIdentifier(name, field))
					.join(", ");
			const normalize = <T>(name: string, value: T): T => {
				if (value === null || typeof value !== "object") return value;
				const record = value as DatabaseRow;
				for (const [field, attributes] of Object.entries(fieldsFor(name))) {
					const key = getFieldName({ model: name, field });
					const current = record[key];
					if (current === null || current === undefined) continue;
					if (attributes.type === "date" && !(current instanceof Date))
						record[key] = new Date(scalarString(current));
					if (attributes.type === "number" && typeof current !== "number")
						record[key] = Number(current);
				}
				return value;
			};
			const mutationValues = (name: string, values: DatabaseRow) => {
				const fields = fieldsFor(name);
				return Object.fromEntries(
					Object.entries(values).map(([key, value]) => {
						const attributes = Object.entries(fields).find(
							([field]) => getFieldName({ model: name, field }) === key,
						)?.[1];
						const arrayField =
							Array.isArray(attributes?.type) ||
							(typeof attributes?.type === "string" && attributes.type.endsWith("[]"));
						return [
							fieldName(name, key),
							arrayField && Array.isArray(value) ? JSON.stringify(value) : value,
						];
					}),
				);
			};
			const whereClause = (name: string, conditions: CleanedWhere[] | undefined, start = 1) => {
				if (!conditions?.length) return { text: "", values: [] as unknown[] };
				const values: unknown[] = [];
				const expressions = conditions.map((condition, index) => {
					const column = fieldIdentifier(name, condition.field);
					const insensitive = condition.mode === "insensitive";
					const operand = insensitive ? `LOWER(${column})` : column;
					const connector = index === 0 ? "" : condition.connector === "OR" ? " OR " : " AND ";
					if (condition.value === null && condition.operator === "eq")
						return `${connector}${column} IS NULL`;
					if (condition.value === null && condition.operator === "ne")
						return `${connector}${column} IS NOT NULL`;
					const append = (value: unknown) => {
						values.push(value);
						return `$${String(start + values.length - 1)}`;
					};
					const value = insensitive
						? String(condition.value).toLocaleLowerCase("en-US")
						: condition.value;
					switch (condition.operator) {
						case "eq":
							return `${connector}${operand} = ${append(value)}`;
						case "ne":
							return `${connector}${operand} <> ${append(value)}`;
						case "lt":
							return `${connector}${operand} < ${append(value)}`;
						case "lte":
							return `${connector}${operand} <= ${append(value)}`;
						case "gt":
							return `${connector}${operand} > ${append(value)}`;
						case "gte":
							return `${connector}${operand} >= ${append(value)}`;
						case "in":
						case "not_in": {
							const source = Array.isArray(condition.value) ? condition.value : [];
							if (source.length === 0)
								return `${connector}${condition.operator === "in" ? "FALSE" : "TRUE"}`;
							const placeholders = source.map((item) =>
								append(insensitive ? String(item).toLocaleLowerCase("en-US") : item),
							);
							return `${connector}${operand} ${condition.operator === "in" ? "IN" : "NOT IN"} (${placeholders.join(", ")})`;
						}
						case "contains":
							return `${connector}${column} ${insensitive ? "ILIKE" : "LIKE"} ${append(`%${escapeLike(condition.value)}%`)} ESCAPE '\\'`;
						case "starts_with":
							return `${connector}${column} ${insensitive ? "ILIKE" : "LIKE"} ${append(`${escapeLike(condition.value)}%`)} ESCAPE '\\'`;
						case "ends_with":
							return `${connector}${column} ${insensitive ? "ILIKE" : "LIKE"} ${append(`%${escapeLike(condition.value)}`)} ESCAPE '\\'`;
						default:
							throw new Error("Unsupported where operator");
					}
				});
				return { text: ` WHERE ${expressions.join("")}`, values };
			};
			const insertSql = (name: string, data: DatabaseRow, select?: string[]) => {
				const values = mutationValues(name, data);
				const entries = Object.entries(values);
				const columns = entries.map(([field]) => quote(field)).join(", ");
				const placeholders = entries.map((_, index) => `$${String(index + 1)}`).join(", ");
				return {
					text: `INSERT INTO ${tableName(name)} (${columns}) VALUES (${placeholders}) RETURNING ${selectedFields(name, select)}`,
					values: entries.map(([, value]) => value),
				};
			};
			const updateSql = (name: string, data: DatabaseRow, where: CleanedWhere[], select = "*") => {
				const values = mutationValues(name, data);
				const entries = Object.entries(values);
				const assignments = entries
					.map(([field], index) => `${quote(field)} = $${String(index + 1)}`)
					.join(", ");
				const predicate = whereClause(name, where, entries.length + 1);
				return {
					text: `UPDATE ${tableName(name)} SET ${assignments}${predicate.text} RETURNING ${select}`,
					values: [...entries.map(([, value]) => value), ...predicate.values],
				};
			};

			const adapter: CustomAdapter = {
				async create({ model: name, data, select }) {
					const statement = insertSql(name, data, select);
					const row = (await run(query<DatabaseRow>(statement.text, statement.values))).at(0);
					if (!row) throw new Error(`Insert into ${name} returned no row`);
					return normalize(name, row) as typeof data;
				},
				async update<T>({ model: name, where, update }: UpdateArguments<T>) {
					if (where.length === 0) return null;
					const statement = updateSql(name, databaseRow(update), where, selectedFields(name));
					return (
						normalize(
							name,
							(await run(query<DatabaseRow>(statement.text, statement.values)))[0] as T | undefined,
						) ?? null
					);
				},
				async updateMany({ model: name, where, update }) {
					const statement = updateSql(name, update, where, "1 AS changed");
					return (await run(query<DatabaseRow>(statement.text, statement.values))).length;
				},
				async findOne<T>({ model: name, where, select }: FindOneArguments) {
					const predicate = whereClause(name, where);
					const rows = await run(
						query<DatabaseRow>(
							`SELECT ${selectedFields(name, select)} FROM ${tableName(name)}${predicate.text} LIMIT 1`,
							predicate.values,
						),
					);
					return normalize(name, rows[0] as T | undefined) ?? null;
				},
				async findMany<T>({
					model: name,
					where,
					limit,
					select,
					sortBy,
					offset = 0,
				}: FindManyArguments) {
					const predicate = whereClause(name, where);
					const ordering = sortBy
						? ` ORDER BY ${fieldIdentifier(name, sortBy.field)} ${sortBy.direction === "desc" ? "DESC" : "ASC"}`
						: "";
					const rows = await run(
						query<DatabaseRow>(
							`SELECT ${selectedFields(name, select)} FROM ${tableName(name)}${predicate.text}${ordering} LIMIT ${String(boundedInteger(limit, MAX_LIMIT, "limit"))} OFFSET ${String(boundedInteger(offset, MAX_OFFSET, "offset"))}`,
							predicate.values,
						),
					);
					return rows.map((row) => normalize(name, row) as T);
				},
				async delete({ model: name, where }) {
					const predicate = whereClause(name, where);
					await run(
						query<DatabaseRow>(`DELETE FROM ${tableName(name)}${predicate.text}`, predicate.values),
					);
				},
				async deleteMany({ model: name, where }) {
					const predicate = whereClause(name, where);
					return (
						await run(
							query<DatabaseRow>(
								`DELETE FROM ${tableName(name)}${predicate.text} RETURNING 1 AS changed`,
								predicate.values,
							),
						)
					).length;
				},
				async consumeOne<T>({ model: name, where }: FindOneArguments) {
					const predicate = whereClause(name, where);
					const rows = await run(
						query<DatabaseRow>(
							`DELETE FROM ${tableName(name)} WHERE ctid IN (SELECT ctid FROM ${tableName(name)}${predicate.text} LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING ${selectedFields(name)}`,
							predicate.values,
						),
					);
					return normalize(name, rows[0] as T | undefined) ?? null;
				},
				async incrementOne<T>({ model: name, where, increment, set = {} }: IncrementArguments) {
					const setEntries = Object.entries(mutationValues(name, set));
					const incrementEntries = Object.entries(increment);
					const assignments = [
						...setEntries.map(([field], index) => `${quote(field)} = $${String(index + 1)}`),
						...incrementEntries.map(
							([field], index) =>
								`${fieldIdentifier(name, field)} = ${fieldIdentifier(name, field)} + $${String(setEntries.length + index + 1)}`,
						),
					];
					const predicate = whereClause(
						name,
						where,
						setEntries.length + incrementEntries.length + 1,
					);
					const values = [
						...setEntries.map(([, value]) => value),
						...incrementEntries.map(([, value]) => value),
						...predicate.values,
					];
					const rows = await run(
						query<DatabaseRow>(
							`UPDATE ${tableName(name)} SET ${assignments.join(", ")}${predicate.text} RETURNING ${selectedFields(name)}`,
							values,
						),
					);
					return normalize(name, rows[0] as T | undefined) ?? null;
				},
				async count({ model: name, where }) {
					const predicate = whereClause(name, where);
					const row = (
						await run(
							query<{ count: string | number }>(
								`SELECT COUNT(*) AS count FROM ${tableName(name)}${predicate.text}`,
								predicate.values,
							),
						)
					).at(0);
					if (!row) throw new Error(`Count for ${name} returned no row`);
					return Number(row.count);
				},
			};
			return adapter;
		},
	});

	const result = ((options: Parameters<typeof factory>[0]) => {
		const adapter = factory(options);
		transactionAdapter = adapter;
		return adapter;
	}) as AdapterFactory;
	result.close = () => runtime.dispose();
	return result;
};
