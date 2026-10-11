// Incremental text/event-stream parser (WHATWG "event stream interpretation").

export interface SseEvent { event: string; data: string; id?: string; retry?: number }

/** Feed chunks with `push`; complete events are passed to `onEvent` as soon as their blank line arrives. */
export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event = "";
  private id?: string;
  private retry?: number;
  private seen = false;
  constructor(private onEvent: (e: SseEvent) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, i);
      // A lone trailing \r may be the first half of \r\n: wait for more input.
      if (this.buf[i] === "\r" && i === this.buf.length - 1) break;
      this.buf = this.buf.slice(i + (this.buf.startsWith("\r\n", i) ? 2 : 1));
      this.line(line);
    }
  }

  /** Flush a final event that was not followed by a blank line. */
  end(): void {
    if (this.buf) { this.line(this.buf); this.buf = ""; }
    this.dispatch();
  }

  private line(line: string): void {
    if (line === "") return this.dispatch();
    if (line[0] === ":") return; // comment / keep-alive
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? "" : line.slice(c + 1);
    if (value[0] === " ") value = value.slice(1);
    this.seen = true;
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    else if (field === "retry" && /^\d+$/.test(value)) this.retry = +value;
  }

  private dispatch(): void {
    if (this.seen) this.onEvent({ event: this.event || "message", data: this.data.join("\n"), id: this.id, retry: this.retry });
    this.data = []; this.event = ""; this.id = undefined; this.retry = undefined; this.seen = false;
  }
}

/** Parse a complete text/event-stream body and return the JSON payloads it carries. */
export function parseSse(text: string): any[] {
  const out: any[] = [];
  const p = new SseParser((e) => { if (e.data) try { out.push(JSON.parse(e.data)); } catch { /* not JSON */ } });
  p.push(text); p.end();
  return out;
}
