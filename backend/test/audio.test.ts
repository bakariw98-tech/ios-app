/**
 * Pure audio transform tests — no socket, no live call. See the doc comment
 * on src/lib/audio.ts for why these functions exist at all despite the main
 * relay path being a base64 passthrough.
 */

import { describe, expect, it } from 'vitest';

import {
  base64Encode,
  downsample24kTo8k,
  frameMuLaw,
  muLawToPcm16,
  pcm16ToMuLaw,
} from '../src/lib/audio.js';

describe('pcm16ToMuLaw / muLawToPcm16 — G.711 μ-law codec', () => {
  it('matches the canonical μ-law silence byte (0xFF for linear zero)', () => {
    // Universally cited reference value for this exact CCITT algorithm —
    // if this doesn't hold, the encoder isn't standard G.711.
    expect(pcm16ToMuLaw(0)).toBe(0xff);
  });

  it('encodes the most negative sample without the reserved 0x00 byte', () => {
    // -32768 lands in the "zero trap" case class on the negative side; 0x00
    // itself is reserved for legacy line-error signaling and must never be
    // emitted by an encoder.
    const encoded = pcm16ToMuLaw(-32768);
    expect(encoded).not.toBe(0x00);
    expect(encoded).toBe(0x02);
  });

  it('encodes full-scale positive to 0x80', () => {
    expect(pcm16ToMuLaw(32767)).toBe(0x80);
  });

  it('is antisymmetric: +1 and -1 land on adjacent-but-mirrored codes', () => {
    // μ-law's sign bit is the top bit of the *inverted* byte, so +/- of the
    // same small magnitude differ by exactly the sign bit once un-inverted.
    const pos = pcm16ToMuLaw(1);
    const neg = pcm16ToMuLaw(-1);
    expect((~pos & 0x80) === 0).toBe(true); // positive sign bit set after inversion
    expect((~neg & 0x80) !== 0).toBe(true); // negative sign bit set after inversion
  });

  it('round-trips within the codec\'s expected quantization error', () => {
    // μ-law is lossy by design (that's the whole point of companding) — the
    // property worth pinning is that round-trip error stays bounded relative
    // to full scale, not that it's exact. The step size grows with each
    // exponent segment, so the loudest samples (near full scale) legitimately
    // carry the coarsest quantization — that's the trade that buys μ-law its
    // much finer resolution near zero, not a bug.
    for (const v of [0, 100, -100, 1000, -1000, 8031, -8031]) {
      const decoded = muLawToPcm16(pcm16ToMuLaw(v));
      const absErrFraction = Math.abs(decoded - v) / 32768;
      expect(absErrFraction).toBeLessThan(0.03);
    }
    for (const v of [32767, -32768]) {
      const decoded = muLawToPcm16(pcm16ToMuLaw(v));
      const absErrFraction = Math.abs(decoded - v) / 32768;
      expect(absErrFraction).toBeLessThan(0.1);
    }
  });

  it('decode is the structural inverse of encode (never throws, always in range)', () => {
    for (let byte = 0; byte <= 0xff; byte++) {
      const sample = muLawToPcm16(byte);
      expect(sample).toBeGreaterThanOrEqual(-32768);
      expect(sample).toBeLessThanOrEqual(32767);
    }
  });
});

describe('downsample24kTo8k', () => {
  it('produces exactly one third the input length', () => {
    const input = new Int16Array(300);
    expect(downsample24kTo8k(input).length).toBe(100);
  });

  it('preserves a constant (DC) signal at unity gain', () => {
    // The anti-alias filter is normalized to unity gain at DC — a constant
    // input should come back out constant, not attenuated or amplified.
    const input = new Int16Array(300).fill(1000);
    const output = downsample24kTo8k(input);
    // Skip the filter's transient edges; check the steady middle.
    for (let i = 20; i < 80; i++) {
      expect(Math.abs(output[i]! - 1000)).toBeLessThan(2);
    }
  });

  it('attenuates a tone above the telephone voice band', () => {
    // A 6kHz tone at 24kHz sample rate would alias into the audible band of
    // an 8kHz output if decimated naively (no filter). With the anti-alias
    // filter in place, its energy should be substantially reduced, not
    // aliased down near full scale.
    const sampleRate = 24000;
    const freq = 6000;
    const input = new Int16Array(2400);
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.round(20000 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    }
    const output = downsample24kTo8k(input);
    const outRms = Math.sqrt(
      output.reduce((sum, v) => sum + v * v, 0) / output.length,
    );
    // Unfiltered decimation-by-3 of a full-scale tone would keep RMS in the
    // thousands; a working anti-alias filter should knock it down sharply.
    expect(outRms).toBeLessThan(4000);
  });

  it('passes a tone well inside the voice band through with minimal attenuation', () => {
    const sampleRate = 24000;
    const freq = 1000;
    const input = new Int16Array(2400);
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.round(10000 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    }
    const output = downsample24kTo8k(input);
    const outRms = Math.sqrt(
      output.slice(20, -20).reduce((sum, v) => sum + v * v, 0) /
        (output.length - 40),
    );
    const expectedRms = 10000 / Math.sqrt(2);
    expect(outRms).toBeGreaterThan(expectedRms * 0.85);
  });
});

describe('base64Encode', () => {
  it('matches known base64 vectors ("Man"/"Ma"/"M")', () => {
    expect(base64Encode(new Uint8Array([0x4d, 0x61, 0x6e]))).toBe('TWFu');
    expect(base64Encode(new Uint8Array([0x4d, 0x61]))).toBe('TWE=');
    expect(base64Encode(new Uint8Array([0x4d]))).toBe('TQ==');
  });

  it('encodes an empty array as an empty string', () => {
    expect(base64Encode(new Uint8Array([]))).toBe('');
  });
});

describe('frameMuLaw', () => {
  it('splits into 160-byte frames matching Twilio\'s documented 20ms frame size', () => {
    const bytes = new Uint8Array(320).fill(0xff);
    const frames = frameMuLaw(bytes);
    expect(frames).toHaveLength(2);
  });

  it('does not pad a trailing partial frame', () => {
    const bytes = new Uint8Array(350).fill(0xff);
    const frames = frameMuLaw(bytes);
    expect(frames).toHaveLength(3);
    // Third frame is 30 bytes → base64 length ceil(30/3)*4 = 40.
    expect(frames[2]!.length).toBe(40);
  });

  it('round-trips through base64 back to the original bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
    const [frame] = frameMuLaw(bytes, 160);
    const decoded = Uint8Array.from(atob(frame!), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });
});
