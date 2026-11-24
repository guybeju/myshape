// What myshape.sh needs from the binding file before it starts the service:
// the SHA-256 of its bytes, and which of its paths could run without a
// confirmation (relative paths under bin/, binding.ts). myshape.sh then asks
// git whether each one is tracked and equal to HEAD; this program runs no git.
//
// Usage (called only by myshape.sh): binding-cli.js <binding-file>
// Prints "-" when there is no file; otherwise the SHA-256 on the first line
// and one candidate path per following line (none when the binding is not
// valid). Exits 0 either way: whether the binding may be used is the
// service's to say.
import fs from "node:fs";
import { exemptCandidates, parseBinding, sha256Of } from "./binding.js";

function main(file: string | undefined): void {
  if (file === undefined) {
    process.stderr.write("usage: binding-cli.js <binding-file>\n");
    process.exit(2);
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    process.stdout.write("-\n");
    return;
  }
  const parsed = parseBinding(bytes.toString("utf8"));
  const candidates = typeof parsed === "string" ? [] : exemptCandidates(parsed);
  process.stdout.write(`${[sha256Of(bytes), ...candidates].join("\n")}\n`);
}

main(process.argv[2]);
