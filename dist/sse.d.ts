export interface SseEvent {
    event: string;
    data: string;
    id?: string;
    retry?: number;
}
/** Feed chunks with `push`; complete events are passed to `onEvent` as soon as their blank line arrives. */
export declare class SseParser {
    private onEvent;
    private buf;
    private data;
    private event;
    private id?;
    private retry?;
    private seen;
    constructor(onEvent: (e: SseEvent) => void);
    push(chunk: string): void;
    /** Flush a final event that was not followed by a blank line. */
    end(): void;
    private line;
    private dispatch;
}
/** Parse a complete text/event-stream body and return the JSON payloads it carries. */
export declare function parseSse(text: string): any[];
