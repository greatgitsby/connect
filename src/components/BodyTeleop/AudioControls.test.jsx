import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import AudioControls from './AudioControls';

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

function connection() {
  return Object.assign(new EventTarget(), {
    prepareMicrophone: vi.fn().mockResolvedValue(), setSpeaking: vi.fn(),
    releaseMicrophone: vi.fn(), setListening: vi.fn(),
    audioTransceiver: { currentDirection: 'sendrecv' },
  });
}

it('holds Space to talk and stops on release or window blur', async () => {
  const conn = connection();
  render(<AudioControls connection={conn} />);
  await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }); });
  expect(conn.setSpeaking).toHaveBeenLastCalledWith(true);
  fireEvent.keyUp(document.body, { code: 'Space' });
  expect(conn.setSpeaking).toHaveBeenLastCalledWith(false);
  await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }); });
  fireEvent.blur(window);
  expect(conn.setSpeaking).toHaveBeenLastCalledWith(false);
});

it('does not start after release while microphone permission is pending', async () => {
  const conn = connection();
  let grant;
  conn.prepareMicrophone.mockReturnValue(new Promise((resolve) => { grant = resolve; }));
  render(<AudioControls connection={conn} />);
  fireEvent.keyDown(document.body, { code: 'Space' });
  fireEvent.keyUp(document.body, { code: 'Space' });
  await act(async () => { grant(); });
  expect(conn.setSpeaking).not.toHaveBeenCalledWith(true);
});

it('listens by default and device mute does not disable push-to-talk', async () => {
  const conn = connection();
  render(<AudioControls connection={conn} />);
  expect(conn.setListening).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Mute device microphone' }));
  expect(conn.setListening).toHaveBeenLastCalledWith(false);
  await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }); });
  expect(conn.setSpeaking).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: 'Hold to speak' })).toBeEnabled();
  expect(screen.queryByText('Mute mic')).not.toBeInTheDocument();
});

it('Space still works after a toolbar button receives focus', async () => {
  const conn = connection();
  render(<AudioControls connection={conn} />);
  const button = screen.getByRole('button', { name: 'Mute device microphone' });
  button.focus();
  await act(async () => { fireEvent.keyDown(button, { code: 'Space' }); });
  expect(conn.setSpeaking).toHaveBeenLastCalledWith(true);
  fireEvent.keyUp(button, { code: 'Space' });
  expect(conn.setSpeaking).toHaveBeenLastCalledWith(false);
});

it('shows a playback action if autoplay is blocked and retries on click', async () => {
  const conn = connection();
  conn.remoteAudioStream = {};
  HTMLMediaElement.prototype.play.mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'));
  await act(async () => { render(<AudioControls connection={conn} />); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play device audio' })); });
  expect(screen.getByRole('button', { name: 'Mute device microphone' })).toBeInTheDocument();
  expect(conn.setListening).toHaveBeenLastCalledWith(true);
});

it('ignores Space in text fields and releases the microphone on unmount', async () => {
  const conn = connection();
  const view = render(<><input aria-label="Message" /><AudioControls connection={conn} /></>);
  await act(async () => { fireEvent.keyDown(screen.getByLabelText('Message'), { code: 'Space' }); });
  expect(conn.prepareMicrophone).not.toHaveBeenCalled();
  view.unmount();
  expect(conn.releaseMicrophone).toHaveBeenCalled();
  expect(conn.setListening).toHaveBeenLastCalledWith(false);
});

it('reports permission errors without starting transmission', async () => {
  const conn = connection();
  conn.prepareMicrophone.mockRejectedValue(new Error('Permission denied'));
  render(<AudioControls connection={conn} />);
  await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }); });
  expect(screen.getByRole('alert')).toHaveTextContent('Permission denied');
  expect(conn.setSpeaking).not.toHaveBeenCalledWith(true);
});

it('smoothly lowers playback during speech and restores it without changing device mute', async () => {
  let now = 0;
  let nextId = 0;
  const frames = new Map();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    nextId += 1;
    frames.set(nextId, callback);
    return nextId;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => frames.delete(id));
  const advance = (ms) => {
    now += ms;
    const callbacks = [...frames.values()];
    frames.clear();
    act(() => callbacks.forEach((callback) => callback(now)));
  };
  const conn = connection();
  const view = render(<AudioControls connection={conn} />);
  const audio = view.container.querySelector('audio');
  conn.setListening.mockClear();
  await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }); });
  advance(40);
  expect(audio.volume).toBeCloseTo(0.625);
  advance(40);
  expect(audio.volume).toBeCloseTo(0.25);
  expect(audio.muted).toBe(false);
  expect(conn.setListening).not.toHaveBeenCalled();
  fireEvent.keyUp(document.body, { code: 'Space' });
  advance(120);
  expect(audio.volume).toBeCloseTo(0.625);
  // A quick second press reverses the fade from the current level.
  await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }); });
  advance(80);
  expect(audio.volume).toBeCloseTo(0.25);
  fireEvent.click(screen.getByRole('button', { name: 'Mute device microphone' }));
  fireEvent.blur(window);
  advance(240);
  expect(audio.volume).toBe(1);
  expect(audio.muted).toBe(true);
  view.unmount();
  expect(frames.size).toBe(0);
});
