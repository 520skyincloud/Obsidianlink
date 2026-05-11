import { StoredPreview } from "./types.js";

export class PreviewStore {
  private previews = new Map<string, StoredPreview>();

  set(preview: StoredPreview): void {
    this.previews.set(preview.previewId, preview);
  }

  get(previewId: string): StoredPreview | undefined {
    return this.previews.get(previewId);
  }

  update(preview: StoredPreview): void {
    this.previews.set(preview.previewId, preview);
  }

  list(limit = 50): StoredPreview[] {
    return [...this.previews.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }
}
