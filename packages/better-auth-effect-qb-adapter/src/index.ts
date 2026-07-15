import * as PgClient from "@effect/sql-pg/PgClient";
import type { CleanedWhere, CustomAdapter, DBTransactionAdapter, JoinConfig } from "better-auth/adapters";
import { createAdapterFactory } from "better-auth/adapters";
import { Context, Effect, ManagedRuntime, Redacted, Schema } from "effect";
import { Column, Query, Table } from "effect-qb";
import { Column as PgColumn, Executor } from "effect-qb/postgres";

const MAX_LIMIT = 1000;
const MAX_OFFSET = 100_000;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const executor = Executor.make();
const Q: any = Query;
const escapedLike = (value: unknown) => String(value).replace(/[\\%_]/g, "\\$&");

type RuntimeContext = Context.Context<never>;
type AdapterFactory = ReturnType<typeof createAdapterFactory> & { close: () => Promise<void> };

const quoted = (value: string) => {
	if (!identifierPattern.test(value)) throw new Error(`Invalid database identifier: ${value}`);
	return value;
};

const boundedInteger = (value: number, maximum: number, name: string) => {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
		throw new RangeError(`${name} must be between 0 and ${maximum}`);
	return value;
};

const columnForAttributes = (attributes: { type: unknown; required?: boolean }) => {
	let column;
	if (attributes.type === "boolean") column = Column.boolean();
	else if (attributes.type === "number") column = PgColumn.float8();
	else if (attributes.type === "date") column = PgColumn.timestamptz();
	else if (attributes.type === "json" || Array.isArray(attributes.type) || (typeof attributes.type === "string" && attributes.type.endsWith("[]"))) column = Column.json(Schema.Unknown);
	else column = Column.text();
	return attributes.required ? column : column.pipe(Column.nullable);
};

export const createEffectQbAdapter = (databaseUrl: string): AdapterFactory => {
	const runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(databaseUrl), maxConnections: 10 }));
	let transactionAdapter: DBTransactionAdapter | undefined;
	const transactionContext = new AsyncLocalStorage<RuntimeContext>();
	const run = <A>(effect: Effect.Effect<A, unknown, never>) =>
		runtime.runPromise(transactionContext.getStore() ? Effect.provide(effect, transactionContext.getStore()!) : effect);

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
				return runtime.runPromise(Effect.flatMap(PgClient.PgClient, (sql) => sql.withTransaction(Effect.flatMap(Effect.context<never>(), (context) => Effect.promise(async () => {
					return transactionContext.run(context, () => callback(transactionAdapter!));
				})))));
			},
		},
		adapter: ({ schema, getModelName, getDefaultModelName, getFieldName }) => {
			const normalize = <T>(name: string, value: T): T => {
				if (!value || typeof value !== "object") return value;
				const fields = schema[getDefaultModelName(name)]?.fields ?? {};
				for (const [field, attributes] of Object.entries(fields)) {
					const key = getFieldName({ model: name, field });
					const record = value as Record<string, unknown>;
					if (record[key] == null) continue;
					if (attributes.type === "date" && !(record[key] instanceof Date)) record[key] = new Date(String(record[key]));
					if (attributes.type === "number" && typeof record[key] !== "number") record[key] = Number(record[key]);
				}
				return value;
			};
			const mutationValues = (name: string, values: Record<string, unknown>) => {
				const fields = schema[getDefaultModelName(name)]?.fields ?? {};
				return Object.fromEntries(Object.entries(values).map(([key, value]) => {
					const attributes = Object.entries(fields).find(([field]) => getFieldName({ model: name, field }) === key)?.[1];
					const arrayField = Array.isArray(attributes?.type) || (typeof attributes?.type === "string" && attributes.type.endsWith("[]"));
					return [key, arrayField && Array.isArray(value) ? JSON.stringify(value) : value];
				}));
			};
			const model = (name: string) => {
				const defaultName = getDefaultModelName(name);
				const fields = schema[defaultName]?.fields;
				if (!fields) throw new Error(`Unknown model ${name}`);
				const columns = Object.fromEntries(Object.entries(fields).map(([field, attributes]) => [getFieldName({ model: name, field }), columnForAttributes(attributes)]));
				if (!("id" in columns)) columns.id = Column.text();
				return Table.make(quoted(getModelName(name)), columns);
			};
			const fieldName = (name: string, field: string) => {
				const fields = schema[getDefaultModelName(name)]?.fields;
				if (!fields) throw new Error(`Unknown model ${name}`);
				if (field in fields) return quoted(getFieldName({ model: name, field }));
				if (Object.values(fields).some((attributes) => attributes.fieldName === field)) return quoted(field);
				throw new Error(`Unknown field ${name}.${field}`);
			};
			const selection = (table: any, name: string, select?: string[]) => Object.fromEntries((select?.length ? select.map((field) => fieldName(name, field)) : Object.keys(table.columns)).map((field) => [field, table.columns[field]]));
			const predicate = (table: any, name: string, conditions: CleanedWhere[] | undefined) => {
				if (!conditions?.length) return undefined;
				const expressions = conditions.map((condition) => {
					const column = table.columns[fieldName(name, condition.field)];
					const value = condition.value as any;
					switch (condition.operator) {
						case "eq": return value === null ? Q.isNull(column) : condition.mode === "insensitive" ? Q.eq(Q.lower(column), String(value).toLocaleLowerCase("en-US")) : Q.eq(column, value);
						case "ne": return value === null ? Q.isNotNull(column) : condition.mode === "insensitive" ? Q.neq(Q.lower(column), String(value).toLocaleLowerCase("en-US")) : Q.neq(column, value);
						case "lt": return Q.lt(column, value);
						case "lte": return Q.lte(column, value);
						case "gt": return Q.gt(column, value);
						case "gte": return Q.gte(column, value);
						case "in": return condition.mode === "insensitive" ? Q.in(Q.lower(column), ...(Array.isArray(value) ? value.map((item) => String(item).toLocaleLowerCase("en-US")) : [])) : Q.in(column, ...(Array.isArray(value) ? value : []));
						case "not_in": return condition.mode === "insensitive" ? Q.notIn(Q.lower(column), ...(Array.isArray(value) ? value.map((item) => String(item).toLocaleLowerCase("en-US")) : [])) : Q.notIn(column, ...(Array.isArray(value) ? value : []));
						case "contains": return (condition.mode === "insensitive" ? Q.ilike : Q.like)(column, `%${escapedLike(value)}%`);
						case "starts_with": return (condition.mode === "insensitive" ? Q.ilike : Q.like)(column, `${escapedLike(value)}%`);
						case "ends_with": return (condition.mode === "insensitive" ? Q.ilike : Q.like)(column, `%${escapedLike(value)}`);
						default: throw new Error(`Unsupported where operator: ${condition.operator}`);
					}
				});
				return expressions.slice(1).reduce((combined: any, expression: any, index) => conditions[index + 1]?.connector === "OR" ? (Q.or as any)(combined, expression) : (Q.and as any)(combined, expression), expressions[0]);
			};
			const execute = <T>(plan: any) => run(executor.execute(plan) as Effect.Effect<T, unknown, never>);
			const adapter: CustomAdapter = {
				async create({ model: name, data, select }) {
					const table = model(name) as any;
					const plan = Q.insert(table, mutationValues(name, data) as any).pipe(Q.returning(selection(table, name, select) as any));
					return normalize(name, ((await execute<any[]>(plan))[0])) as typeof data;
				},
				async update({ model: name, where, update }) {
					if (!where.length) return null;
					const table = model(name) as any;
					const primary = table.columns.id ?? table.columns[Object.keys(table.columns)[0]];
					const result = await run(Effect.flatMap(PgClient.PgClient, (sql) => sql.withTransaction(Effect.gen(function* () {
						const selected = yield* executor.execute(Q.select({ id: primary }).pipe(Q.from(table), Q.where(predicate(table, name, where) as any), Q.limit(1), Q.lock("update")) as any) as any;
						if (!selected[0]) return null;
						const plan = Q.update(table, mutationValues(name, update as Record<string, unknown>) as any).pipe(Q.where(Q.eq(primary, selected[0].id)), Q.returning(selection(table, name) as any));
						return (yield* executor.execute(plan as any) as any)[0] ?? null;
					}))) as Effect.Effect<unknown, unknown, never>);
					return normalize(name, result as typeof update | null);
				},
				async updateMany({ model: name, where, update }) {
					const table = model(name) as any;
					let plan: any = Q.update(table, mutationValues(name, update) as any);
					if (where.length) plan = plan.pipe(Q.where(predicate(table, name, where) as any));
					return (await execute<any[]>(plan.pipe(Q.returning({ id: table.columns[Object.keys(table.columns)[0]] })))).length;
				},
				async findOne<T>({ model: name, where, select }: { model: string; where: CleanedWhere[]; select?: string[]; join?: JoinConfig }) {
					const table = model(name) as any;
					const plan = Q.select(selection(table, name, select) as any).pipe(Q.from(table), Q.where(predicate(table, name, where) as any), Q.limit(1));
					return normalize(name, (await execute<T[]>(plan))[0] ?? null);
				},
				async findMany<T>({ model: name, where, limit, select, sortBy, offset = 0 }: { model: string; where?: CleanedWhere[]; limit: number; select?: string[]; sortBy?: { field: string; direction: "asc" | "desc" }; offset?: number; join?: JoinConfig }) {
					const table = model(name) as any;
					let plan: any = Q.select(selection(table, name, select) as any).pipe(Q.from(table));
					if (where?.length) plan = plan.pipe(Q.where(predicate(table, name, where) as any));
					if (sortBy) plan = plan.pipe(Q.orderBy(table.columns[fieldName(name, sortBy.field)], sortBy.direction));
					plan = plan.pipe(Q.limit(boundedInteger(limit, MAX_LIMIT, "limit")), Q.offset(boundedInteger(offset, MAX_OFFSET, "offset")));
					return (await execute<T[]>(plan)).map((row) => normalize(name, row));
				},
				async delete({ model: name, where }) {
					const table = model(name) as any;
					await execute(Q.delete(table).pipe(Q.where(predicate(table, name, where) as any), Q.returning({ id: table.columns[Object.keys(table.columns)[0]] })));
				},
				async deleteMany({ model: name, where }) {
					const table = model(name) as any;
					let plan: any = Q.delete(table);
					if (where.length) plan = plan.pipe(Q.where(predicate(table, name, where) as any));
					return (await execute<any[]>(plan.pipe(Q.returning({ id: table.columns[Object.keys(table.columns)[0]] })))).length;
				},
				async consumeOne<T>({ model: name, where }: { model: string; where: CleanedWhere[] }) {
					const table = model(name) as any;
					const primary = table.columns.id ?? table.columns[Object.keys(table.columns)[0]];
					const candidate = Q.select({ id: primary }).pipe(Q.from(table), Q.where(predicate(table, name, where) as any), Q.limit(1), Q.lock("update", { skipLocked: true }));
					const plan = Q.delete(table).pipe(Q.where(Q.inSubquery(primary, candidate)), Q.returning(selection(table, name) as any));
					return normalize(name, (await execute<T[]>(plan))[0] ?? null);
				},
				async incrementOne<T>({ model: name, where, increment, set = {} }: { model: string; where: CleanedWhere[]; increment: Record<string, number>; set?: Record<string, unknown> }) {
					const table = model(name) as any;
					const result = await run(Effect.flatMap(PgClient.PgClient, (sql) => sql.withTransaction(Effect.gen(function* () {
						const selected = yield* executor.execute(Q.select(selection(table, name) as any).pipe(Q.from(table), Q.where(predicate(table, name, where) as any), Q.limit(1), Q.lock("update")) as any) as any;
						if (!selected[0]) return null;
						const values = { ...set } as Record<string, unknown>;
						for (const [field, amount] of Object.entries(increment)) {
							const key = fieldName(name, field);
							values[key] = Number(selected[0][key]) + amount;
						}
						const primary = table.columns.id ?? table.columns[Object.keys(table.columns)[0]];
						const updated = yield* executor.execute(Q.update(table, mutationValues(name, values) as any).pipe(Q.where(Q.eq(primary, selected[0].id)), Q.returning(selection(table, name) as any)) as any) as any;
						return updated[0] ?? null;
					}))) as Effect.Effect<unknown, unknown, never>);
					return normalize(name, result as T | null);
				},
				async count({ model: name, where }) {
					const table = model(name) as any;
					let plan: any = Q.select({ count: Q.count(table.columns[Object.keys(table.columns)[0]]) }).pipe(Q.from(table));
					if (where?.length) plan = plan.pipe(Q.where(predicate(table, name, where) as any));
					return Number((await execute<Array<{ count: number | string }>>(plan))[0]?.count ?? 0);
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
import { AsyncLocalStorage } from "node:async_hooks";
