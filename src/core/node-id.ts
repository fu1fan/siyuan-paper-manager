let lastSecond = "";
let sequence = 0;

export function newNodeId(now = new Date()): string {
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  if (timestamp === lastSecond) sequence += 1;
  else {
    lastSecond = timestamp;
    sequence = 0;
  }
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
  const suffix = `${random}${sequence.toString(36).padStart(2, "0")}`.slice(-7);
  return `${timestamp}-${suffix}`;
}
