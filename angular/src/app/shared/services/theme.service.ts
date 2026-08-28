import { Injectable } from '@angular/core';
import { SettingsService } from './settings.service';

export type ThemePreference = AppSettings['theme'];

const STORAGE_KEY = 'orbitps2-theme';

/**
 * Applies the "Ice Console" color theme (dark, light, or following the OS)
 * to the document. The choice is persisted through SettingsService (Electron
 * settings.json) and mirrored into localStorage so index.html's boot script
 * can set data-theme before Angular bootstraps, avoiding a flash of the
 * wrong theme on launch.
 */
@Injectable({
  providedIn: 'root',
})
export class ThemeService {
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');

  constructor(private readonly _settings: SettingsService) {}

  /** Applies the persisted (or default) theme and starts following the OS if needed. */
  public async init(): Promise<void> {
    const settings = await this._settings.load();
    this.apply(settings.theme ?? 'orbitps2');

    this.media.addEventListener('change', () => {
      if (this._settings.current.theme === 'system') {
        this.applyResolved(this.resolve('system'));
      }
    });
  }

  public get current(): ThemePreference {
    return this._settings.current.theme ?? 'orbitps2';
  }

  public async setTheme(theme: ThemePreference): Promise<void> {
    this.apply(theme);
    await this._settings.set('theme', theme);
  }

  private apply(theme: ThemePreference): void {
    localStorage.setItem(STORAGE_KEY, theme);
    this.applyResolved(this.resolve(theme));
  }

  /** "system" follows the OS between the two OrbitPS2 modes — legacy is dark-only. */
  private resolve(theme: ThemePreference): 'orbitps2' | 'orbitps2-light' | 'legacy' {
    if (theme === 'system') {
      return this.media.matches ? 'orbitps2' : 'orbitps2-light';
    }
    return theme;
  }

  private applyResolved(resolved: 'orbitps2' | 'orbitps2-light' | 'legacy'): void {
    document.documentElement.setAttribute('data-theme', resolved);
  }
}
