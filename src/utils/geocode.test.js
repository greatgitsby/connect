import { afterEach, vi } from 'vitest';
import { distanceBetween, formatPlaceDetails, priorityGetContext, retrievePlace, reverseLookup, searchPlaces } from './geocode';

describe('priorityGetContext', () => {
  it('should return the first context with a priority', () => {
    const contexts = [
      { id: 'place.123' },
      { id: 'locality.123' },
      { id: 'district.123' },
    ];
    expect(priorityGetContext(contexts)).toEqual(contexts[0]);
  });
});

describe('reverseLookup', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('should return null if coords are [0, 0]', async () => {
    const result = await reverseLookup([0, 0]);
    expect(result).toBeNull();
  });

  it('should return place names', async () => {
    const locations = [
      ['E Market Street', 'San Diego', 'CA', '92101', 'United States'],
      ['W Laurel Street', 'San Diego', 'CA', '92101', 'United States'],
      ['Fleet Street', 'London', '', 'EC4A 2BJ', 'United Kingdom'],
      ['Montpellier Drive', 'Cheltenham', '', 'GL50 1SD', 'United Kingdom'],
    ];
    vi.stubGlobal('fetch', vi.fn(async () => {
      const [text, place, region, postcode, country] = locations.shift();
      return {
        ok: true,
        json: async () => ({
          features: [{
            text,
            context: [
              { id: 'place.1', text: place },
              { id: 'region.1', short_code: region ? `US-${region}` : undefined, text: region },
              { id: 'postcode.1', text: postcode },
              { id: 'country.1', text: country },
            ],
          }],
        }),
      };
    }));

    expect(await reverseLookup([-117.12547, 32.71137], true)).toEqual({
      details: expect.stringMatching(/^San Diego, CA \d{5}, United States$/),
      place: 'E Market St',
    });
    expect(await reverseLookup([-117.166409, 32.731369], true)).toEqual({
      details: expect.stringMatching(/^San Diego, CA \d{5}, United States$/),
      place: 'W Laurel St',
    });
    // expect(await reverseLookup([-77.036551, 38.898104], true)).toEqual({
    //   details: 'Washington, DC 20500, United States',
    //   place: 'White House Lawn',
    // });
    expect(await reverseLookup([-0.106640, 51.514209], true)).toEqual({
      details: expect.stringMatching(/^London, EC4A 2B[A-Z], United Kingdom$/),
      place: 'Fleet St',
    });
    expect(await reverseLookup([-2.076843, 51.894799], true)).toEqual({
      details: expect.stringMatching(/^Cheltenham, GL50 1[A-Z]{2}, United Kingdom$/),
      place: 'Montpellier Dr',
    });
  });
});

describe('searchPlaces', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns nothing for a blank query without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await searchPlaces('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps search box suggestions with proximity bias and session token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      suggestions: [
        {
          mapbox_id: 'poi.1', name: 'Blue Bottle Coffee', feature_type: 'poi', distance: 3300,
          full_address: '66 Mint St, San Francisco, California 94103, United States', address: '66 Mint St',
          context: { country: { name: 'United States', country_code: 'us' }, region: { name: 'California', region_code: 'CA' }, postcode: { name: '94103' }, place: { name: 'San Francisco' }, address: { name: '66 Mint St' } },
        },
        { mapbox_id: 'street.2', name: 'Bluxome St', feature_type: 'street', place_formatted: 'San Francisco, California, United States' },
      ],
    })));
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchPlaces('blue', { proximity: [-122.44, 37.77], sessionToken: 'session-1' });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/search/searchbox/v1/suggest');
    expect(url.searchParams.get('q')).toBe('blue');
    expect(url.searchParams.get('proximity')).toBe('-122.44,37.77');
    expect(url.searchParams.get('session_token')).toBe('session-1');
    expect(results).toEqual([
      { id: 'poi.1', name: 'Blue Bottle Coffee', details: '66 Mint St, San Francisco, CA 94103', kind: 'poi', distance: 3.3 },
      { id: 'street.2', name: 'Bluxome St', details: 'San Francisco, California, United States', kind: 'street', distance: null },
    ]);
  });

  it('throws on a failed response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(searchPlaces('blue')).rejects.toThrow('Search failed: 500');
  });
});

describe('retrievePlace', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resolves a suggestion to coordinates', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      features: [{
        geometry: { coordinates: [-122.4014, 37.7909] },
        properties: { mapbox_id: 'poi.1', name: 'Blue Bottle Coffee', feature_type: 'poi', full_address: '66 Mint St, San Francisco, California 94103, United States' },
      }],
    })));
    vi.stubGlobal('fetch', fetchMock);
    const place = await retrievePlace('poi.1', { sessionToken: 'session-1' });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/search/searchbox/v1/retrieve/poi.1');
    expect(url.searchParams.get('session_token')).toBe('session-1');
    expect(place).toEqual({
      id: 'poi.1', name: 'Blue Bottle Coffee', details: '66 Mint St, San Francisco, California 94103, United States',
      kind: 'poi', latitude: 37.7909, longitude: -122.4014,
    });
  });

  it('throws when the place has no geometry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: [] }))));
    await expect(retrievePlace('poi.1')).rejects.toThrow('Place not found');
  });
});

describe('formatPlaceDetails', () => {
  it('keeps the country for non-US places and omits the street when it is the name', () => {
    expect(formatPlaceDetails({
      name: 'Fleet Street',
      context: { country: { name: 'United Kingdom', country_code: 'gb' }, place: { name: 'London' }, postcode: { name: 'EC4A 2BJ' }, street: { name: 'Fleet Street' } },
    })).toBe('London, EC4A 2BJ, United Kingdom');
  });

  it('falls back to the full address without context', () => {
    expect(formatPlaceDetails({ full_address: 'Somewhere, Earth' })).toBe('Somewhere, Earth');
  });
});

describe('distanceBetween', () => {
  it('measures great-circle distance in km', () => {
    // San Francisco -> San Diego, roughly 737 km
    expect(distanceBetween([-122.4194, 37.7749], [-117.1611, 32.7157])).toBeCloseTo(737, -1);
    expect(distanceBetween([0, 0], [0, 0])).toBe(0);
  });
});
