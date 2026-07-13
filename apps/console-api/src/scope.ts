// ReBAC scope tags (contract §7.1). Flat model: `fleet` does not imply `agent:x`;
// visibility is exactly the grant set. Commas are illegal in a tag, so the app.scopes GUC
// (which the RLS policy splits on ',') is unambiguous.

export const SCOPE_RE =
	/^(user:[a-z0-9._-]+|agent:[a-z0-9._-]+|project:[a-z0-9._-]+|fleet|restricted:[a-z0-9._-]+)$/;
