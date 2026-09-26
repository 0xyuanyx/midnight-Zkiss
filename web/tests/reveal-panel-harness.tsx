import React from 'react';
import { createRoot } from 'react-dom/client';
import { RequestPanel } from '../src/pages/Conversations';
import { SessionContext, type Session } from '../src/state/session';
import '../src/styles.css';

const params = new URLSearchParams(location.search);
const session = {
  conversations: { peer: { consent: { mine: params.get('mine') === '1', partner: false }, peerAccepted: params.get('peer') !== '0', canRequestReveal: true,
    revealStatus: params.get('status'), revealApprovalFailed: params.get('failed') === '1' } },
  busy: false, scene: undefined, profile: {nickname: "테스터"},
  requestReveal: async (_id: string, cancel: boolean | "reject" = false) => { document.querySelector('#action')!.textContent = cancel === 'reject' ? 'reject' : cancel ? 'cancel' : 'accept-or-retry'; return true; },
} as unknown as Session;
createRoot(document.querySelector('#root')!).render(<SessionContext.Provider value={session}><RequestPanel peerId="peer" /><output id="action" /></SessionContext.Provider>);
