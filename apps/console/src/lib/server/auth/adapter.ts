import { AsyncLocalStorage } from "node:async_hooks";
import type { CleanedWhere, CustomAdapter, DBTransactionAdapter, JoinConfig } from "better-auth/adapters";
import { createAdapterFactory } from "better-auth/adapters";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

const MAX_LIMIT = 1000;
const MAX_OFFSET = 100_000;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const transactionClient = new AsyncLocalStorage<PoolClient>();
const escapedLike = (value: unknown) => String(value).replace(/[\\%_]/g, "\\$&");

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

const quoted = (value: string) => {
	if (!identifierPattern.test(value)) throw new Error(`Invalid database identifier: ${value}`);
	return `"${value}"`;
};

const boundedInteger = (value: number, maximum: number, name: string) => {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
		throw new RangeError(`${name} must be between 0 and ${maximum}`);
	return value;
};

export const createEffectQbAdapter = (databaseUrl: string) => {
	const pool = new Pool({ connectionString: databaseUrl, max: 10 });
	let transactionAdapter: DBTransactionAdapter | undefined;

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
				const client = await pool.connect();
				try {
					await client.query("begin");
					const boundAdapter = new Proxy(transactionAdapter!, {
						get(target, property, receiver) {
							const value = Reflect.get(target, property, receiver);
							return typeof value === "function"
								? (...arguments_: unknown[]) =>
									transactionClient.run(client, () => value.apply(target, arguments_))
								: value;
						},
					});
					const result = await transactionClient.run(client, () => callback(boundAdapter));
					await client.query("commit");
					return result;
				} catch (error) {
					await client.query("rollback");
					throw error;
				} finally {
					client.release();
				}
			},
		},
		adapter: ({ schema, getModelName, getDefaultModelName, getFieldName }) => {
			const database = (): Queryable => transactionClient.getStore() ?? pool;
			const modelTable = (model: string) => quoted(getModelName(model));
			const fieldColumn = (model: string, field: string) => {
				const defaultModel = getDefaultModelName(model);
				const fields = schema[defaultModel]?.fields;
				if (!fields) throw new Error(`Unknown model ${model}`);
				if (field in fields) return quoted(getFieldName({ model, field }));
				if (Object.values(fields).some((attributes) => attributes.fieldName === field))
					return quoted(field);
				throw new Error(`Unknown field ${model}.${field}`);
			};
			const selectedColumns = (model: string, select?: string[]) =>
				select?.length ? select.map((field) => fieldColumn(model, field)).join(", ") : "*";
			const whereClause = (model: string, where: CleanedWhere[] | undefined, values: unknown[]) => {
				if (!where?.length) return "";
				const predicates = where.map((condition, index) => {
					const column = fieldColumn(model, condition.field);
					const insensitive = condition.mode === "insensitive";
					const expression = insensitive ? `lower(${column})` : column;
					const normalize = (value: unknown) =>
						insensitive && typeof value === "string" ? value.toLocaleLowerCase("en-US") : value;
					const parameter = (value: unknown) => {
						values.push(normalize(value));
						return `$${values.length}`;
					};
					let predicate: string;
					switch (condition.operator) {
						case "eq":
							predicate = condition.value === null ? `${expression} is null` : `${expression} = ${parameter(condition.value)}`;
							break;
						case "ne":
							predicate = condition.value === null ? `${expression} is not null` : `${expression} <> ${parameter(condition.value)}`;
							break;
						case "lt":
						case "lte":
						case "gt":
						case "gte": {
							const operators = { lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;
							predicate = `${expression} ${operators[condition.operator]} ${parameter(condition.value)}`;
							break;
						}
						case "in":
						case "not_in": {
							if (!Array.isArray(condition.value)) throw new TypeError(`${condition.operator} requires an array`);
							if (condition.value.length === 0) {
								predicate = condition.operator === "in" ? "false" : "true";
								break;
							}
							const parameters = condition.value.map(parameter).join(", ");
							predicate = `${expression} ${condition.operator === "in" ? "in" : "not in"} (${parameters})`;
							break;
						}
						case "contains":
							predicate = `${expression} like ${parameter(`%${escapedLike(condition.value)}%`)} escape '\\'`;
							break;
						case "starts_with":
							predicate = `${expression} like ${parameter(`${escapedLike(condition.value)}%`)} escape '\\'`;
							break;
						case "ends_with":
							predicate = `${expression} like ${parameter(`%${escapedLike(condition.value)}`)} escape '\\'`;
							break;
						default:
							throw new Error(`Unsupported where operator: ${condition.operator}`);
					}
					return `${index === 0 ? "" : `${condition.connector} `}${predicate}`;
				});
				return ` where ${predicates.join(" ")}`;
			};
			const entries = (model: string, data: Record<string, unknown>, values: unknown[]) =>
				Object.entries(data).map(([field, value]) => {
					values.push(Array.isArray(value) ? JSON.stringify(value) : value);
					return [fieldColumn(model, field), `$${values.length}`] as const;
				});
			const query = async <T extends QueryResultRow>(sql: string, values: unknown[] = []) =>
				(await database().query<T>(sql, values)).rows;

			const adapter: CustomAdapter = {
				async create({ model, data, select }) {
					const values: unknown[] = [];
					const columns = entries(model, data, values);
					const rows = await query<Record<string, unknown>>(
						`insert into ${modelTable(model)} (${columns.map(([column]) => column).join(", ")}) values (${columns.map(([, parameter]) => parameter).join(", ")}) returning ${selectedColumns(model, select)}`,
						values,
					);
					return rows[0] as typeof data;
				},
				async update({ model, where, update }) {
					if (where.length === 0) return null;
					const values: unknown[] = [];
					const assignments = entries(model, update as Record<string, unknown>, values);
					const filter = whereClause(model, where, values);
					const rows = await query(`update ${modelTable(model)} set ${assignments.map(([column, parameter]) => `${column} = ${parameter}`).join(", ")}${filter} returning *`, values);
					return (rows[0] as typeof update | undefined) ?? null;
				},
				async updateMany({ model, where, update }) {
					const values: unknown[] = [];
					const assignments = entries(model, update, values);
					const rows = await query(`update ${modelTable(model)} set ${assignments.map(([column, parameter]) => `${column} = ${parameter}`).join(", ")}${whereClause(model, where, values)} returning 1`, values);
					return rows.length;
				},
				async findOne<T>({ model, where, select }: { model: string; where: CleanedWhere[]; select?: string[]; join?: JoinConfig }) {
					const values: unknown[] = [];
					const rows = await query(`select ${selectedColumns(model, select)} from ${modelTable(model)}${whereClause(model, where, values)} limit 1`, values);
					return (rows[0] as T | undefined) ?? null;
				},
				async findMany<T>({ model, where, limit, select, sortBy, offset = 0 }: { model: string; where?: CleanedWhere[]; limit: number; select?: string[]; sortBy?: { field: string; direction: "asc" | "desc" }; offset?: number; join?: JoinConfig }) {
					const values: unknown[] = [];
					const order = sortBy ? ` order by ${fieldColumn(model, sortBy.field)} ${sortBy.direction}` : "";
					const boundedLimit = boundedInteger(limit, MAX_LIMIT, "limit");
					const boundedOffset = boundedInteger(offset, MAX_OFFSET, "offset");
					const rows = await query(`select ${selectedColumns(model, select)} from ${modelTable(model)}${whereClause(model, where, values)}${order} limit ${boundedLimit} offset ${boundedOffset}`, values);
					return rows as T[];
				},
				async delete({ model, where }) {
					const values: unknown[] = [];
					await query(`delete from ${modelTable(model)}${whereClause(model, where, values)}`, values);
				},
				async deleteMany({ model, where }) {
					const values: unknown[] = [];
					const rows = await query(`delete from ${modelTable(model)}${whereClause(model, where, values)} returning 1`, values);
					return rows.length;
				},
				async consumeOne<T>({ model, where }: { model: string; where: CleanedWhere[] }) {
					const values: unknown[] = [];
					const rows = await query(`delete from ${modelTable(model)} where ctid in (select ctid from ${modelTable(model)}${whereClause(model, where, values)} limit 1 for update skip locked) returning *`, values);
					return (rows[0] as T | undefined) ?? null;
				},
				async incrementOne<T>({ model, where, increment, set = {} }: { model: string; where: CleanedWhere[]; increment: Record<string, number>; set?: Record<string, unknown> }) {
					const values: unknown[] = [];
					const increments = Object.entries(increment).map(([field, amount]) => {
						values.push(amount);
						const column = fieldColumn(model, field);
						return `${column} = ${column} + $${values.length}`;
					});
					const assignments = entries(model, set, values).map(([column, parameter]) => `${column} = ${parameter}`);
					const rows = await query(`update ${modelTable(model)} set ${[...increments, ...assignments].join(", ")}${whereClause(model, where, values)} returning *`, values);
					return (rows[0] as T | undefined) ?? null;
				},
				async count({ model, where }) {
					const values: unknown[] = [];
					const rows = await query<{ count: string }>(`select count(*)::text as count from ${modelTable(model)}${whereClause(model, where, values)}`, values);
					return Number(rows[0]?.count ?? 0);
				},
			};
			return adapter;
		},
	});

	return Object.assign(
		(options: Parameters<typeof factory>[0]) => {
			const adapter = factory(options);
			transactionAdapter = adapter;
			return adapter;
		},
		{ close: () => pool.end() },
	);
};
