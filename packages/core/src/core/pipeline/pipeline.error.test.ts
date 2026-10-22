import { describe, expect, it } from 'vitest';
import { PluginsEmitSameEventError } from './pipeline.error';

describe('PluginsEmitSameEventError', () => {
  it.each`
    pluginNames                                   | events                                         | expected
    ${['PortfolioAnalyzer', 'RoundTripAnalyzer']} | ${['performanceReport']}                       | ${'[PIPELINE] Multiple plugins (PortfolioAnalyzer,RoundTripAnalyzer) are broadcasting the same event: performanceReport. This behavior is unsupported.'}
    ${['RoundTripAnalyzer', 'RoundTripAnalyzer']} | ${['performanceReport', 'roundtripCompleted']} | ${'[PIPELINE] Multiple plugins (RoundTripAnalyzer,RoundTripAnalyzer) are broadcasting the same events: performanceReport roundtripCompleted. This behavior is unsupported.'}
  `('should build the message for $events.length shared event(s)', ({ pluginNames, events, expected }) => {
    expect(new PluginsEmitSameEventError(pluginNames, events).message).toBe(expected);
  });
});
