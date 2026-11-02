/** Serialises saves and retains failed writes so closing can retry them. */
export class SettingsPersistence {
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;

  constructor(
    private readonly write: (json: string) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  schedule(json: string): void {
    this.pending = json;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(this.onError);
    }, 350);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.writing) {
      await this.writing;
      return this.flush();
    }
    if (this.pending === null) return;
    const json = this.pending;
    this.pending = null;
    // A synchronous storage exception must follow the same retry path.
    let writing: Promise<void>;
    try { writing = this.write(json); } catch (error) { this.pending = json; throw error; }
    this.writing = writing;
    try {
      await writing;
    } catch (error) {
      // A newer edit always wins over the payload whose write failed.
      if (this.pending === null) this.pending = json;
      throw error;
    } finally {
      this.writing = null;
    }
    if (this.pending !== null) await this.flush();
  }
}
