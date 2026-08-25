import localforage from 'localforage';

import { athena as Athena } from '../api';

const MAX_RECENTS = 5;
let navStorage;
function storage() {
  if (navStorage === undefined) {
    try {
      navStorage = localforage.createInstance({ name: 'connect', storeName: 'nav_destinations' }) || null;
    } catch {
      navStorage = null;
    }
  }
  return navStorage;
}

const recentsKey = (dongleId) => `recent:${dongleId}`;

/**
 * Send a navigation destination to the device.
 *
 * @param {string} dongleId
 * @param {{ latitude: number, longitude: number, place_name: string, place_details: string }} destination
 */
export function setNavDestination(dongleId, destination) {
  const { latitude, longitude, place_name, place_details } = destination;
  return Athena.call(dongleId, 'setNavDestination', { latitude, longitude, place_name, place_details });
}

export async function getRecentDestinations(dongleId) {
  const recents = await Promise.resolve(storage()?.getItem(recentsKey(dongleId))).catch(() => null);
  return Array.isArray(recents) ? recents : [];
}

export async function addRecentDestination(dongleId, destination) {
  const recents = await getRecentDestinations(dongleId);
  const sameSpot = (d) => Math.abs(d.latitude - destination.latitude) < 1e-5 && Math.abs(d.longitude - destination.longitude) < 1e-5;
  const next = [destination, ...recents.filter((d) => !sameSpot(d))].slice(0, MAX_RECENTS);
  await Promise.resolve(storage()?.setItem(recentsKey(dongleId), next)).catch(() => {});
  return next;
}
