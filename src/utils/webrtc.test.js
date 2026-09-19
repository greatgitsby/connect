import { WebRTCConnection } from './webrtc';
vi.mock('../api', () => ({ athena: {} }));

function audioConnection() {
  const conn = new WebRTCConnection({});
  conn.audioTransceiver = { currentDirection: 'sendrecv', sender: { replaceTrack: vi.fn().mockResolvedValue() } };
  const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stop: vi.fn() });
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  return { conn, track, stream };
}

afterEach(() => { vi.unstubAllGlobals(); });

it('only enables captured audio while speaking', async () => {
  const { conn, track, stream } = audioConnection();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  await conn.prepareMicrophone();
  expect(track.enabled).toBe(false);
  conn.setSpeaking(true);
  expect(track.enabled).toBe(true);
  conn.setSpeaking(false);
  expect(track.enabled).toBe(false);
  conn.releaseMicrophone();
  expect(track.stop).toHaveBeenCalled();
});

it('stops late microphone permission results after cleanup', async () => {
  const { conn, track, stream } = audioConnection();
  let grant;
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) } });
  const request = conn.prepareMicrophone();
  conn.cleanup();
  grant(stream);
  await request;
  expect(track.stop).toHaveBeenCalled();
  expect(track.enabled).toBe(false);
  expect(conn.microphoneStream).toBeNull();
});

it('shares an in-flight permission request', async () => {
  const { conn, stream } = audioConnection();
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  await Promise.all([conn.prepareMicrophone(), conn.prepareMicrophone()]);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
});

it('remembers listening preference until the data channel opens', () => {
  const { conn } = audioConnection();
  conn.videoEnabled = true;
  conn.setListening(false);
  conn.dc = { readyState: 'open', send: vi.fn() };
  conn._sendAudioState();
  expect(JSON.parse(conn.dc.send.mock.calls.at(-1)[0]).data.enabled).toBe(false);
  conn.setListening(true);
  expect(JSON.parse(conn.dc.send.mock.calls.at(-1)[0]).data.enabled).toBe(true);
  conn.enableVideo(false);
  expect(JSON.parse(conn.dc.send.mock.calls.at(-1)[0]).data.enabled).toBe(false);
});

it('reacquires a microphone that ended instead of silently reusing it', async () => {
  const { conn, track, stream } = audioConnection();
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  await conn.prepareMicrophone();
  track.dispatchEvent(new Event('ended'));
  expect(conn.microphoneStream).toBeNull();
  await conn.prepareMicrophone();
  expect(getUserMedia).toHaveBeenCalledTimes(2);
});
