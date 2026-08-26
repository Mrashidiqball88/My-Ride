# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: fare-flow-live.spec.js >> live Mongo fare refresh >> removes a cancelled request and activates the winning Driver without a refresh
- Location: tests/fare-flow-live.spec.js:572:3

# Error details

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0

Call Log:
- Timeout 5000ms exceeded while waiting on the predicate
```

# Test source

```ts
  498 |         activeRide: !!activeRide
  499 |       }))).toEqual({ pendingRide: false, sentOffer: false, activeRide: false });
  500 |       await expect.poll(async () => {
  501 |         const available = await highroofPage.evaluate(async () => {
  502 |           const response = await fetch('/api/rides/available', {
  503 |             headers: {
  504 |               authorization: `Bearer ${localStorage.getItem('rh_token')}`,
  505 |               'x-session-token': localStorage.getItem('rh_session')
  506 |             }
  507 |           });
  508 |           return response.json();
  509 |         });
  510 |         return available.some(availableRide => String(availableRide._id) === String(ride._id));
  511 |       }).toBe(false);
  512 |       await expect(coasterPage.locator('#ride-request')).toBeHidden();
  513 |     } finally {
  514 |       await Promise.all([highroofPage.close(), coasterPage.close()]);
  515 |       await request.dispose();
  516 |     }
  517 |   });
  518 | 
  519 |   test('blocks an unrelated driver from reading a ride they do not own', async ({ playwright }) => {
  520 |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  521 |     const request = await playwright.request.newContext({ baseURL });
  522 |     try {
  523 |       const heartbeat = new Date();
  524 |       await models.User.updateOne({ _id: matchingDriver._id }, {
  525 |         $set: { isOnline: true, lastOnlineHeartbeat: heartbeat, currentLocation: { lat: 1, lng: 2 } }
  526 |       });
  527 |       await models.User.updateOne({ _id: otherDriver._id }, {
  528 |         $set: {
  529 |           isOnline: true,
  530 |           vehicleType: 'Car Mini',
  531 |           lastOnlineHeartbeat: heartbeat,
  532 |           currentLocation: { lat: 40, lng: 40 }
  533 |         }
  534 |       });
  535 |       const created = await request.post('/api/rides', {
  536 |         headers: authHeaders(customer),
  537 |         data: {
  538 |           pickupLocation: { lat: 1, lng: 2, address: 'Private pickup' },
  539 |           dropoffLocation: { lat: 3, lng: 4, address: 'Private dropoff' },
  540 |           distance: 7,
  541 |           vehicleType: 'Car Mini',
  542 |           fare: 1
  543 |         }
  544 |       });
  545 |       expect(created.status()).toBe(201);
  546 |       const ride = await created.json();
  547 | 
  548 |       const unrelatedRead = await request.get(`/api/rides/${ride._id}`, {
  549 |         headers: authHeaders(otherDriver)
  550 |       });
  551 |       expect(unrelatedRead.status()).toBe(403);
  552 | 
  553 |       const unrelatedAcceptance = await request.patch(`/api/rides/${ride._id}/accept`, {
  554 |         headers: authHeaders(otherDriver)
  555 |       });
  556 |       expect(unrelatedAcceptance.status()).toBe(409);
  557 | 
  558 |       const notifiedAcceptance = await request.patch(`/api/rides/${ride._id}/accept`, {
  559 |         headers: authHeaders(matchingDriver)
  560 |       });
  561 |       expect(notifiedAcceptance.status()).toBe(200);
  562 | 
  563 |       const passengerRead = await request.get(`/api/rides/${ride._id}`, {
  564 |         headers: authHeaders(customer)
  565 |       });
  566 |       expect(passengerRead.status()).toBe(200);
  567 |     } finally {
  568 |       await request.dispose();
  569 |     }
  570 |   });
  571 | 
  572 |   test('removes a cancelled request and activates the winning Driver without a refresh', async ({ browser, playwright }) => {
  573 |     const customerToken = token(customer);
  574 |     const matchingToken = token(matchingDriver);
  575 |     const baseURL = `http://127.0.0.1:${httpServer.address().port}`;
  576 |     const request = await playwright.request.newContext({ baseURL });
  577 |     const driverPage = await browser.newPage();
  578 | 
  579 |     async function createRide(label) {
  580 |       const response = await request.post('/api/rides', {
  581 |         headers: authHeaders(customer),
  582 |         data: {
  583 |           pickupLocation: { lat: 1, lng: 2, address: `${label} pickup` },
  584 |           dropoffLocation: { lat: 3, lng: 4, address: `${label} dropoff` },
  585 |           distance: 7,
  586 |           vehicleType: 'Car Mini',
  587 |           fare: 1
  588 |         }
  589 |       });
  590 |       expect(response.status()).toBe(201);
  591 |       return response.json();
  592 |     }
  593 | 
  594 |     try {
  595 |       await openAuthenticatedClient(driverPage, baseURL, '/driver', matchingDriver, matchingToken);
  596 |       await driverPage.evaluate(() => toggleOnline(true));
  597 |       await expect.poll(() => driverPage.evaluate(() => isOnline)).toBe(true);
> 598 |       await expect.poll(() => io.sockets.adapter.rooms.get('drivers:Car Mini')?.size || 0).toBeGreaterThan(0);
      |                                                                                            ^ Error: expect(received).toBeGreaterThan(expected)
  599 | 
  600 |       const cancelledRide = await createRide('Instant cancellation');
  601 |       await expect(driverPage.locator('#ride-request')).toBeVisible();
  602 |       // Browser automation does not grant notification/audio activation by
  603 |       // default. Start the same request alert explicitly so cancellation
  604 |       // verifies the cleanup path for an already-alerting offer.
  605 |       await driverPage.evaluate(() => startRideAlert(pendingRide));
  606 |       await expect.poll(() => driverPage.evaluate(rideId => ({
  607 |         pending: String(pendingRide?.id || pendingRide?._id) === String(rideId),
  608 |         alerting: !!alertInterval
  609 |       }), cancelledRide._id)).toEqual({ pending: true, alerting: true });
  610 | 
  611 |       const cancelled = await request.patch(`/api/rides/${cancelledRide._id}/cancel`, {
  612 |         headers: authHeaders(customer)
  613 |       });
  614 |       expect(cancelled.status()).toBe(200);
  615 |       await expect(driverPage.locator('#ride-request')).toBeHidden();
  616 |       await expect.poll(() => driverPage.evaluate(() => ({
  617 |         pendingRide: !!pendingRide,
  618 |         sentOffer: !!sentOffer,
  619 |         alertInterval: !!alertInterval,
  620 |         notification: !!rideNotification
  621 |       }))).toEqual({ pendingRide: false, sentOffer: false, alertInterval: false, notification: false });
  622 | 
  623 |       const acceptedRide = await createRide('Instant acceptance');
  624 |       await expect(driverPage.locator('#ride-request')).toBeVisible();
  625 |       const accepted = await request.patch(`/api/rides/${acceptedRide._id}/accept`, {
  626 |         headers: authHeaders(matchingDriver)
  627 |       });
  628 |       expect(accepted.status()).toBe(200);
  629 |       await expect(driverPage.locator('#ride-request')).toBeHidden();
  630 |       await expect(driverPage.locator('#active-panel')).toBeVisible();
  631 |       await expect.poll(() => driverPage.evaluate(rideId =>
  632 |         String(activeRide?._id) === String(rideId), acceptedRide._id
  633 |       )).toBe(true);
  634 |     } finally {
  635 |       await driverPage.close();
  636 |       await request.dispose();
  637 |     }
  638 |   });
  639 | });
```