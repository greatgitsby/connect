import { athena as Athena } from '../api';

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
