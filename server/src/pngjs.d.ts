declare module 'pngjs' {
  export class PNG {
    static sync: {
      read(buffer: Buffer): PNG;
      write(png: PNG): Buffer;
    };
    width: number;
    height: number;
    data: Buffer;
    constructor(opts: { width: number; height: number });
  }
}
