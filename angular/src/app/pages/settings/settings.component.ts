import { Component, OnInit } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { Observable } from 'rxjs';
import { SettingsService } from '../../shared/services/settings.service';
import { LogsService } from '../../shared/services/logs.service';
import { UpdateService } from '../../shared/services/update.service';
import { ThemeService, ThemePreference } from '../../shared/services/theme.service';

@Component({
  selector: 'app-settings',
  imports: [LucideAngularModule, AsyncPipe],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  public settings$: Observable<AppSettings>;
  public verboseMode = false;

  constructor(
    private readonly _settings: SettingsService,
    private readonly _logger: LogsService,
    public readonly _update: UpdateService,
    private readonly _theme: ThemeService
  ) {
    this.settings$ = this._settings.settings$;
  }

  onThemeChange(theme: ThemePreference): void {
    this._theme.setTheme(theme);
  }

  checkForUpdates(): void {
    this._update.check();
  }

  openRelease(): void {
    this._update.openRelease();
  }

  ngOnInit(): void {
    this._settings.load();
    this.verboseMode = this._logger.isVerboseMode;
  }

  onAutoReconnectChange(enabled: boolean): void {
    this._settings.set('autoReconnect', enabled);
  }

  onVerboseChange(): void {
    this._logger.toggleVerboseMode();
    this.verboseMode = this._logger.isVerboseMode;
  }
}
