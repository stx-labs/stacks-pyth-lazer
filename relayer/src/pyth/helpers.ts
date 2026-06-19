import type { Channel } from '@pythnetwork/pyth-lazer-sdk';

export function parsePythLazerChannel(channel: string): Channel {
  switch (channel) {
    case 'fixed_rate_50ms':
      return 'fixed_rate@50ms';
    case 'fixed_rate_200ms':
      return 'fixed_rate@200ms';
    case 'fixed_rate_1000ms':
      return 'fixed_rate@1000ms';
    case 'real_time':
      return 'real_time';
    default:
      throw new Error(`Invalid Pyth Lazer channel: ${channel}`);
  }
}
