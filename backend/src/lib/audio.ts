/**
 * Pure audio functions for the Twilio Media Streams bridge.
 *
 * Nothing here touches a socket, a request, or a config value — every
 * function is a plain transform, on purpose, so it's fully unit-testable
 * without a live call (unlike the relay itself, whose actual framing and
 * timing can only be verified with e2e/twilio-relay.mjs and a real phone —
 * see ADR-006).
 *
 * Twilio Media Streams and OpenAI Realtime's `audio/pcmu` format are both
 * G.711 μ-law at 8kHz, so the main relay path is a base64 passthrough with no
 * transcoding (confirmed live against a real OpenAI Realtime session, Phase 0
 * of the Twilio migration — see docs/technical-decisions.md ADR-006). These
 * functions exist for the one place transcoding is still needed regardless:
 * the disclosure, which is rendered via OpenAI's TTS endpoint (PCM16 24kHz
 * output) and has to be converted to μ-law 8kHz before it can be written back
 * down the Twilio socket.
 */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/**
 * 16-bit linear PCM → 8-bit G.711 μ-law.
 *
 * The classic ITU-T G.711 / CCITT reference algorithm (the same bit-exact
 * shape as Sun's widely-distributed public-domain `g711.c`), not a
 * reimplementation from first principles — this exact structure is what's
 * cross-checked against published test vectors in audio.test.ts.
 */
export function pcm16ToMuLaw(sample: number): number {
  let value = Math.max(-32768, Math.min(32767, Math.trunc(sample)));

  const sign = (value >> 8) & 0x80;
  if (sign !== 0) value = -value;
  if (value > MULAW_CLIP) value = MULAW_CLIP;
  value = value + MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }

  const mantissa = (value >> (exponent + 3)) & 0x0f;
  let muLawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;

  // CCITT "zero trap": 0x00 is reserved (it would otherwise be indistinguishable
  // from a framing/line error on legacy telephony equipment), so the smallest
  // magnitude on the positive side is nudged to 0x02.
  if (muLawByte === 0x00) muLawByte = 0x02;

  return muLawByte;
}

const MULAW_DECODE_EXP_LUT = [0, 132, 396, 924, 1980, 4092, 8316, 16764];

/** 8-bit G.711 μ-law → 16-bit linear PCM. Exact inverse structure of pcm16ToMuLaw. */
export function muLawToPcm16(byte: number): number {
  const inverted = ~byte & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;

  let sample = MULAW_DECODE_EXP_LUT[exponent]! + (mantissa << (exponent + 3));
  if (sign !== 0) sample = -sample;

  return sample;
}

/**
 * Windowed-sinc low-pass FIR kernel (Hamming window), normalized to unity
 * gain at DC. Computed from first principles rather than hardcoded magic
 * coefficients, so the design intent (cutoff, tap count) stays legible.
 */
function sincLowpassKernel(
  cutoffHz: number,
  sampleRateHz: number,
  numTaps: number,
): Float64Array {
  const kernel = new Float64Array(numTaps);
  const normalizedCutoff = cutoffHz / sampleRateHz;
  const center = (numTaps - 1) / 2;

  let sum = 0;
  for (let i = 0; i < numTaps; i++) {
    const x = i - center;
    const sinc =
      x === 0
        ? 2 * normalizedCutoff
        : Math.sin(2 * Math.PI * normalizedCutoff * x) / (Math.PI * x);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (numTaps - 1));
    const tap = sinc * window;
    kernel[i] = tap;
    sum += tap;
  }

  for (let i = 0; i < numTaps; i++) kernel[i] = kernel[i]! / sum;

  return kernel;
}

// 3400Hz is the standard telephone voice-band cutoff, comfortably under the
// 4kHz Nyquist limit of an 8kHz output rate — this is disclosure audio, and
// it needs to stay intelligible, not just avoid gross aliasing. 63 taps is
// enough rolloff for that cutoff without adding audible latency (~1.3ms at
// 24kHz for the whole kernel).
const DOWNSAMPLE_CUTOFF_HZ = 3400;
const DOWNSAMPLE_TAPS = 63;
const DOWNSAMPLE_KERNEL = sincLowpassKernel(
  DOWNSAMPLE_CUTOFF_HZ,
  24000,
  DOWNSAMPLE_TAPS,
);

/**
 * 24kHz PCM16 → 8kHz PCM16, with a real anti-alias low-pass filter before
 * decimating by 3 — not naive "keep every third sample," which would fold
 * everything above 4kHz back down into the audible band as noise.
 */
export function downsample24kTo8k(samples: Int16Array): Int16Array {
  const half = Math.floor(DOWNSAMPLE_KERNEL.length / 2);
  const filtered = new Float64Array(samples.length);

  for (let i = 0; i < samples.length; i++) {
    let acc = 0;
    for (let k = 0; k < DOWNSAMPLE_KERNEL.length; k++) {
      const idx = i + k - half;
      if (idx >= 0 && idx < samples.length) {
        acc += DOWNSAMPLE_KERNEL[k]! * samples[idx]!;
      }
    }
    filtered[i] = acc;
  }

  const outLength = Math.floor(samples.length / 3);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(filtered[i * 3]!)));
  }

  return out;
}

const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Plain byte-array base64 encoder — not `Buffer` (keeps this file identical
 * under Node's test runner and the Workers runtime) and not `btoa` (which
 * takes a binary *string*, not a byte array, and is an easy source of
 * mangled output if a caller passes UTF-8 text by mistake instead of raw
 * bytes). Twilio's `media` event payload is base64 of raw μ-law bytes.
 */
export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;

    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
  }
  return out;
}

/**
 * Split raw μ-law bytes into Twilio Media Streams frames — 160 bytes each
 * (20ms at 8kHz, Twilio's documented frame size), base64-encoded and ready to
 * drop into a `media` event's `payload` field. The final frame is whatever's
 * left over, not padded — Twilio doesn't require frames to be uniform length.
 */
export function frameMuLaw(bytes: Uint8Array, frameSizeBytes = 160): string[] {
  const frames: string[] = [];
  for (let i = 0; i < bytes.length; i += frameSizeBytes) {
    frames.push(base64Encode(bytes.subarray(i, i + frameSizeBytes)));
  }
  return frames;
}
