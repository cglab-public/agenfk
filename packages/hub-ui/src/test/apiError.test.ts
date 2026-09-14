import { describe, it, expect } from 'vitest';
import { apiErrorText } from '../apiError';

describe('apiErrorText', () => {
  it('prefers the hub\'s own sentence over the transport\'s', () => {
    expect(apiErrorText({ response: { data: { error: 'invite token already used' } }, message: 'Request failed with status code 400' }))
      .toBe('invite token already used');
  });

  it('falls back to the transport message when the body carries none', () => {
    expect(apiErrorText({ message: 'Network Error' })).toBe('Network Error');
    expect(apiErrorText({ response: { data: {} }, message: 'Network Error' })).toBe('Network Error');
  });

  it('never returns an empty string, since a silent failure reads as a dead click', () => {
    expect(apiErrorText({})).toBe('Request failed');
    expect(apiErrorText(null)).toBe('Request failed');
    expect(apiErrorText({ response: { data: { error: '   ' } } })).toBe('Request failed');
    expect(apiErrorText({ message: '' })).toBe('Request failed');
  });
});
