import Busboy from "busboy";
import type { Request } from "express";

export interface ParsedFile {
  fieldname: string;
  filename: string;
  mime: string;
  data: Buffer;
}

export interface ParseOptions {
  // Reject the upload if a single file exceeds this size. The connection is
  // aborted as soon as the limit is crossed so we don't buffer huge bodies.
  maxFileBytes: number;
  // Reject the upload if the *total* of all files exceeds this. Same early
  // abort behavior.
  maxTotalBytes: number;
  maxFiles: number;
}

export interface ParsedMultipart {
  files: ParsedFile[];
  fields: Record<string, string>;
}

// Parse a multipart/form-data request body into in-memory buffers. We keep
// the payloads in memory because the server then writes them straight to
// disk under the cache dir — staging through a temp file just adds an extra
// fsync round-trip for no benefit at typical phone-photo sizes (≤25 MB).
export function parseMultipart(
  req: Request,
  opts: ParseOptions,
): Promise<ParsedMultipart> {
  return new Promise((resolve, reject) => {
    const headers = req.headers as Record<string, string>;
    let bb: Busboy.Busboy;
    try {
      bb = Busboy({
        headers,
        limits: {
          fileSize: opts.maxFileBytes,
          files: opts.maxFiles,
        },
      });
    } catch (err) {
      reject(err);
      return;
    }

    const files: ParsedFile[] = [];
    const fields: Record<string, string> = {};
    let total = 0;
    let aborted = false;

    const abort = (err: Error) => {
      if (aborted) return;
      aborted = true;
      req.unpipe(bb);
      reject(err);
    };

    bb.on("file", (fieldname, stream, info) => {
      const { filename, mimeType } = info;
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        total += chunk.length;
        if (total > opts.maxTotalBytes) {
          abort(new Error("upload exceeds total size limit"));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("limit", () => {
        abort(new Error(`file exceeds size limit: ${filename}`));
      });
      stream.on("end", () => {
        if (aborted) return;
        files.push({
          fieldname,
          filename: filename || "file",
          mime: mimeType || "application/octet-stream",
          data: Buffer.concat(chunks, size),
        });
      });
      stream.on("error", abort);
    });

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("filesLimit", () => abort(new Error("too many files in upload")));
    bb.on("error", abort);
    bb.on("finish", () => {
      if (aborted) return;
      resolve({ files, fields });
    });

    req.pipe(bb);
  });
}
