# Realtime ride events

Socket.io is available at `/api/socket.io` on the same origin as the REST API.
Clients must provide the existing JWT during the handshake:

```ts
import { io } from "socket.io-client";

const socket = io(window.location.origin, {
  path: "/api/socket.io",
  auth: { token },
});
```

## Client-to-server events

### `ride:join`

Join a ride room after the user is its passenger or assigned driver.

```ts
socket.emit("ride:join", { rideId }, (response) => {
  // response: { ok: boolean, ride?: Ride, message?: string }
});
```

### `driver:location:update`

The assigned driver can publish the current location while the ride is
`accepted`, `arrived`, or `in-progress`. The location is persisted in
MongoDB as `driverLocation`.

```ts
socket.emit(
  "driver:location:update",
  { rideId, latitude, longitude },
  (response) => {
    // response: { ok: boolean, ride?: Ride, message?: string }
  },
);
```

### `ride:status:update`

Only the assigned driver can advance the ride through these transitions:

```text
accepted -> arrived -> in-progress -> completed
```

```ts
socket.emit("ride:status:update", { rideId, status }, (response) => {
  // response: { ok: boolean, ride?: Ride, message?: string }
});
```

## Server-to-client events

- `realtime:ready` — authenticated socket connection is ready
- `ride:status` — emitted to the ride room and participant user rooms for
  `requested`, `accepted`, `arrived`, `in-progress`, and `completed`
- `ride:location` — emitted to the ride room and participant user rooms with
  the latest driver coordinates and update time

The passenger and assigned driver are automatically placed in private user
rooms. Ride room access is checked against the persisted passenger and driver
IDs.