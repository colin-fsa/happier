import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBrowserAudioRecorder } from './browserAudioRecorder';

function installBrowserCapture() {
  const trackStop = vi.fn();
  const instances: FakeMediaRecorder[] = [];
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported = () => true;
    state = 'inactive';
    mimeType = 'audio/webm;codecs=opus';
    startError: Error | null = null;
    constructor(_stream: unknown, _options?: unknown) {
      super();
      instances.push(this);
    }
    start() {
      if (this.startError) throw this.startError;
      this.state = 'recording';
    }
    stop() {
      // The browser contract is a no-op when already inactive.
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      queueMicrotask(() => {
        const data = new Event('dataavailable');
        Object.defineProperty(data, 'data', { value: new Blob(['captured audio'], { type: this.mimeType }) });
        this.dispatchEvent(data);
        this.dispatchEvent(new Event('stop'));
      });
    }
  }
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: trackStop }] }) } });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  return { trackStop, instances };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('browser recording resources', () => {
  it('releases the microphone after start fails on an inactive recorder', async () => {
    const h = installBrowserCapture();
    const recorder = createBrowserAudioRecorder();
    await recorder.prepareToRecordAsync();
    h.instances[0]!.startError = new Error('unsupported track');
    expect(() => recorder.record()).toThrow('unsupported track');

    let settled = false;
    const stopping = recorder.stop().then(() => { settled = true; });
    // An inactive stop has no browser event to await, so cleanup settles now.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
    await stopping;
    expect(h.trackStop).toHaveBeenCalledOnce();
    expect(recorder.uri).toBeNull();
  });

  it('keeps captured audio readable until disposal, then releases its object URL', async () => {
    installBrowserCapture();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const recorder = createBrowserAudioRecorder();
    await recorder.prepareToRecordAsync();
    recorder.record();
    await recorder.stop();
    const uri = recorder.uri!;
    expect(await (await fetch(uri)).text()).toBe('captured audio');
    expect(revoke).not.toHaveBeenCalled();

    recorder.dispose();
    expect(revoke).toHaveBeenCalledWith(uri);
    expect(recorder.uri).toBeNull();
    await expect(fetch(uri)).rejects.toThrow();
    recorder.dispose();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('retains finalized audio when the browser stopped before the user did', async () => {
    const h = installBrowserCapture();
    const recorder = createBrowserAudioRecorder();
    await recorder.prepareToRecordAsync();
    recorder.record();
    h.instances[0]!.stop();
    await Promise.resolve();

    await recorder.stop();
    expect(await (await fetch(recorder.uri!)).text()).toBe('captured audio');
    expect(h.trackStop).toHaveBeenCalledOnce();
    recorder.dispose();
  });
});


describe('browser hands-free endpointing', () => {
  it.each([120, 1000])('retains speech and honors silence/minimum elapsed duration (%ims), then stops monitoring', async (minSpeechMs) => {
    installBrowserCapture();
    let level = 0;
    let nextFrame: FrameRequestCallback | undefined;
    const close = vi.fn(async () => {});
    const disconnect = vi.fn();
    class CaptureContext {
      state = 'running';
      resume = async () => {};
      createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
      createAnalyser() {
        return { fftSize: 2048, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(level), disconnect };
      }
      close = close;
    }
    vi.stubGlobal('AudioContext', CaptureContext);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { nextFrame = undefined; });
    const ended = vi.fn();
    const recorder = createBrowserAudioRecorder({ audioContext: new AudioContext(), endpointing: { silenceMs: 450, minSpeechMs }, onSpeechEnded: ended });
    await recorder.prepareToRecordAsync();
    recorder.record();
    const frame = (time: number, amplitude: number) => { level = amplitude; const callback = nextFrame; nextFrame = undefined; callback?.(time); };
    frame(0, 0);
    frame(1000, 0);
    expect(ended).not.toHaveBeenCalled();
    frame(1010, 0.1);
    frame(1110, 0.1);
    frame(1120, 0);
    frame(1400, 0.1); // resumed speech cancels the pending silence window
    frame(1410, 0);
    frame(1849, 0);
    expect(ended).not.toHaveBeenCalled();
    frame(1850, 0);
    if (minSpeechMs === 1000) {
      expect(ended).not.toHaveBeenCalled();
      frame(2010, 0); // a short utterance still ends once the minimum elapsed turn has passed
    }
    expect(ended).toHaveBeenCalledOnce();
    expect(nextFrame).toBeUndefined();
    await recorder.stop();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    recorder.dispose();
  });

  it('releases a microphone acquired after disposal while permission was pending', async () => {
    const h = installBrowserCapture();
    let grant: (stream: { getTracks: () => { stop: () => void }[] }) => void = () => {};
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) } });
    const recorder = createBrowserAudioRecorder();
    const preparing = recorder.prepareToRecordAsync();
    recorder.dispose();
    grant({ getTracks: () => [{ stop: h.trackStop }] });
    await expect(preparing).rejects.toThrow('web_audio_recording_cancelled');
    expect(h.trackStop).toHaveBeenCalledOnce();
    expect(h.instances).toHaveLength(0);
  });
});
