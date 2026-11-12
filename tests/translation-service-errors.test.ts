import { translationServiceFailure } from "../src/services/translator";

it.each(["Error code: 401", "Authentication Fails", "invalid_api_key", "HTTP 402", "insufficient_quota", "model_not_found", "HTTP 403"])("classifies permanent service failure: %s", text => {
  expect(translationServiceFailure(text)).toBeTruthy();
});
it.each(["page 401 of 500", "Error code: 429", "HTTP 503", "RateLimitError, retrying", "0%", "Connection timed out"])("does not abort transient errors or ordinary output: %s", text => {
  expect(translationServiceFailure(text)).toBeUndefined();
});
