# My Ride

Nationwide ride-hailing platform with Customer, Driver, and Admin web portals plus native Customer and Driver applications.

## Run & Operate

- `cd ride-hailing && pnpm start` — run the canonical production service (`NODE_ENV=production`, `ride-hailing/server.js`)
- `cd ride-hailing && pnpm dev` — run the local service
- `cd ride-hailing && pnpm test` — run the Ride Hailing Playwright suite
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- The `Ride Hailing App` workflow is the canonical production workflow and runs `cd ride-hailing && NODE_ENV=production PORT=3000 pnpm start`.
- `artifacts/api-server` is a separate proxy artifact and is not the canonical Ride Hailing application service.
- The server loads `ride-hailing/.env` or the repository-root `.env` without overriding variables supplied by the process environment.

## Stack

- pnpm workspace, Node.js, JavaScript
- Canonical service: Express + Mongoose + Socket.io
- Database: MongoDB
- Shared infrastructure: Redis, SMTP, Mapbox, Web Push, DigitalOcean Spaces
- Native clients: Expo Customer and Driver applications

## Where things live

- `ride-hailing/server.js` — canonical Customer, Driver, Admin, REST, Socket.io, and persistence service
- `ride-hailing/.env.example` — required production variables and configuration guidance
- `artifacts/myride-customer-mobile` — native Customer application
- `artifacts/myride-driver-mobile` — native Driver application

## Architecture decisions

- Production uses `NODE_ENV=production` through the canonical start command.
- Environment values are loaded from the existing `.env` files and process environment.

## Product

Customers book rides and track trips, Drivers receive and manage ride requests, and Admins manage operations, identity verification, fares, wallets, and payments.

## User preferences

Keep production-readiness changes narrowly scoped and verify web plus native behavior where applicable.

## Gotchas

- Keep production values in the existing `.env` or deployment environment.
- Demo/test behavior remains controlled by the existing runtime flags and `NODE_ENV` checks.

## Pointers

- See `ride-hailing/.env.example` before configuring DigitalOcean or another production host.
