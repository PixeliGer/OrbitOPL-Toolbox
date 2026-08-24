export type BuildChannel = 'alpha' | 'beta' | 'rc' | 'nightly' | 'indev' | 'dev';

const CHANNEL_PATTERNS: Array<[RegExp, BuildChannel]> = [
  [/^alpha/i, 'alpha'],
  [/^beta/i, 'beta'],
  [/^(rc|release-?candidate)/i, 'rc'],
  [/^nightly/i, 'nightly'],
  [/^indev/i, 'indev'],
];

const CHANNEL_LABELS: Record<BuildChannel, string> = {
  alpha: 'Alpha',
  beta: 'Beta',
  rc: 'Release Candidate',
  nightly: 'Nightly',
  indev: 'In Development',
  dev: 'Development',
};

/**
 * Extracts the pre-release channel (e.g. "alpha" from "1.4.0-alpha.0"). Falls back to the
 * "dev" channel when running an unoptimized build (e.g. `ng serve`), regardless of version,
 * so the warning also shows up while developing locally.
 */
export function getBuildChannel(version: string, isDevMode: boolean): BuildChannel | null {
  const preRelease = version.split('-')[1];
  if (preRelease) {
    for (const [pattern, channel] of CHANNEL_PATTERNS) {
      if (pattern.test(preRelease)) return channel;
    }
  }
  return isDevMode ? 'dev' : null;
}

export function getBuildChannelLabel(channel: BuildChannel): string {
  return CHANNEL_LABELS[channel];
}
