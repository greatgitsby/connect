import * as Sentry from '@sentry/react';

import mbxGeocoding from '@mapbox/mapbox-sdk/services/geocoding';

import { stringifyQuery } from './query';

export const DEFAULT_LOCATION = {
  latitude: 32.711483,
  longitude: -117.161052,
};

export const MAPBOX_STYLE = 'mapbox://styles/commaai/cjj4yzqk201c52ss60ebmow0w';
export const MAPBOX_TOKEN = 'pk.eyJ1IjoiY29tbWFhaSIsImEiOiJjangyYXV0c20wMGU2NDluMWR4amUydGl5In0.6Vb11S6tdX6Arpj6trRE_g';

const geocodingClient = mbxGeocoding({ accessToken: MAPBOX_TOKEN });

export function getFilteredContexts(context) {
  const includeCtxs = ['region', 'district', 'place', 'locality', 'neighborhood'];
  return context.filter((ctx) => includeCtxs.some((c) => ctx.id.indexOf(c) !== -1));
}

function getContextString(context) {
  if (context.id.indexOf('region') !== -1 && context.short_code) {
    if (context.short_code.indexOf('US-') !== -1) {
      return context.short_code.substr(3);
    }
    return context.short_code;
  }
  return context.text;
}

function getContextMap(context) {
  const map = {};
  context.forEach((ctx) => {
    const key = ctx.id.split('.', 1)[0];
    map[key] = getContextString(ctx);
  });
  return map;
}

/**
 * Shorten street suffixes like "Street" to "St".
 * https://en.wikipedia.org/wiki/Street_or_road_name#Suffix_abbreviations
 *
 * Don't shorten:
 * - Bridge
 * - Embankment
 * - Gardens
 * - Gate
 * - Grove
 * - Hill
 * - Mall
 * - Row
 * - Square
 * - Terrace
 * - Walk
 * - Way
 */
const STREET_SUFFIXES = {
  Avenue: 'Ave',
  Boulevard: 'Blvd',
  Circle: 'Cir',
  Close: 'Cl',
  Court: 'Ct',
  Crescent: 'Cres',
  Drive: 'Dr',
  Expressway: 'Expy',
  Highway: 'Hwy',
  Lane: 'Ln',
  Place: 'Pl',
  Road: 'Rd',
  Street: 'St',
};

const STREET_DIRECTIONS = {
  North: 'N',
  Northeast: 'NE',
  East: 'E',
  Southeast: 'SE',
  South: 'S',
  Southwest: 'SW',
  West: 'W',
  Northwest: 'NW',
};

// shorten suffixes like "Street" to "St"
function shortenPlaceName(place) {
  const parts = place.split(' ');
  const newParts = [];

  let last = parts.pop();

  // Shorten direction, which can be at beginning or end of a street name
  const first = parts.shift();
  let direction = STREET_DIRECTIONS[first];
  if (direction) {
    parts.unshift(direction);
  } else {
    parts.unshift(first);

    direction = STREET_DIRECTIONS[last];
    if (direction) {
      newParts.push(direction);
      last = parts.pop();
    }
  }

  // Shorten suffix
  const suffix = STREET_SUFFIXES[last];
  if (suffix) {
    newParts.push(suffix);
  }

  parts.push(...newParts.reverse());
  return parts.join(' ');
}

export function priorityGetContext(contexts) {
  const priority = ['place', 'locality', 'district'];
  return priority.flatMap((prio) => contexts.filter((ctx) => ctx.id.indexOf(prio) !== -1))[0];
}

export async function reverseLookup(coords, navFormat = false) {
  if (geocodingClient === null || (coords[0] === 0 && coords[1] === 0)) {
    return null;
  }

  const endpoint = 'https://api.mapbox.com/geocoding/v5/mapbox.places/';
  const params = {
    access_token: MAPBOX_TOKEN,
    limit: 1,
  };

  let resp;
  try {
    resp = await fetch(`${endpoint}${coords[0]},${coords[1]}.json?${stringifyQuery(params)}`, {
      method: 'GET',
      cache: 'force-cache',
    });
    if (!resp.ok) {
      return null;
    }
  } catch (err) {
    console.error(err);
    return null;
  }

  try {
    const { features } = await resp.json();
    if (features.length && features[0].context) {
      if (navFormat) {
        // Used for navigation locations API (saving favorites)
        // Try to format location similarly to HERE, which is where the search results come from

        // e.g. Mapbox returns "Street", "Avenue", etc.
        const context = getContextMap(features[0].context);
        // e.g. "State St"
        const place = shortenPlaceName(features[0].text);
        // e.g. "San Diego, CA 92101, United States"

        let postcode;
        if (context.country === 'United Kingdom') {
          postcode = context.postcode;
        } else {
          postcode = `${context.region} ${context.postcode}`;
        }
        const details = `${context.place}, ${postcode}, ${context.country}`;

        return { place, details };
      }
      const contexts = getFilteredContexts(features[0].context);

      // Used for location name/area in drive list
      // e.g. "Little Italy"
      let place = '';
      // e.g. "San Diego, CA"
      let details = '';
      if (contexts.length > 0) {
        place = getContextString(contexts.shift());
      }
      if (contexts.length > 0) {
        details = getContextString(contexts.pop());
      }
      if (contexts.length > 0) {
        details = `${getContextString(priorityGetContext(contexts))}, ${details}`;
      }

      return { place, details };
    }
  } catch (err) {
    Sentry.captureException(err, { fingerprint: 'geocode_reverse_parse' });
  }

  return null;
}


const SEARCH_TYPES = 'poi,address,street,place,neighborhood,locality';
const SEARCHBOX_ROOT = 'https://api.mapbox.com/search/searchbox/v1/';

export const newSearchSession = () => crypto.randomUUID();

// Format Search Box context the way openpilot shows destinations: "66 Mint St, San Francisco, CA 94103".
// Falls back to the API's full address when the structured context is missing.
export function formatPlaceDetails(item) {
  const context = item.context || {};
  const street = item.address || context.address?.name || context.street?.name;
  const place = context.place?.name || context.locality?.name;
  const region = context.region?.region_code || context.region?.name;
  const postcode = context.postcode?.name;
  const country = context.country;
  if (!street && !place) {
    return item.full_address || item.place_formatted || '';
  }
  const parts = [];
  if (street && street !== item.name) parts.push(street);
  if (place) parts.push(place);
  const regionPostcode = [region, postcode].filter(Boolean).join(' ');
  if (regionPostcode) parts.push(regionPostcode);
  if (country?.name && country.country_code && country.country_code.toUpperCase() !== 'US') parts.push(country.name);
  return parts.join(', ');
}

/**
 * Autocomplete suggestions for the navigation search box (Mapbox Search Box API).
 * Suggestions carry no coordinates; call retrievePlace() with the same session token on selection.
 *
 * @param {string} query
 * @param {{ proximity?: [number, number] | null, limit?: number, sessionToken?: string, signal?: AbortSignal }} options
 * @returns {Promise<Array<{ id: string, name: string, details: string, kind: string, distance: number | null }>>}
 */
export async function searchPlaces(query, { proximity = null, limit = 5, sessionToken, signal } = {}) {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const params = {
    access_token: MAPBOX_TOKEN,
    q: trimmed,
    limit,
    types: SEARCH_TYPES,
    session_token: sessionToken || newSearchSession(),
  };
  if (proximity) {
    params.proximity = `${proximity[0]},${proximity[1]}`;
  }

  const resp = await fetch(`${SEARCHBOX_ROOT}suggest?${stringifyQuery(params)}`, { signal });
  if (!resp.ok) {
    throw new Error(`Search failed: ${resp.status}`);
  }

  const { suggestions = [] } = await resp.json();
  return suggestions.map((suggestion) => ({
    id: suggestion.mapbox_id,
    name: suggestion.name,
    details: formatPlaceDetails(suggestion),
    kind: suggestion.feature_type || 'place',
    // metres from the proximity point, when provided
    distance: typeof suggestion.distance === 'number' ? suggestion.distance / 1000 : null,
  }));
}

/**
 * Resolve a suggestion to coordinates.
 *
 * @param {string} id mapbox_id from searchPlaces()
 * @param {{ sessionToken?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ id: string, name: string, details: string, kind: string, latitude: number, longitude: number }>}
 */
export async function retrievePlace(id, { sessionToken, signal } = {}) {
  const params = { access_token: MAPBOX_TOKEN, session_token: sessionToken || newSearchSession() };
  const resp = await fetch(`${SEARCHBOX_ROOT}retrieve/${encodeURIComponent(id)}?${stringifyQuery(params)}`, { signal });
  if (!resp.ok) {
    throw new Error(`Place lookup failed: ${resp.status}`);
  }

  const { features = [] } = await resp.json();
  const feature = features[0];
  if (!feature?.geometry?.coordinates) {
    throw new Error('Place not found');
  }
  const props = feature.properties || {};
  return {
    id: props.mapbox_id || id,
    name: props.name || '',
    details: formatPlaceDetails(props),
    kind: props.feature_type || 'place',
    longitude: feature.geometry.coordinates[0],
    latitude: feature.geometry.coordinates[1],
  };
}

// Great-circle distance in kilometres between two [lng, lat] points.
export function distanceBetween(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
