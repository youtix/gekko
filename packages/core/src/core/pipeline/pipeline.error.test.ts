import { describe, expect, it } from 'vitest';
import { PluginModeNotSupportedError, PluginsEmitSameEventError, UnknownPluginError } from './pipeline.error';

const PLUGINS = ['Trader', 'RoundTripAnalyzer', 'PortfolioAnalyzer'];

describe('UnknownPluginError', () => {
  it.each`
    description                                          | name                     | pluginNames | expected
    ${'a name no plugin bears, in alphabetical order'}   | ${'PerformanceAnalyzer'} | ${PLUGINS}  | ${'[PIPELINE] No plugin is named "PerformanceAnalyzer": the plugins are PortfolioAnalyzer, RoundTripAnalyzer and Trader'}
    ${'a name that differs from a plugin in case alone'} | ${'roundtripAnalyzer'}   | ${PLUGINS}  | ${'[PIPELINE] No plugin is named "roundtripAnalyzer" (did you mean "RoundTripAnalyzer"?): the plugins are PortfolioAnalyzer, RoundTripAnalyzer and Trader'}
    ${'a key every object inherits'}                     | ${'constructor'}         | ${PLUGINS}  | ${'[PIPELINE] No plugin is named "constructor": the plugins are PortfolioAnalyzer, RoundTripAnalyzer and Trader'}
  `('should refuse $description, naming the plugins', ({ name, pluginNames, expected }) => {
    expect(new UnknownPluginError(name, pluginNames).message).toBe(expected);
  });

  it('should leave the names it is given in their order', () => {
    const pluginNames = [...PLUGINS];
    new UnknownPluginError('Reporter', pluginNames);

    expect(pluginNames).toStrictEqual(PLUGINS);
  });

  it('should be named after its class', () => {
    expect(new UnknownPluginError('Reporter', PLUGINS).name).toBe('UnknownPluginError');
  });
});

describe('PluginModeNotSupportedError', () => {
  it.each`
    description               | modes                       | expected
    ${'the modes it runs'}    | ${['realtime', 'importer']} | ${'[PIPELINE] Plugin CandleWriter does not support backtest mode, only realtime and importer'}
    ${'the one mode it runs'} | ${['realtime']}             | ${'[PIPELINE] Plugin CandleWriter does not support backtest mode, only realtime'}
    ${'no mode at all'}       | ${[]}                       | ${'[PIPELINE] Plugin CandleWriter does not support backtest mode'}
  `('should refuse the mode, naming $description', ({ modes, expected }) => {
    expect(new PluginModeNotSupportedError('CandleWriter', 'backtest', modes).message).toBe(expected);
  });

  it('should be named after its class', () => {
    expect(new PluginModeNotSupportedError('CandleWriter', 'backtest', []).name).toBe('PluginModeNotSupportedError');
  });
});

describe('PluginsEmitSameEventError', () => {
  it.each`
    pluginNames                                                        | events                                         | expected
    ${['PortfolioAnalyzer', 'RoundTripAnalyzer']}                      | ${['performanceReport']}                       | ${'[PIPELINE] Plugins PortfolioAnalyzer and RoundTripAnalyzer are broadcasting the same event: performanceReport. This behavior is unsupported.'}
    ${['RoundTripAnalyzer', 'RoundTripAnalyzer']}                      | ${['performanceReport', 'roundtripCompleted']} | ${'[PIPELINE] Plugins RoundTripAnalyzer and RoundTripAnalyzer are broadcasting the same events: performanceReport and roundtripCompleted. This behavior is unsupported.'}
    ${['PortfolioAnalyzer', 'RoundTripAnalyzer', 'PortfolioAnalyzer']} | ${['performanceReport', 'equitySnapshot']}     | ${'[PIPELINE] Plugins PortfolioAnalyzer, RoundTripAnalyzer and PortfolioAnalyzer are broadcasting the same events: performanceReport and equitySnapshot. This behavior is unsupported.'}
  `('should build the message for $events.length shared event(s) of $pluginNames.length plugins', ({ pluginNames, events, expected }) => {
    expect(new PluginsEmitSameEventError(pluginNames, events).message).toBe(expected);
  });

  it('should be named after its class', () => {
    expect(new PluginsEmitSameEventError(['A', 'B'], ['event']).name).toBe('PluginsEmitSameEventError');
  });
});
