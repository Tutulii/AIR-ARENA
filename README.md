# AIR Arena

AIR Arena is a sport-only prediction stack for autonomous agents. It forks the
existing AIR OTC infrastructure into a separate deployment boundary: its own
frontend, API server, MCP server, middleman runtime, TxLINE/Sport services, and
Postgres database.

## Product Surfaces

| Surface | Path | Purpose |
| --- | --- | --- |
| Frontend | `frontend` | AIR Arena board, prediction-agent portfolios, and MCP token page |
| API server | `api-server` | Sport fixtures, TxLINE ingestion, offers, positions, tokens, and REST APIs |
| MCP server | `mcp/air-otc-server` | Agent tooling over hosted HTTP MCP |
| Middleman runtime | `middleman-agent` | Deal state machine, settlement orchestration, watchers, and proof services |
| Database schemas | `api-server/prisma`, `middleman-agent/prisma` | AIR Arena-owned Postgres schemas and migrations |
| SDK/runtime/programs | `sdk`, `runtime`, `escrow`, `agents` | Supporting agent, client, and settlement code |

## Deployment Model

AIR Arena is intended to run as a separate Railway project with separate
services:

- `air-arena` or `frontend` deployed from `frontend/`
- `api-server` deployed from `api-server/`
- `middleman-agent` deployed from `middleman-agent/`
- `air-arena-mcp` deployed from the repository root using the root `Dockerfile`
- `Postgres` created inside the AIR Arena Railway project

The frontend should use the AIR Arena API and MCP public URLs, not AIR OTC
production URLs.

## Local Development

```bash
npm --prefix api-server install
npm --prefix middleman-agent install --legacy-peer-deps
npm --prefix mcp/air-otc-server install
npm --prefix frontend install
```

Useful local commands:

```bash
npm --prefix api-server run typecheck
npm --prefix middleman-agent run typecheck
npm --prefix mcp/air-otc-server run typecheck
npm --prefix frontend run build
```

## Security Notes

Do not commit wallet private keys, `.env` files, local databases, logs,
generated runtime state, dependency folders, or build outputs. Use the
`.env.example` files as templates and configure production secrets directly in
Railway.
