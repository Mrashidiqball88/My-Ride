---
name: Ride preference fee policy
description: Explains the business invariant tying Driver ride preferences to Daily Fee charging and ride eligibility.
---

`Long Range Only` Drivers are permanently exempt from the standard Daily Fee. They must also be excluded from local-ride matching so the exemption cannot be used while continuing to receive local work. `Short Range Only` and `Both` retain the normal Daily Fee cycle; `Short Range Only` is excluded from Long Range matching.

**Why:** The Daily Fee funds the short-range service. Exempting a Driver while still allowing local rides would violate the stated pricing policy.

**How to apply:** Keep the exemption in the shared Daily Fee charge routine and scheduled sweep, and apply the same preference rule to every local/Long Range matching and recovery path. Treat a missing legacy preference as `Both`.