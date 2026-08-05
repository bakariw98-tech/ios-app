import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  vapi: {
    apiKey: required('VAPI_API_KEY'),
    /** Verified on every inbound webhook; requests without it are dropped. */
    webhookSecret: required('VAPI_WEBHOOK_SECRET'),
    /** The number the user dials. Shown in the app — never dialled by us. */
    phoneNumber: required('VAPI_PHONE_NUMBER'),
    phoneNumberId: required('VAPI_PHONE_NUMBER_ID'),
    baseUrl: process.env.VAPI_BASE_URL ?? 'https://api.vapi.ai',
  },

  /** Public base URL Vapi calls back on. */
  serverUrl: required('PUBLIC_SERVER_URL'),

  get webhookUrl() {
    return `${this.serverUrl}/vapi/webhook`;
  },
};
