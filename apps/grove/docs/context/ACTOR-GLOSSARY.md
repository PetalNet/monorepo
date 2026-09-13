# Actor glossary

## Actor

A durable identity that can perform attributable Grove commands. A Person and an Agent are Actors.

## Person

A human Actor authenticated through a verified browser identity. A Person may own a Home Host and may receive explicit access to Agents.

## Agent

A durable non-human Actor with its own stable external identity, lifecycle, Home Host, owner, and capabilities. An Agent is not a Runtime and never borrows a Person's identity from conversation.

## External identity

The issuer-qualified pair `(issuer, subject)` asserted by a verified identity provider. Email addresses, display names, and OAuth client identifiers are not external identities.

## Home Host

The one Host to which an Agent belongs. Its Person owner owns the Agent even when a Runtime executes elsewhere. Changing which Person is eligible to claim an unowned Home Host does not transfer an existing owner.

## Actor lifecycle

Whether an Actor may currently act. Suspension is a reversible loss of acting authority. Retirement is the permanent end of future acting authority.

## Runner

The execution facility associated with a Host. Moving execution between Runners does not move an Agent's Home Host or ownership.

## Runtime

A temporary acting instance of an Agent. A Runtime acts only as its Agent and does not acquire human authority from prompts, Tasks, or Rooms.

## Capability containment

The invariant that an Agent's effective capabilities are a subset of every Person's effective capabilities while that Person is allowed to interact with the Agent.

## Bootstrap principal

A verified, unbound machine identity admitted only to initialize MCP, inspect the self-enrollment operation, and explicitly enroll itself as an Agent.
