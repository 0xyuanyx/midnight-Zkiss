import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { LiveSessionProvider } from '../src/state/liveSession';
import { ChatRoomPage, MyPage } from '../src/pages/Conversations';
export function mount(path: string) {
  history.replaceState(null, '', path);
  const host = document.createElement('div'); document.body.replaceChildren(host);
  createRoot(host).render(<BrowserRouter><LiveSessionProvider><Routes>
    <Route path="/chats/:peerId" element={<ChatRoomPage />} />
    <Route path="/chats/:peerId/shared" element={<ChatRoomPage sharedRoute />} />
    <Route path="/me" element={<MyPage />} />
  </Routes></LiveSessionProvider></BrowserRouter>);
}
