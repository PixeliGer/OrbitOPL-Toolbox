import { Component, computed, input, output, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { Game } from '@shared/types/game.type';
import { JobsService } from '@shared/services/jobs.service';
import { LibraryService } from '@shared/services/library.service';
import {
  ARTWORK_PRESETS,
  artTypeLabel,
} from '@shared/constants/artwork-presets';

interface ArtworkOption {
  type: string;
  label: string;
  downloadUrl: string;
  alreadySaved: boolean;
}

@Component({
  selector: 'app-artwork-wizard-dialog',
  imports: [LucideAngularModule],
  templateUrl: './artwork-wizard-dialog.component.html',
  styleUrl: './artwork-wizard-dialog.component.scss',
})
export class ArtworkWizardDialogComponent {
  readonly game = input.required<Game>();
  readonly closed = output<void>();

  readonly presets = ARTWORK_PRESETS;
  readonly artTypeLabel = artTypeLabel;

  readonly loading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly options = signal<ArtworkOption[]>([]);
  readonly selected = signal<Set<string>>(new Set());

  readonly selectedCount = computed(() => this.selected().size);

  constructor(
    private readonly _jobs: JobsService,
    private readonly _library: LibraryService,
  ) {}

  private get isPs1Launcher(): boolean {
    return !!this.game().isPs1Launcher;
  }

  private get system(): 'PS1' | 'PS2' {
    return this.game().system === 'PS1' || this.isPs1Launcher ? 'PS1' : 'PS2';
  }

  private get localName(): string {
    return this.isPs1Launcher
      ? this.game().ps1LauncherBoot || this.game().gameId
      : this.game().gameId;
  }

  async ngOnInit() {
    const g = this.game();
    const result = await window.libraryAPI.listAvailableArt(g.gameId, this.system);

    if (!result?.success) {
      this.errorMessage.set(result?.message || 'Failed to load available artwork.');
      this.loading.set(false);
      return;
    }

    if (result.data.length === 0) {
      this.errorMessage.set(result.message || 'No artwork available for this game yet.');
      this.loading.set(false);
      return;
    }

    const dirPath = this._library.currentDirectoryValue;
    const localName = this.localName;
    const expectedFiles = result.data.map((d) => `${localName}_${d.type}.png`);
    const existing = dirPath
      ? await window.libraryAPI.checkArtFilesExist(`${dirPath}/ART`, expectedFiles)
      : [];

    this.options.set(
      result.data.map((d) => ({
        type: d.type,
        label: artTypeLabel(d.type),
        downloadUrl: d.downloadUrl,
        alreadySaved: existing.includes(`${localName}_${d.type}.png`),
      })),
    );
    this.selected.set(new Set(result.data.map((d) => d.type)));
    this.loading.set(false);
  }

  isSelected(type: string): boolean {
    return this.selected().has(type);
  }

  toggle(type: string): void {
    const next = new Set(this.selected());
    if (next.has(type)) next.delete(type);
    else next.add(type);
    this.selected.set(next);
  }

  applyPreset(types: string[] | null): void {
    const available = this.options().map((o) => o.type);
    const next = types === null ? available : types.filter((t) => available.includes(t));
    this.selected.set(new Set(next));
  }

  selectAll(): void {
    this.selected.set(new Set(this.options().map((o) => o.type)));
  }

  deselectAll(): void {
    this.selected.set(new Set());
  }

  download(): void {
    const g = this.game();
    const types = Array.from(this.selected());
    if (types.length === 0) return;

    this._jobs.enqueue([
      {
        type: 'artwork',
        label: g.title || g.gameId || g.filename,
        filePath: g.path,
        gameId: g.gameId,
        gameName: g.title || '',
        downloadArtwork: false,
        system: this.system,
        saveAsName: this.isPs1Launcher ? g.ps1LauncherBoot : undefined,
        artTypes: types,
      },
    ]);
    this.close();
  }

  close(): void {
    this.closed.emit();
  }
}
