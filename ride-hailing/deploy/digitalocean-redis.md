# Redis on the existing DigitalOcean Droplet

This deployment is deliberately additive. Redis is a speed-up layer only:

- MongoDB continues to own users, wallets, rides, ride history, Admin settings,
  payment records, and all business rules.
- Redis stores a rebuildable Driver GEO index and short-lived, non-secret Admin
  settings cache entries.
- The application validates every Redis-selected Driver against current
  MongoDB availability, account status, heartbeat, vehicle category, radius,
  and wallet eligibility.
- If Redis is not configured, cannot connect, reaches its memory limit, or
  returns an error, the existing MongoDB bounding-box plus exact Haversine
  matcher remains active.

## Install on the same server

These commands are intended for the Droplet administrator. They are not run by
the application and should not be run in this Replit workspace.

```bash
sudo apt-get update
sudo apt-get install -y redis-server
sudo install -d -o redis -g redis -m 0750 /var/lib/redis/myride
sudo install -o root -g root -m 0644 ride-hailing/deploy/redis.conf.example /etc/redis/myride.conf
sudo install -o root -g root -m 0644 ride-hailing/deploy/myride-redis.service /etc/systemd/system/myride-redis.service
sudo systemctl daemon-reload
sudo systemctl enable --now myride-redis
redis-cli -h 127.0.0.1 -p 6379 PING
```

The service binds only to loopback. Do not expose port 6379 to the public
internet. If the Droplet has an existing Redis service on port 6379, stop and
review that service first rather than replacing it blindly.

## Application environment

Set `REDIS_URL` in the server's environment without committing it to Git. For a
local-only Redis service this is normally:

```text
redis://127.0.0.1:6379
```

If Redis authentication is enabled, use the provider's URL format and store the
password through the server's secret/environment mechanism. Never paste that
value into source code or chat.

After setting the variable, restart only the My Ride API process and verify:

```bash
redis-cli -h 127.0.0.1 -p 6379 INFO persistence
redis-cli -h 127.0.0.1 -p 6379 INFO memory
```

The API logs `[redis] ready` when the connection is usable. A Redis connection
failure must not prevent the API from starting.

## Persistence and backups

The example configuration enables both:

- AOF with `appendfsync everysec` for low data-loss recovery behavior.
- RDB snapshots for compact periodic snapshots and faster bulk recovery.

These files contain only rebuildable acceleration data and cached settings.
They are useful for Redis restart recovery, but they are **not** a backup of
MongoDB. Keep the existing MongoDB backup/restore policy unchanged.

Do not use `FLUSHALL` or `FLUSHDB` as a normal maintenance action. If the GEO
index needs recovery, restarting the API rebuilds it from fresh MongoDB Driver
records.

## Is the current Droplet large enough?

The Droplet plan cannot be identified from this workspace, so an exact
upgrade/no-upgrade answer would be guesswork. Check the server before deciding:

```bash
free -h
nproc
df -h /var/lib/redis
redis-cli INFO memory | egrep 'used_memory_human|maxmemory_human|mem_fragmentation_ratio'
uptime
```

Keep headroom for MongoDB, the Node process, the OS, deploys, and traffic
bursts. Redis itself should not be allowed to consume all remaining memory.
For a typical single-server deployment with thousands of online Drivers, a
small local Redis instance is usually much less demanding than MongoDB; an
upgrade is warranted only when the measured available-memory or CPU headroom
is consistently low, or when MongoDB and the API compete during peak dispatch.
DigitalOcean pricing depends on the exact Droplet size, region, billing term,
and whether Managed Redis is chosen, so it must be checked against the actual
Droplet rather than inferred from the codebase.

For the first rollout, keep Redis local on the current Droplet. Move to a
separate Managed Redis service only when isolation, failover, or operational
headroom justifies its additional cost and network dependency.