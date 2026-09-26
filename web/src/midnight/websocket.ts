// SDK's isomorphic-ws adapter expects a named WebSocket export in browsers.
export const WebSocket=globalThis.WebSocket;
export default WebSocket;
