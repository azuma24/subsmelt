import fs from "node:fs";

const MAX_SECRET_BYTES = 16 * 1024;

/** Read one bounded, single-line UTF-8 credential, following mounted-volume symlinks. */
export function readMountedSecret(variable: string, file: string): string {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error();
      const buffer = Buffer.alloc(MAX_SECRET_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size > MAX_SECRET_BYTES) throw new Error();
      const secret = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)).trim();
      if (!secret || /[\r\n\0]/.test(secret)) throw new Error();
      return secret;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // System errors can contain the file path. Decoding errors can quote bytes.
    throw new Error(`${variable} must point to a readable file containing one nonempty UTF-8 credential`);
  }
}
