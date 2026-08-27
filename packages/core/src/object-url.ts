export interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export class ObjectUrlLease {
  private currentUrl: string | null = null;
  private readonly api: ObjectUrlApi;

  constructor(api: ObjectUrlApi = URL) {
    this.api = api;
  }

  replace(blob: Blob | null): string | null {
    this.revoke();
    if (!blob) return null;
    this.currentUrl = this.api.createObjectURL(blob);
    return this.currentUrl;
  }

  revoke(): void {
    if (!this.currentUrl) return;
    this.api.revokeObjectURL(this.currentUrl);
    this.currentUrl = null;
  }

  get value(): string | null {
    return this.currentUrl;
  }
}
