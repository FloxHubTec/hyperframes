const DEFAULT_AAC_AUDIO_BITRATE = "192k";
const DEFAULT_OPUS_AUDIO_BITRATE = "128k";

function trimmedBitrate(audioBitrate: string | undefined): string | undefined {
  const trimmed = audioBitrate?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveAacAudioBitrate(audioBitrate?: string): string {
  return trimmedBitrate(audioBitrate) ?? DEFAULT_AAC_AUDIO_BITRATE;
}

export function resolveOpusAudioBitrate(audioBitrate?: string): string {
  return trimmedBitrate(audioBitrate) ?? DEFAULT_OPUS_AUDIO_BITRATE;
}
