import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import AudioControls from './AudioControls';

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

it('mute prevents Space from opening or sending the microphone', async () => {
  const conn = connection();
  render(<AudioControls connection={conn} />);
  fireEvent.click(screen.getByText('Mute mic'));
  await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }); });
  expect(conn.prepareMicrophone).not.toHaveBeenCalled();
  expect(screen.getByText('Hold to speak (Space)')).toBeDisabled();
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
