import fs from "node:fs";
import process from "node:process";
import { setInterval } from "node:timers";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes('--fixture-wait')) {
  process.stdout.write('READY\n');
  setInterval(() => {}, 1000);
} else if (args.includes('--help')) {
  process.stdout.write('fake pdf2zh help\n');
} else {
  const output = args[args.indexOf('-o') + 1];
  const input = args.at(-1);
  fs.writeFileSync(`${input}.args.json`, JSON.stringify(args));
  const base = path.basename(input, '.pdf');
  fs.writeFileSync(path.join(output, `${base}-mono.pdf`), '%PDF-1.4\nmono');
  fs.writeFileSync(path.join(output, `${base}-dual.pdf`), '%PDF-1.4\ndual');
  process.stdout.write('100%\n');
}
