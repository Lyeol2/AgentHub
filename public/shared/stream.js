/** A closeable transport with no knowledge of application state or the DOM. */
export function connectEventStream({ handlers, EventSource: Source = globalThis.EventSource, url = "/api/stream" }) {
  const source = new Source(url);
  for (const [type, handler] of Object.entries(handlers)) source.addEventListener(type, handler);
  return { close: () => source.close() };
}
