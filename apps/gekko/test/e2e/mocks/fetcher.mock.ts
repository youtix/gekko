import { Fetcher } from '@gekko/core/fetcher/fetcher.types';

/** A getUpdates answer holding one command, /subscribe_all, sent to the bot from chat 123 */
export const SUBSCRIBE_ALL_UPDATES = {
  ok: true,
  result: [
    {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 123, is_bot: false, first_name: 'Test', username: 'test' },
        chat: { id: 123, first_name: 'Test', username: 'test', type: 'private' },
        date: 1600000000,
        text: '/subscribe_all@test-bot',
      },
    },
  ],
};

export class MockFetcherService implements Fetcher {
  public static callHistory: {
    method: 'GET' | 'POST';
    url: string;
    payload?: any;
    timestamp: number;
  }[] = [];

  public static mockResponses: Map<string, any> = new Map();

  /**
   * Configure a specific response for a URL (partial match supported)
   */
  public static when(urlPart: string): { thenReturn: (response: any) => void } {
    return {
      thenReturn: (response: any) => {
        this.mockResponses.set(urlPart, response);
      },
    };
  }

  public static reset() {
    this.callHistory = [];
    this.mockResponses.clear();
  }

  /** The texts of the messages the bots posted so far (sendMessage, their only POST), oldest first */
  public static postedTexts(): string[] {
    return this.callHistory.filter(({ method }) => method === 'POST').map(({ payload }) => payload.text);
  }

  // Unknown, as the fetcher resolves the body it got (see Request): typed as whatever the caller asked for, the answers went unchecked
  async get({ url }: { url: string; retries?: number; attempt?: number }): Promise<unknown> {
    return this.handleRequest('GET', url);
  }

  async post({ url, payload }: { url: string; payload: unknown; retries?: number; attempt?: number }): Promise<unknown> {
    return this.handleRequest('POST', url, payload);
  }

  private async handleRequest(method: 'GET' | 'POST', url: string, payload?: any): Promise<unknown> {
    MockFetcherService.callHistory.push({
      method,
      url,
      payload,
      timestamp: Date.now(),
    });

    // Check for specific mock responses
    for (const [key, response] of MockFetcherService.mockResponses) {
      if (url.includes(key)) {
        // If response is a function, evaluate it
        if (typeof response === 'function') {
          return response(url, payload);
        }
        return response;
      }
    }

    // Default response if no mock is found
    return { ok: true, result: [] };
  }
}
