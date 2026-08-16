# ADR 0001: Adopt a modular monolith

- Status: Accepted
- Date: 2026-08-09

## Context

The MVP needs coordinated household authorization, canonical persistence,
policy-gated agents, and offline replication without premature distributed
systems overhead.

## Decision

Use a TypeScript pnpm workspace with separate apps and explicit package
boundaries, deployed as one modular monolith. The API owns mutations,
PostgreSQL owns canonical state, and the worker owns deterministic jobs.

## Consequences

Modules can be independently tested and later extracted when evidence warrants
it. In exchange, package boundaries and deny-by-default capability contracts
must be maintained inside the shared deployment unit.
