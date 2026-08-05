/**
 * Vapi client — the narrow slice we actually use.
 *
 * Note what is absent: there is no `createOutboundCall`. Vapi supports it; we do
 * not wrap it. Adding that function is the single change that would break the
 * product's compliance posture (N4 in docs/compliance.md), so it is easier to
 * defend if the capability simply does not exist in this codebase.
 */

import { config } from './config.js';

async function vapiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${config.vapi.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.vapi.apiKey}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Vapi ${init.method ?? 'GET'} ${path} failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<T>;
}

export interface VapiCall {
  id: string;
  status: string;
  monitor?: { controlUrl?: string; listenUrl?: string };
}

export function getCall(callId: string): Promise<VapiCall> {
  return vapiFetch<VapiCall>(`/call/${callId}`);
}

/** Live call control: speak a specific line into the call right now. */
export async function say(
  controlUrl: string,
  content: string,
  endCallAfterSpoken = false,
): Promise<void> {
  const response = await fetch(controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'say', content, endCallAfterSpoken }),
  });
  if (!response.ok) {
    throw new Error(`Vapi say failed: ${response.status}`);
  }
}

/** Live call control: end the call. */
export async function endCall(controlUrl: string): Promise<void> {
  await fetch(controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'end-call' }),
  });
}
