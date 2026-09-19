import React, { useEffect, useRef, useState } from 'react';

export default function AudioControls({ connection, isLandscape }) {
  const audioRef = useRef(null);
  const talkRef = useRef(null);
  const [muted, setMuted] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState(null);
  const stopRef = useRef(() => {});

  useEffect(() => {
    if (!connection) return undefined;
    let active = true;
    let held = false;
    const stop = () => {
      held = false;
      connection.setSpeaking(false);
      setSpeaking(false);
    };
    const start = async () => {
      if (muted || held) return;
      held = true;
      setError(null);
      try {
        await connection.prepareMicrophone();
        if (!active || !held) return;
        connection.setSpeaking(true);
        setSpeaking(true);
      } catch (err) {
        if (active) { stop(); setError(`Microphone: ${err.message}`); }
      }
    };
    stopRef.current = stop;
    const onKeyDown = (event) => {
      if (event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey
        || event.target?.closest?.('input, textarea, select, button, a, [contenteditable="true"], [role="textbox"]')) return;
      event.preventDefault();
      start();
    };
    const onKeyUp = (event) => { if (event.code === 'Space') stop(); };
    const onVisibility = () => { if (document.hidden) stop(); };
    const button = talkRef.current;
    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      start();
    };
    const onButtonKeyDown = (event) => {
      if ((event.code === 'Space' || event.code === 'Enter') && !event.repeat) { event.preventDefault(); start(); }
    };
    const onButtonKeyUp = (event) => {
      if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); stop(); }
    };
    button.addEventListener('pointerdown', onPointerDown);
    button.addEventListener('pointerup', stop);
    button.addEventListener('pointercancel', stop);
    button.addEventListener('lostpointercapture', stop);
    button.addEventListener('keydown', onButtonKeyDown);
    button.addEventListener('keyup', onButtonKeyUp);
    button.addEventListener('blur', stop);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      stop();
      button.removeEventListener('pointerdown', onPointerDown);
      button.removeEventListener('pointerup', stop);
      button.removeEventListener('pointercancel', stop);
      button.removeEventListener('lostpointercapture', stop);
      button.removeEventListener('keydown', onButtonKeyDown);
      button.removeEventListener('keyup', onButtonKeyUp);
      button.removeEventListener('blur', stop);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', onVisibility);
      connection.releaseMicrophone();
    };
  }, [connection, muted]);

  useEffect(() => {
    const audio = audioRef.current;
    const update = () => { audio.srcObject = connection?.remoteAudioStream || null; };
    update();
    const onError = (event) => { stopRef.current(); setError(event.detail); };
    connection?.addEventListener('audioerror', onError);
    connection?.addEventListener('audiochange', update);
    return () => {
      connection?.removeEventListener('audioerror', onError);
      connection?.removeEventListener('audiochange', update);
      connection?.setListening(false);
      audio.srcObject = null;
    };
  }, [connection]);

  const toggleListening = async () => {
    const enabled = !listening;
    setError(null);
    if (enabled && connection?.audioTransceiver?.currentDirection !== 'sendrecv') {
      setError('Audio is unavailable on this device.');
      return;
    }
    try {
      audioRef.current.muted = !enabled;
      if (enabled) await audioRef.current.play();
      connection?.setListening(enabled);
      setListening(enabled);
    } catch (err) { setError(`Audio playback: ${err.message}`); }
  };

  const buttonClass = 'rounded-xl px-3 py-2 min-h-[44px] bg-white/10 text-sm cursor-pointer disabled:opacity-40';
  return (
    <div className={`z-20 flex flex-wrap items-center gap-2 p-3 bg-glass-dark text-white ${isLandscape ? 'absolute top-16 left-3 rounded-2xl max-w-[calc(100%-24px)]' : 'shrink-0'}`}>
      <audio ref={audioRef} muted={!listening} />
      <button className={buttonClass} aria-pressed={listening} onClick={toggleListening}>
        {listening ? 'Mute device audio' : 'Listen'}
      </button>
      <button className={buttonClass} aria-pressed={muted} onClick={() => { stopRef.current(); setMuted(!muted); }}>
        {muted ? 'Unmute mic' : 'Mute mic'}
      </button>
      <button ref={talkRef} className={`${buttonClass} touch-none ${speaking ? 'bg-blue-600' : ''}`} disabled={muted} aria-pressed={speaking} aria-keyshortcuts="Space">
        {speaking ? 'Speaking…' : 'Hold to speak (Space)'}
      </button>
      {error && <span role="alert" className="w-full text-sm text-red-300">{error}</span>}
    </div>
  );
}
