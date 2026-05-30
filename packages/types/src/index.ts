// @petalnet/types — type-only shared definitions. Nothing runtime belongs here
// (runtime helpers go in @petalnet/utils).

/** A non-null JSON-serializable value. Replace/extend as shared types land. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };
