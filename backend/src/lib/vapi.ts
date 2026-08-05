/**
 * Vapi client — the narrow slice we actually use.
 *
 * Note what is absent: there is no `createOutboundCall`. Vapi supports it; we do
 * not wrap it. Adding that function is the single change that would break the
 * product's compliance posture (N4 in docs/compliance.md), so it is easier to
 * defend if the capability simply does not exist in this codebase.
 */

export interface VapiCall {
  id: string;
  status: string;
  monitor?: { controlUrl?: string; listenUrl?: string };
}

export async function getCall(
  baseUrl: string,
  apiKey: string,
  callId: string,
): Promise<VapiCall> {
  const response = await fetch(`${baseUrl}/call/${callId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Vapi GET /call/${callId} failed: ${response.status}`);
  }
  return response.json() as Promise<VapiCall>;
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
