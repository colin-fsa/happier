// Only transport/service outages qualify; authentication, configuration, response
// decoding and caller cancellation remain actionable failures at their owner.
export function isVoiceServiceUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === 'AbortError') return false;
  return error.message === 'voice_network_unavailable'
    || error.message === 'stt_timeout'
    || error.message === 'tts_timeout'
    || /^(http_stt_failed|tts_failed):(502|503|504)$/.test(error.message);
}
