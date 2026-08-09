import { AsyncLocalStorage } from "node:async_hooks";

import * as PgClient from "@effect/sql-pg/PgClient";
import type {
	CleanedWhere,
	CustomAdapter,
	DBTransactionAdapter,
	JoinConfig,
} from "better-auth/adapters";
import { createAdapterFactory } from "better-auth/adapters";
import { Context, Effect, ManagedRuntime, Redacted, Schema } from "effect";
import { Column, Function, Query, Table } from "effect-qb";
import * as Pg from "effect-qb/postgres";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const MAX_LIMIT = 1000;
const MAX_OFFSET = 100_000;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

type RuntimeContext = Context.Context<never>;
type DatabaseRow = Record<string, unknown>;
type AdapterFactory = ReturnType<typeof createAdapterFactory> & { close: () => Promise<void> };
type DynamicColumn = Column.AnyBound;
type DynamicTable = Table.TableDefinition<string, Record<string, Column.Any>, string>;

export interface EffectQbAdapterRuntime {
	runPromise: <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>) => Promise<A>;
}
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

const validIdentifier = (value: string) => {
	if (!identifierPattern.test(value)) throw new Error(`Invalid database identifier: ${value}`);
	return value;
};
const boundedInteger = (value: number, maximum: number, name: string) => {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
		throw new RangeError(`${name} must be between 0 and ${String(maximum)}`);
	return value;
};
const escapeLike = (value: unknown) => String(value).replace(/[\\%_]/g, "\\$&");
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
const rejectJoin = (join: JoinConfig | undefined) => {
	if (join && Object.keys(join).length > 0)
		throw new Error("The effect-qb adapter does not support joined reads");
};
const transaction = <A>(effect: Effect.Effect<A, unknown, PgClient.PgClient>) =>
	Effect.flatMap(PgClient.PgClient, (sql) =>
		sql.withTransaction(effect.pipe(Effect.provideService(PgClient.PgClient, sql))),
	);
const columnFor = (type: unknown) => {
	const column = (() => {
		if (type === "boolean") return Column.boolean();
		if (type === "number") return Pg.Column.float8();
		if (type === "date") return Pg.Column.timestamptz();
		if (type === "json" || (typeof type === "string" && type.endsWith("[]")))
			return Pg.Column.jsonb(Schema.Unknown).pipe(
				Column.driverValueMapping({
					toDriver: (value) => JSON.stringify(value),
				}),
			);
		return Column.text();
	})();
	return column.pipe(Column.nullable);
};

export const createEffectQbAdapter = (
	database: string | EffectQbAdapterRuntime,
): AdapterFactory => {
	const owner = (() => {
		if (typeof database !== "string")
			return { runPromise: database.runPromise, close: () => Promise.resolve() };
		const runtime = ManagedRuntime.make(
			PgClient.layer({ url: Redacted.make(database), maxConnections: 10 }),
		);
		return {
			runPromise: <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>) =>
				runtime.runPromise(effect),
			close: () => runtime.dispose(),
		};
	})();
	const transactionContext = new AsyncLocalStorage<RuntimeContext>();
	const executor = Pg.Executor.make();
	let transactionAdapter: DBTransactionAdapter | undefined;
	const run = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>) => {
		const context = transactionContext.getStore();
		const provided = context ? Effect.provide(effect, context) : effect;
		return owner.runPromise(provided);
	};
	const execute = (plan: Query.QueryPlan<never, never, never, never, never, never, never, never>) =>
		Effect.flatMap(PgClient.PgClient, (sql) =>
			executor.execute(plan as never).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
		) as Effect.Effect<readonly DatabaseRow[], unknown, PgClient.PgClient>;
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
			const fieldName = (name: string, field: string) => {
				const fields = fieldsFor(name);
				if (field === "id") return "id";
				if (field in fields) return validIdentifier(getFieldName({ model: name, field }));
				if (Object.values(fields).some((attributes) => attributes.fieldName === field))
					return validIdentifier(field);
				throw new Error(`Unknown field ${name}.${field}`);
			};
			const tables = new Map<string, DynamicTable>();
			const tableFor = (name: string): DynamicTable => {
				const cached = tables.get(name);
				if (cached) return cached;
				const columns: Record<string, Column.Any> & { id: Column.Any } = {
					id: Column.text().pipe(Column.nullable),
				};
				for (const [field, attributes] of Object.entries(fieldsFor(name)))
					columns[validIdentifier(getFieldName({ model: name, field }))] = columnFor(
						attributes.type,
					);
				const table = Table.make(validIdentifier(getModelName(name)), columns);
				tables.set(name, table);
				return table;
			};
			const fieldColumn = (name: string, field: string): DynamicColumn =>
				tableFor(name).columns[fieldName(name, field)];
			const selectedFields = (name: string, select?: string[]) =>
				Object.fromEntries(
					[...new Set(["id", ...(select?.length ? select : Object.keys(fieldsFor(name)))])].map(
						(field) => {
							const key = fieldName(name, field);
							return [key, fieldColumn(name, field)];
						},
					),
				) as Record<string, DynamicColumn>;
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
				return Object.fromEntries(
					Object.entries(values).map(([key, value]) => [fieldName(name, key), value]),
				);
			};
			const conditionExpression = (name: string, condition: CleanedWhere): unknown => {
				const column = fieldColumn(name, condition.field);
				const insensitive = condition.mode === "insensitive";
				const operand = insensitive ? Query.lower(column as never) : column;
				const value = insensitive
					? String(condition.value).toLocaleLowerCase("en-US")
					: condition.value;
				if (condition.value === null && condition.operator === "eq") return Query.isNull(column);
				if (condition.value === null && condition.operator === "ne") return Query.isNotNull(column);
				switch (condition.operator) {
					case "eq":
						return Query.eq(operand as never, value as never);
					case "ne":
						return Query.neq(operand as never, value as never);
					case "lt":
						return Query.lt(operand as never, value as never);
					case "lte":
						return Query.lte(operand as never, value as never);
					case "gt":
						return Query.gt(operand as never, value as never);
					case "gte":
						return Query.gte(operand as never, value as never);
					case "in":
					case "not_in": {
						const source = Array.isArray(condition.value) ? condition.value : [];
						if (source.length === 0) return Query.literal(condition.operator === "not_in");
						const values = insensitive
							? source.map((item) => String(item).toLocaleLowerCase("en-US"))
							: source;
						return condition.operator === "in"
							? Query.in(operand as never, ...(values as [never, ...never[]]))
							: Query.notIn(operand as never, ...(values as [never, ...never[]]));
					}
					case "contains": {
						const pattern = `%${escapeLike(condition.value)}%`;
						return insensitive
							? Query.ilike(column as never, pattern as never)
							: Query.like(column as never, pattern as never);
					}
					case "starts_with": {
						const pattern = `${escapeLike(condition.value)}%`;
						return insensitive
							? Query.ilike(column as never, pattern as never)
							: Query.like(column as never, pattern as never);
					}
					case "ends_with": {
						const pattern = `%${escapeLike(condition.value)}`;
						return insensitive
							? Query.ilike(column as never, pattern as never)
							: Query.like(column as never, pattern as never);
					}
					default:
						throw new Error("Unsupported where operator");
				}
			};
			const predicateFor = (name: string, conditions: CleanedWhere[] | undefined) => {
				if (!conditions?.length) return undefined;
				const groups: unknown[][] = [[]];
				for (const condition of conditions) {
					if (condition.connector === "OR" && groups.at(-1)?.length) groups.push([]);
					groups.at(-1)?.push(conditionExpression(name, condition));
				}
				const expressions = groups.map((group) =>
					group.length === 1 ? group[0] : Query.and(...(group as [never, ...never[]])),
				);
				return expressions.length === 1
					? expressions[0]
					: Query.or(...(expressions as [never, ...never[]]));
			};
			const withPredicate = <Plan>(plan: Plan, name: string, where?: CleanedWhere[]) => {
				const predicate = predicateFor(name, where);
				return predicate ? Query.where(predicate as never)(plan as never) : plan;
			};
			const runPlan = (plan: unknown) => run(execute(plan as never));

			const adapter: CustomAdapter = {
				async create({ model: name, data, select }) {
					const plan = Query.insert(tableFor(name), mutationValues(name, data)).pipe(
						Query.returning(selectedFields(name, select)),
					);
					const row = (await runPlan(plan)).at(0);
					if (!row) throw new Error(`Insert into ${name} returned no row`);
					return normalize(name, row) as typeof data;
				},
				async update<T>({ model: name, where, update }: UpdateArguments<T>) {
					if (where.length === 0) return null;
					const plan = withPredicate(
						Query.update(tableFor(name), mutationValues(name, databaseRow(update)) as never),
						name,
						where,
					).pipe(Query.returning(selectedFields(name)));
					return normalize(name, (await runPlan(plan))[0] as T | undefined) ?? null;
				},
				async updateMany({ model: name, where, update }) {
					const plan = withPredicate(
						Query.update(tableFor(name), mutationValues(name, update) as never),
						name,
						where,
					).pipe(Query.returning({ id: fieldColumn(name, "id") }));
					return (await runPlan(plan)).length;
				},
				async findOne<T>({ model: name, where, select, join }: FindOneArguments) {
					rejectJoin(join);
					const plan = withPredicate(
						Query.select(selectedFields(name, select)).pipe(Query.from(tableFor(name))),
						name,
						where,
					).pipe(Query.limit(1));
					return normalize(name, (await runPlan(plan))[0] as T | undefined) ?? null;
				},
				async findMany<T>({
					model: name,
					where,
					limit,
					select,
					sortBy,
					offset = 0,
					join,
				}: FindManyArguments) {
					rejectJoin(join);
					let plan = withPredicate(
						Query.select(selectedFields(name, select)).pipe(Query.from(tableFor(name))),
						name,
						where,
					);
					if (sortBy)
						plan = Query.orderBy(fieldColumn(name, sortBy.field), sortBy.direction)(plan as never);
					plan = Query.limit(boundedInteger(limit, MAX_LIMIT, "limit"))(plan as never);
					plan = Query.offset(boundedInteger(offset, MAX_OFFSET, "offset"))(plan as never);
					return (await runPlan(plan)).map((row) => normalize(name, row) as T);
				},
				async delete({ model: name, where }) {
					if (where.length === 0) return;
					await runPlan(withPredicate(Query.delete(tableFor(name)), name, where));
				},
				async deleteMany({ model: name, where }) {
					const plan = withPredicate(Query.delete(tableFor(name)), name, where).pipe(
						Query.returning({ id: fieldColumn(name, "id") }),
					);
					return (await runPlan(plan)).length;
				},
				async consumeOne<T>({ model: name, where, join }: FindOneArguments) {
					rejectJoin(join);
					const effect = Effect.gen(function* () {
						const selected = withPredicate(
							Query.select(selectedFields(name)).pipe(Query.from(tableFor(name))),
							name,
							where,
						).pipe(Query.limit(1), Query.lock("update", { skipLocked: true }));
						const row = (yield* execute(selected as never)).at(0);
						if (!row) return undefined;
						const deleted = Query.delete(tableFor(name)).pipe(
							Query.where(Query.eq(fieldColumn(name, "id") as never, row.id as never)),
							Query.returning(selectedFields(name)),
						);
						return (yield* execute(deleted as never))[0];
					});
					return normalize(name, (await run(transaction(effect))) as T | undefined) ?? null;
				},
				async incrementOne<T>({ model: name, where, increment, set = {} }: IncrementArguments) {
					for (const field of Object.keys(increment)) fieldColumn(name, field);
					const effect = Effect.gen(function* () {
						const selected = withPredicate(
							Query.select(selectedFields(name)).pipe(Query.from(tableFor(name))),
							name,
							where,
						).pipe(Query.limit(1), Query.lock("update"));
						const row = (yield* execute(selected as never)).at(0);
						if (!row) return undefined;
						const values = mutationValues(name, {
							...set,
							...Object.fromEntries(
								Object.entries(increment).map(([field, amount]) => {
									const value = row[fieldName(name, field)];
									if (typeof value !== "number")
										throw new TypeError(`Cannot increment non-numeric field ${name}.${field}`);
									return [field, value + amount];
								}),
							),
						});
						const updated = Query.update(tableFor(name), values as never).pipe(
							Query.where(Query.eq(fieldColumn(name, "id") as never, row.id as never)),
							Query.returning(selectedFields(name)),
						);
						return (yield* execute(updated as never))[0];
					});
					return normalize(name, (await run(transaction(effect))) as T | undefined) ?? null;
				},
				async count({ model: name, where }) {
					const plan = withPredicate(
						Query.select({ count: Function.count(fieldColumn(name, "id")) }).pipe(
							Query.from(tableFor(name)),
						),
						name,
						where,
					);
					const row = (await runPlan(plan)).at(0);
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
	result.close = owner.close;
	return result;
};
