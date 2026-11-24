import { type Page } from '@acra/shared-contracts';
import { computed, signal } from '@angular/core';
import { errorMessage } from './api-error';

/**
 * Cursor-paginated list state with "load more". `load()` restarts from the first page (e.g. when
 * filters change); stale responses from an earlier filter are discarded.
 */
export class PagedList<T> {
  private readonly _items = signal<readonly T[]>([]);
  private readonly _cursor = signal<string | null>(null);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _loaded = signal(false);
  private generation = 0;

  readonly items = this._items.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly hasMore = computed(() => this._cursor() !== null);
  readonly isEmpty = computed(() => this._loaded() && this._items().length === 0);

  constructor(private readonly fetchPage: (cursor: string | null) => Promise<Page<T>>) {}

  load(): Promise<void> {
    this._items.set([]);
    this._cursor.set(null);
    this._loaded.set(false);
    return this.fetch(null, ++this.generation);
  }

  loadMore(): Promise<void> {
    const cursor = this._cursor();
    return cursor ? this.fetch(cursor, this.generation) : Promise.resolve();
  }

  private async fetch(cursor: string | null, generation: number): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const page = await this.fetchPage(cursor);
      if (generation !== this.generation) return;
      this._items.update((items) => [...items, ...page.items]);
      this._cursor.set(page.nextCursor);
      this._loaded.set(true);
    } catch (error) {
      if (generation === this.generation) this._error.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this._loading.set(false);
    }
  }
}
