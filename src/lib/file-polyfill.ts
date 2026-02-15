import { Blob } from 'buffer';

if (typeof globalThis.File === 'undefined') {
  class File extends Blob {
    name: string;
    lastModified: number;

    constructor(fileBits: any[], fileName: string, options: any = {}) {
      super(fileBits, options);
      this.name = fileName;
      this.lastModified = options.lastModified || Date.now();
    }
  }

  (globalThis as any).File = File;
}
