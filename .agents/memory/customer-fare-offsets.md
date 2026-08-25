---
name: Customer fare offsets
description: How Customer fare controls combine with Admin-calculated quotes.
---

Customer price changes are represented as a bounded `customerFareOffset`; the ride’s final fare is always the authoritative Admin quote plus that offset. The zero-offset state must restore the exact quote, including when it is not divisible by the UI’s Rs 10 adjustment increment.

**Why:** Treating a Customer adjustment as a replacement total obscures the Admin-calculated baseline and can round a reset value away from the quote.

**How to apply:** New clients send the offset and calculate their display from quote plus offset. Continue accepting legacy total-offer payloads at the API boundary, but convert them to an offset before persistence.