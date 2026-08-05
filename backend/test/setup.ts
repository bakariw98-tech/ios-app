/**
 * Config is validated at import time (fail fast on a missing secret in prod), so
 * tests need placeholder values before any module that touches it loads.
 * These are not credentials — nothing in the test suite makes a network call.
 */
process.env.VAPI_API_KEY ??= 'test-key';
process.env.VAPI_WEBHOOK_SECRET ??= 'test-secret';
process.env.VAPI_PHONE_NUMBER ??= '+15550000000';
process.env.VAPI_PHONE_NUMBER_ID ??= 'test-phone-id';
process.env.PUBLIC_SERVER_URL ??= 'https://example.test';
