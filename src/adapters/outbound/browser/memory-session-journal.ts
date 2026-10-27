import type {
  SessionCheckpoint,
  SessionJournal,
} from '../../../application/ports/session-journal.ts';

/**
 * Where an opening is, for as long as the page lives: a case screen rebuilt mid-opening carries
 * on. Nothing goes to browser storage: after a reload the server's state of the chest (being
 * opened in its session) is where the opening resumes.
 */
export class MemorySessionJournal implements SessionJournal {
  private checkpoint?: SessionCheckpoint;
  load(): SessionCheckpoint | undefined {
    return this.checkpoint;
  }
  save(checkpoint: SessionCheckpoint): void {
    this.checkpoint = checkpoint;
  }
  clear(): void {
    this.checkpoint = undefined;
  }
}
