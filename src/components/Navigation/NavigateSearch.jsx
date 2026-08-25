import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Sentry from '@sentry/react';

import { addRecentDestination, getRecentDestinations, setNavDestination } from '../../api/navigation';
import { analyticsEvent } from '../../actions';
import { distanceBetween, newSearchSession, retrievePlace, searchPlaces } from '../../utils/geocode';
import { isMetric, KM_PER_MI } from '../../utils/conversions';

const SEARCH_DEBOUNCE_MS = 150;
const SENT_DISMISS_MS = 1200;

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-[18px] w-[18px] shrink-0 text-white/60" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
  </svg>
);
const ClockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-[15px] w-[15px]" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
);
const PinIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-[15px] w-[15px]" aria-hidden="true">
    <path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" />
  </svg>
);
const NavIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M12 2 4.5 21l7.5-4 7.5 4z" />
  </svg>
);
const CloseIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={className} aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

function formatDistance(km) {
  if (isMetric()) {
    return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
  }
  const mi = km / KM_PER_MI;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

function highlight(text, query) {
  const q = query.trim();
  const idx = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-bold text-white">{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </>
  );
}

function friendlyError(err) {
  const message = err?.message || '';
  if (message.includes('Device not registered')) return 'Device is offline';
  if (message.includes('Method not found')) return 'This device does not support navigation yet';
  return message || 'Could not send destination';
}

/**
 * Search field + suggestions + confirm card that sits on top of the device map.
 *
 * The parent owns the selected destination so it can draw the pin and fit the viewport;
 * this component owns the query, suggestions and the send lifecycle.
 */
export default function NavigateSearch({
  dongleId, deviceName, deviceOnline, carLocation, destination, onSelect, onClose, onSent, dispatch, cardRef,
}) {
  const [query, setQuery] = useState(destination?.name || '');
  const [results, setResults] = useState([]);
  const [recents, setRecents] = useState([]);
  const [listOpen, setListOpen] = useState(!destination);
  const [activeIdx, setActiveIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [sendState, setSendState] = useState('idle'); // idle | sending | sent
  const [sendError, setSendError] = useState(null);

  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const mountedRef = useRef(true);
  const sentTimerRef = useRef(null);
  // One Search Box billing session per suggest→retrieve cycle.
  const sessionRef = useRef(newSearchSession());

  useEffect(() => {
    mountedRef.current = true;
    inputRef.current?.focus();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (sentTimerRef.current) clearTimeout(sentTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getRecentDestinations(dongleId).then((items) => {
      if (!cancelled) setRecents(items);
    });
    return () => { cancelled = true; };
  }, [dongleId]);

  // Debounced, abortable search whenever the query changes without a selection.
  useEffect(() => {
    abortRef.current?.abort();
    if (destination || !query.trim()) {
      setResults([]);
      setSearching(false);
      setSearchError(null);
      return undefined;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const items = await searchPlaces(query, { proximity: carLocation, sessionToken: sessionRef.current, signal: controller.signal });
        if (controller.signal.aborted || !mountedRef.current) return;
        setResults(items);
        setSearchError(null);
        setActiveIdx(0);
      } catch (err) {
        if (controller.signal.aborted || !mountedRef.current) return;
        setResults([]);
        setSearchError('Search is unavailable right now');
        Sentry.captureException(err, { fingerprint: 'nav_search_places' });
      } finally {
        if (!controller.signal.aborted && mountedRef.current) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, destination, carLocation]);

  const showingRecents = !query.trim();
  const items = useMemo(() => (showingRecents ? recents : results), [showingRecents, recents, results]);
  const listVisible = listOpen && !destination && (items.length > 0 || (!showingRecents && !searching) || searchError);

  const distance = useMemo(() => {
    if (!destination || !carLocation) return null;
    return distanceBetween(carLocation, [destination.longitude, destination.latitude]);
  }, [destination, carLocation]);

  const select = useCallback(async (item, source) => {
    let place = item;
    if (typeof item.latitude !== 'number' || typeof item.longitude !== 'number') {
      setResolving(true);
      try {
        place = await retrievePlace(item.id, { sessionToken: sessionRef.current });
        sessionRef.current = newSearchSession();
      } catch (err) {
        if (!mountedRef.current) return;
        setResolving(false);
        setSearchError('Could not load that place');
        Sentry.captureException(err, { fingerprint: 'nav_retrieve_place' });
        return;
      }
      if (!mountedRef.current) return;
      setResolving(false);
    }
    setQuery(place.name);
    setListOpen(false);
    setSendError(null);
    setSendState('idle');
    onSelect(place);
    dispatch(analyticsEvent('nav_search_select', { source }));
  }, [onSelect, dispatch]);

  const clear = useCallback(() => {
    setQuery('');
    setResults([]);
    setSendError(null);
    setSendState('idle');
    setListOpen(true);
    onSelect(null);
    inputRef.current?.focus();
  }, [onSelect]);

  const onInput = (ev) => {
    setQuery(ev.target.value);
    setListOpen(true);
    if (destination) onSelect(null);
  };

  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (destination) clear();
      else onClose();
      return;
    }
    if (!listVisible || !items.length || resolving) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (items[activeIdx]) select(items[activeIdx], showingRecents ? 'recent' : 'search');
    }
  };

  const send = async () => {
    if (!destination || !deviceOnline || sendState !== 'idle') return;
    setSendState('sending');
    setSendError(null);
    dispatch(analyticsEvent('nav_set_destination', { has_car_location: Boolean(carLocation) }));
    try {
      await setNavDestination(dongleId, {
        latitude: destination.latitude,
        longitude: destination.longitude,
        place_name: destination.name,
        place_details: destination.details,
      });
      if (!mountedRef.current) return;
      addRecentDestination(dongleId, destination).then((next) => { if (mountedRef.current) setRecents(next); });
      setSendState('sent');
      sentTimerRef.current = setTimeout(() => { if (mountedRef.current) onSent(destination); }, SENT_DISMISS_MS);
    } catch (err) {
      if (!mountedRef.current) return;
      setSendState('idle');
      setSendError(friendlyError(err));
      if (!err?.message?.includes('Device not registered')) {
        console.error(err);
        Sentry.captureException(err, { fingerprint: 'nav_set_destination' });
      }
    }
  };

  const sendDisabled = !deviceOnline || sendState !== 'idle';
  const sendLabel = { idle: 'Navigate', sending: 'Sending…', sent: 'Sent' }[sendState];

  return (
    <div className="pointer-events-none absolute inset-0 z-[4] flex flex-col justify-between p-2.5" data-testid="navigate-search">
      <div className="pointer-events-auto relative w-full max-w-[420px]">
        <div className="flex h-11 items-center gap-2.5 rounded-xl border border-white/10 bg-[#1e2224] px-3 shadow-[0_8px_30px_rgba(0,0,0,.35)] focus-within:border-white/30">
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Navigate to"
            aria-expanded={Boolean(listVisible)}
            aria-controls="navigate-suggestions"
            aria-autocomplete="list"
            aria-activedescendant={listVisible && items[activeIdx] ? `navigate-option-${activeIdx}` : undefined}
            autoComplete="off"
            spellCheck="false"
            placeholder="Search for a place or address"
            className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/40"
            value={query}
            onChange={onInput}
            onKeyDown={onKeyDown}
            onFocus={() => setListOpen(true)}
          />
          {(query || destination) ? (
            <button
              type="button"
              aria-label="Clear"
              onClick={clear}
              className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
            >
              <CloseIcon className="h-3 w-3" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-[5px] border border-white/10 px-[5px] text-[11px] text-white/40 hover:text-white"
            >
              esc
            </button>
          )}
        </div>
        {listVisible && (
          <div
            id="navigate-suggestions"
            role="listbox"
            className="absolute inset-x-0 top-[calc(100%+6px)] overflow-hidden rounded-xl border border-white/10 bg-[#1e2224] shadow-[0_16px_40px_rgba(0,0,0,.5)]"
          >
            {showingRecents && items.length > 0 && (
              <div className="px-3.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[.06em] text-white/40">Recent</div>
            )}
            {items.map((item, idx) => {
              const km = item.distance ?? ((carLocation && typeof item.latitude === 'number') ? distanceBetween(carLocation, [item.longitude, item.latitude]) : null);
              return (
                <button
                  key={item.id || `${item.latitude},${item.longitude}`}
                  id={`navigate-option-${idx}`}
                  type="button"
                  role="option"
                  aria-selected={idx === activeIdx}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onMouseDown={(ev) => ev.preventDefault()}
                  disabled={resolving}
                  onClick={() => select(item, showingRecents ? 'recent' : 'search')}
                  className={`flex w-full items-center gap-3 px-3.5 py-2 text-left ${idx === activeIdx ? 'bg-white/8' : ''}`}
                >
                  <span className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-white/8 ${showingRecents ? 'text-white/40' : 'text-white/60'}`}>
                    {showingRecents ? <ClockIcon /> : <PinIcon />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{highlight(item.name, showingRecents ? '' : query)}</span>
                    <span className="block truncate text-[11.5px] text-white/60">{item.details}</span>
                  </span>
                  {km !== null && <span className="shrink-0 text-[11px] tabular-nums text-white/40">{formatDistance(km)}</span>}
                </button>
              );
            })}
            {!showingRecents && !searching && !items.length && (
              <div className="px-3.5 py-4 text-[13px] text-white/60">
                {searchError || `No places match "${query.trim()}".`}
              </div>
            )}
            <div className="flex justify-between border-t border-white/5 px-3.5 pb-2 pt-1.5 text-[10px] text-white/40">
              <span>{resolving ? 'Loading place…' : '↑↓ to choose · ↵ to select'}</span>
              <span>Search by Mapbox</span>
            </div>
          </div>
        )}
      </div>

      {destination && (
        <div className="flex justify-end">
          <div
            ref={cardRef}
            className="pointer-events-auto flex w-full max-w-[560px] flex-wrap items-center gap-3 rounded-[14px] border border-white/10 bg-[#1e2224]/95 py-3 pl-3.5 pr-3 shadow-[0_12px_40px_rgba(0,0,0,.45)] backdrop-blur-lg"
            data-testid="navigate-destination"
          >
            <div className={`grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full ${deviceOnline ? 'bg-[#22c967]' : 'bg-[#303639]'}`}>
              <NavIcon className="h-[18px] w-[18px] text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-medium leading-tight">{destination.name}</div>
              <div className="truncate text-xs text-white/60">{destination.details}</div>
              {distance !== null && (
                <div className="mt-0.5 text-xs tabular-nums text-white/40">{`${formatDistance(distance)} from ${deviceName}`}</div>
              )}
            </div>
            <button
              type="button"
              aria-label="Clear destination"
              onClick={clear}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white xs:order-last"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
            <div className="flex shrink-0 items-center gap-2 max-xs:w-full">
              {(!deviceOnline || sendError) && (
                <span className="flex items-center gap-1.5 text-xs text-[#ff8a80]" role="status">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
                  {sendError || `${deviceName} is offline`}
                </span>
              )}
              <button
                type="button"
                onClick={send}
                disabled={sendDisabled}
                className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-full px-[18px] text-[13px] font-medium max-xs:flex-1 ${
                  sendState === 'sent' ? 'bg-[#22c967] text-white' : 'bg-white text-[#1e2224] hover:bg-[#eee] disabled:bg-white/8 disabled:text-white/40'
                }`}
              >
                {sendState === 'sending' && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-black/20 border-t-[#1e2224]" />}
                {sendLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
