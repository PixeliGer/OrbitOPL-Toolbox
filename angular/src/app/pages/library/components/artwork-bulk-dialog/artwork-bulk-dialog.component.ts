import { Component, computed, input, output, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import {
  ARTWORK_PRESETS,
  KNOWN_ART_TYPES,
  artTypeLabel,
} from '@shared/constants/artwork-presets';

@Component({
  selector: 'app-artwork-bulk-dialog',
  imports: [LucideAngularModule],
  templateUrl: './artwork-bulk-dialog.component.html',
  styleUrl: './artwork-bulk-dialog.component.scss',
})
export class ArtworkBulkDialogComponent {
  readonly gameCount = input.required<number>();
  readonly confirm = output<string[]>();
  readonly closed = output<void>();

  readonly presets = ARTWORK_PRESETS;
  readonly knownTypes = KNOWN_ART_TYPES;
  readonly artTypeLabel = artTypeLabel;

  readonly selected = signal<Set<string>>(new Set(['COV', 'ICO', 'SCR']));
  readonly selectedCount = computed(() => this.selected().size);

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
    this.selected.set(new Set(types === null ? this.knownTypes : types));
  }

  selectAll(): void {
    this.selected.set(new Set(this.knownTypes));
  }

  deselectAll(): void {
    this.selected.set(new Set());
  }

  submit(): void {
    const types = Array.from(this.selected());
    if (types.length === 0) return;
    this.confirm.emit(types);
  }

  close(): void {
    this.closed.emit();
  }
}
