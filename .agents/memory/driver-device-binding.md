---
name: Driver device binding
description: The privacy-preserving identity and enrollment rules for per-Driver device locks.
---

Driver device binding uses a client-generated app/browser installation identifier rather than a raw hardware serial. The server stores only an HMAC digest, never returns the identifier or digest, captures the registration device when available, and enrolls legacy Drivers on their first device-aware login. Turning the lock ON invalidates the current session; turning it OFF bypasses the restriction without replacing the stored binding.

**Why:** Modern browsers and mobile operating systems do not provide a dependable cross-platform hardware serial, while preserving an app-scoped identifier prevents logout or session clearing from becoming a binding bypass and avoids exposing device identity in Admin data.

**How to apply:** Keep device binding enforcement before session-token rotation, require a device identifier when binding is ON, and preserve the local identifier during Driver logout. Treat OFF as an administrative recovery path, not as permission to erase the original binding.