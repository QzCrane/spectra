import Peer from 'peerjs';

// PeerJS is intentionally built as an opaque local vendor artifact. Its
// signaling and WebRTC field names are external protocol ABI and must not pass
// through SPECTRA's application-property mangler.
(globalThis as typeof globalThis & { Peer?: typeof Peer }).Peer = Peer;
