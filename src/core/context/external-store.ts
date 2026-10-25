import { appendJsonl, readJsonl } from '../../util/fs';

export interface StoredEvent {
  id: number;
  toolName: string;
  toolCallId: string;
  input: unknown;
  content: string;
  isError: boolean;
  step: number;
}

/**
 * External store for verbatim tool observations (mechanism M2 in the paper). Every tool
 * result is stored when it is created, so recall_event works for any past event no matter
 * whether it was later elided or summarized. Optionally persisted as JSONL in the run folder.
 */
export class ExternalStore {
  private readonly events = new Map<number, StoredEvent>();
  private nextId = 1;
  private recalls = 0;

  constructor(private readonly file?: string) {}

  static async load(file: string): Promise<ExternalStore> {
    const store = new ExternalStore(file);
    for (const ev of await readJsonl<StoredEvent>(file)) {
      store.events.set(ev.id, ev);
      store.nextId = Math.max(store.nextId, ev.id + 1);
    }
    return store;
  }

  allocateId(): number {
    return this.nextId++;
  }

  get lastId(): number {
    return this.nextId - 1;
  }

  get recallCount(): number {
    return this.recalls;
  }

  async put(event: StoredEvent): Promise<void> {
    this.events.set(event.id, event);
    if (this.file) await appendJsonl(this.file, event);
  }

  get(id: number): StoredEvent | undefined {
    return this.events.get(id);
  }

  recall(id: number): StoredEvent | undefined {
    const ev = this.events.get(id);
    if (ev) this.recalls++;
    return ev;
  }

  get size(): number {
    return this.events.size;
  }
}
