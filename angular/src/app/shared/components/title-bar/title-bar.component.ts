import { Component, DestroyRef, ChangeDetectorRef, inject, OnInit } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import PackageInfo from '../../../../../../package.json';

@Component({
  selector: 'app-title-bar',
  imports: [LucideAngularModule],
  templateUrl: './title-bar.component.html',
  styleUrl: './title-bar.component.scss',
})
export class TitleBarComponent implements OnInit {
  private readonly _destroyRef = inject(DestroyRef);
  private readonly _cdr = inject(ChangeDetectorRef);
  public readonly version = PackageInfo.version;
  public visible = false;
  public maximized = false;
  public canMinimize = false;
  public canMaximize = false;

  ngOnInit() {
    window.windowAPI.platform().then((platform) => {
      // macOS keeps its native frame/traffic lights; only draw our own
      // title bar where the main process created a frameless window.
      this.visible = platform !== 'darwin';
      this._cdr.detectChanges();
    });

    window.windowAPI.canWindowControls().then(({ canMinimize, canMaximize }) => {
      this.canMinimize = canMinimize;
      this.canMaximize = canMaximize;
      this._cdr.detectChanges();
    });

    window.windowAPI.isMaximized().then((isMaximized) => {
      this.maximized = isMaximized;
    });
    window.windowAPI.onMaximizedChange((isMaximized) => {
      this.maximized = isMaximized;
      this._cdr.detectChanges();
    });

    this._destroyRef.onDestroy(() =>
      window.windowAPI.removeAllMaximizedChangeListeners()
    );
  }

  minimize() {
    window.windowAPI.minimize();
  }

  maximizeToggle() {
    window.windowAPI.maximizeToggle();
  }

  close() {
    window.windowAPI.close();
  }
}
