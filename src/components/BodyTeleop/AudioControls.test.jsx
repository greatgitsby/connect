import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import AudioControls from './AudioControls';

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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


it('suppresses return audio through speech and its echo tail without changing the mute preference', async () => {
  vi.useFakeTimers();
  const conn = connection();
  const view = render(<AudioControls connection={conn} />);
  const audio = view.container.querySelector('audio');
  await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }); });
  expect(audio.muted).toBe(true);
  expect(conn.setListening).toHaveBeenLastCalledWith(false);
  fireEvent.keyUp(document.body, { code: 'Space' });
  act(() => vi.advanceTimersByTime(599));
  expect(audio.muted).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(audio.muted).toBe(false);
  expect(conn.setListening).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Mute device microphone' }));
  await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }); });
  fireEvent.keyUp(document.body, { code: 'Space' });
  act(() => vi.advanceTimersByTime(600));
  expect(audio.muted).toBe(true);
  expect(conn.setListening).toHaveBeenLastCalledWith(false);
});

it('does not resume return audio during another press or after unmount', async () => {
  vi.useFakeTimers();
  const conn = connection();
  const view = render(<AudioControls connection={conn} />);
  await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }); });
  fireEvent.keyUp(document.body, { code: 'Space' });
  act(() => vi.advanceTimersByTime(300));
  await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }); });
  act(() => vi.advanceTimersByTime(600));
  expect(conn.setListening).toHaveBeenLastCalledWith(false);
  fireEvent.keyUp(document.body, { code: 'Space' });
  view.unmount();
  conn.setListening.mockClear();
  act(() => vi.advanceTimersByTime(600));
  expect(conn.setListening).not.toHaveBeenCalled();
});
