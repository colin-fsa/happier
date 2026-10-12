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
