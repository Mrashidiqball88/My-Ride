import type { RideRequest } from '../context/DriverRuntime';

// Accept Pakistani mobile numbers only; never turn arbitrary digits or text
// into a dialable number by stripping all non-digits.
export function passengerContactUrls(phone: unknown) {
  if (typeof phone !== 'string' && typeof phone !== 'number') return null;
  const compact = String(phone).trim().replace(/[\s().-]/g, '');
  const match = /^(?:\+?92|0092|0)?(3\d{9})$/.exec(compact);
  if (!match) return null;
  const whatsapp = `92${match[1]}`;
  return { tel: `+${whatsapp}`, whatsapp };
}

// Empty means omitted/unknown; null means explicit removal or conflicting IDs.
export function participantId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return '';
  const reference = value as { id?: unknown; _id?: unknown };
  const id = String(reference.id || '').trim();
  const mongoId = String(reference._id || '').trim();
  if (id && mongoId && id !== mongoId) return null;
  return id || mongoId;
}

export function ridePassengerId(ride: RideRequest | null | undefined): string | null {
  if (!ride) return null;
  const id = participantId(ride.passenger);
  return id === '' ? participantId(ride.contact) : id;
}

export function rideContactPhone(ride: RideRequest | null | undefined) {
  if (!ride || participantId(ride.passenger) === null) return '';
  const id = ridePassengerId(ride);
  const contactId = participantId(ride.contact);
  const contactMatches = contactId !== null && (!contactId || !id || contactId === id);
  for (const phone of [
    typeof ride.passenger === 'object' ? ride.passenger?.phone : undefined,
    contactMatches ? ride.passengerPhone : undefined,
    contactMatches ? ride.contactPhone : undefined,
    contactMatches ? ride.contact?.phone : undefined,
  ]) {
    const normalized = passengerContactUrls(phone);
    if (normalized) return normalized.tel;
  }
  return '';
}

export function mergeRideContact(ride: RideRequest, previousRide?: RideRequest | null): RideRequest {
  const previous = ride.id && ride.id === previousRide?.id ? previousRide : null;
  const previousId = ridePassengerId(previous);
  const freshPassengerId = participantId(ride.passenger);
  const freshContactId = participantId(ride.contact);
  const explicitRemoval = freshPassengerId === null;
  const id = freshPassengerId || (ride.passenger === undefined ? freshContactId : '') || previousId || '';
  const changed = explicitRemoval || (Boolean(id) && id !== previousId);
  const canPreserve = Boolean(previous) && !changed && previousId !== null;
  const contactMatches = !explicitRemoval && freshContactId !== null
    && (freshContactId ? freshContactId === id : !changed);
  const freshPassenger = ride.passenger && typeof ride.passenger === 'object'
    ? ride.passenger : null;
  // Strip all cached aliases first: spreading a ride must not carry the old
  // participant's unscoped phone/contact over an assignment change.
  const base = { ...(previous || {}), ...ride };
  delete base.passenger;
  delete base.passengerPhone;
  delete base.contact;
  delete base.contactPhone;
  if (explicitRemoval) return { ...base, passenger: null };
  const trustedContact = contactMatches ? ride.contact : undefined;
  const phone = passengerContactUrls(freshPassenger?.phone)?.tel
    || (contactMatches ? passengerContactUrls(trustedContact?.phone)?.tel : '')
    || (!changed && contactMatches ? passengerContactUrls(ride.passengerPhone)?.tel || passengerContactUrls(ride.contactPhone)?.tel : '')
    || (canPreserve ? rideContactPhone(previous) : '');
  const passenger = {
    ...(canPreserve && typeof previous?.passenger === 'object' ? previous.passenger : {}),
    ...(trustedContact || {}),
    ...(freshPassenger || {}),
    ...(id ? { id } : {}),
    ...(phone ? { phone } : {}),
  };
  delete passenger._id;
  if (!phone) delete passenger.phone;
  const contact = trustedContact || (canPreserve ? previous?.contact : undefined);
  return {
    ...base,
    ...(Object.keys(passenger).length ? { passenger } : {}),
    ...(contact && participantId(contact) !== null && (!participantId(contact) || participantId(contact) === id)
      ? { contact: { ...contact, ...(id ? { id } : {}), _id: undefined, ...(phone ? { phone } : {}) } } : {}),
    ...(phone ? { contactPhone: phone } : {}),
  };
}