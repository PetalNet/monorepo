# Point client (Flutter)

Placeholder. The Flutter client rebuild is a **later wayfinder ticket**.

It is intentionally not scaffolded here yet:

- Flutter is not installed on the authoring machine, and
- the client is out of scope for this ticket (#2, monorepo skeleton).

When it lands, the app will consume the lifted `core` MLS crate (via its
`cdylib`/`staticlib` FFI surface) for end-to-end encryption, and talk to a
`point-server` home-server over HTTP.
