# My Ride four-app parity matrix

The platform has four maintained product surfaces:

- **Customer Web** — the full browser Customer experience.
- **Customer Native/Expo** — a native Expo shell around the same-origin `/customer`
  experience. This is intentional: it keeps booking, Mapbox search, Socket.io
  updates, authentication, and Urdu rendering on the same supported contract.
- **Driver Web** — the Driver PWA.
- **Driver Native/Expo** — the native Driver application with native location,
  alerts, and navigation-map controls.

| Behavior | Customer Web | Customer Native/Expo | Driver Web | Driver Native/Expo |
|---|---|---|---|---|
| Authentication and session recovery | Implemented | Implemented through same-origin WebView | Implemented | Implemented with persisted native session |
| Nationwide Mapbox location search | Implemented | Implemented through WebView | N/A | N/A |
| Pickup-pin proximity ranking without city filtering | Implemented | Implemented through WebView | N/A | N/A |
| Fixed-center pickup/drop-off selection | Implemented | Implemented through WebView | N/A | N/A |
| Typed, voice, and mixed Urdu/Roman Urdu search | Implemented | Implemented through WebView plus native microphone permission | N/A | N/A |
| Fare display and bounded Customer negotiation | Implemented | Implemented through WebView | Consumes authoritative ride fare | Consumes authoritative ride fare |
| Realtime ride state and reconnect reconciliation | Implemented | Implemented through WebView | Implemented | Implemented with native active-ride hydration |
| Live driver location and three-second active tracking | Receives updates | Receives updates through WebView | Sends/receives updates | Sends native background updates |
| Active ride map and destination markers | Implemented | Implemented through WebView | Implemented | Implemented with native map markers |
| Navigation follow, heading, pitch, and recenter | Customer map behavior | Same behavior through WebView | Implemented | Implemented with native map camera |
| Manual map gesture pauses navigation follow | Implemented | Implemented through WebView | Implemented | Implemented |
| Ride offer expiry and cancellation cleanup | Implemented | Implemented through WebView | Implemented | Implemented |
| Pickup PIN release | Server-authoritative | Same server contract through WebView | Server-authoritative | Same server contract |
| Customer cancellation lock after assignment | Server-authoritative | Same server contract through WebView | Receives cancellation event | Receives cancellation event |
| Driver alert readiness and lock-screen alerts | N/A | N/A | Browser/PWA alert path | OS permission, push, channel, and service preflight |
| Long Range preference and fee rules | Booking options | Booking options through WebView | Implemented | Implemented |
| Urdu-capable font shaping and RTL dynamic labels | Implemented | WebView uses the same shaped HTML | Implemented | Noto Naskh Arabic with native RTL labels |
| External-link and back-navigation behavior | Browser navigation | External links leave the WebView; back first traverses WebView history | Browser navigation | Native system navigation |

## Release interpretation

Every behavior is either shared through the server/web contract or explicitly
platform-specific above. Customer Native is no longer a missing-source release
gap; its supported implementation boundary is the Expo WebView shell plus the
native permission, safe-area, external-link, loading, and back-navigation
adapters.