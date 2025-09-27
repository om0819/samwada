import React, { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

const SIGNAL_URL = 'ws://localhost:3001/ws'; // adjust to your server

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export default function App() {
  const [ws, setWs] = useState(null);
  const pcRefs = useRef(new Map());
  const dcRefs = useRef(new Map());
  const localStreamRef = useRef(null);
  const [localStream, setLocalStream] = useState(null);
  const [roomId, setRoomId] = useState('room1');
  const [peers, setPeers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [displayName, setDisplayName] = useState('User-' + Math.floor(Math.random()*1000));
  const videoGridRef = useRef(null);
  const localVideoRef = useRef(null);
  const [tab, setTab] = useState('room');
  const [selectedPeer, setSelectedPeer] = useState(null);

  const fileReceiveBuffers = useRef(new Map());
  const recorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  useEffect(() => {
    async function startMedia() {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        localStreamRef.current = s;
        setLocalStream(s);
      } catch (e) { console.error('media error', e); }
    }
    startMedia();
  }, []);

  useEffect(() => { if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream; }, [localStream]);

  function connectSignaling() {
    if (ws) return;
    const socket = new WebSocket(SIGNAL_URL);
    socket.onopen = () => console.log('ws open');
    socket.onmessage = (ev) => handleSignal(JSON.parse(ev.data));
    setWs(socket);
  }

  function joinRoom() {
    if (!ws) connectSignaling();
    const payload = { type: 'join', payload: { roomId, displayName } };
    const waitThen = () => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); else setTimeout(waitThen, 100); };
    waitThen();
  }

  function handleSignal(msg) {
    const { type, payload } = msg;

    switch (type) {
      case 'joined': {
        const { id, peers: existingPeers, iceServers } = payload;
        console.log('joined as', id, 'existing', existingPeers);
        setPeers(existingPeers);
        existingPeers.forEach(p => createPeerConnection(p, true, iceServers));
        break;
      }

      case 'peer-joined': {
        const { id } = payload;
        setPeers(prev => [...prev, id]);
        createPeerConnection(id, true);
        break;
      }

      case 'signal': {
        const { from, data } = payload;
        onIncomingSignal(from, data);
        break;
      }

      case 'broadcast': {
        const { from, data } = payload;
        setMessages(m => [...m, { from, text: JSON.stringify(data) }]);
        break;
      }

      case 'peer-left': {
        const { id } = payload;
        setPeers(p => p.filter(x => x !== id));
        const pc = pcRefs.current.get(id);
        if (pc) pc.close();
        pcRefs.current.delete(id);
        dcRefs.current.delete(id);
        break;
      }

      default:
        break;
    }
  }

  async function createPeerConnection(peerId, isOfferer = false, iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]) {
    if (pcRefs.current.has(peerId)) return pcRefs.current.get(peerId);

    const pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = (ev) => {
      if (ev.candidate) sendSignal({ type: 'signal', payload: { target: peerId, data: { type: 'candidate', candidate: ev.candidate } } });
    };

    pc.ontrack = (ev) => {
      attachRemoteStream(peerId, ev.streams[0]);
    };

    if (isOfferer) {
      const dc = pc.createDataChannel('webrtc-data');
      setupDataChannel(peerId, dc);
      dcRefs.current.set(peerId, dc);
    } else {
      pc.ondatachannel = (ev) => setupDataChannel(peerId, ev.channel);
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current));
    }

    pcRefs.current.set(peerId, pc);

    if (isOfferer) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ type: 'signal', payload: { target: peerId, data: { type: 'offer', sdp: pc.localDescription } } });
    }

    return pc;
  }

  async function onIncomingSignal(from, data) {
    let pc = pcRefs.current.get(from);
    if (!pc) pc = await createPeerConnection(from, false);

    if (data.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'signal', payload: { target: from, data: { type: 'answer', sdp: pc.localDescription } } });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'candidate') {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { console.warn('addIce', e); }
    }
  }

  function sendSignal(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function setupDataChannel(peerId, dc) {
    dc.onopen = () => console.log('dc open', peerId);
    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const j = JSON.parse(ev.data);
          if (j.type === 'chat') setMessages(m => [...m, { from: peerId, text: j.text }]);
          else if (j.type === 'file-meta') {
            fileReceiveBuffers.current.set(j.id, { meta: j, chunks: [], received: 0 });
            console.log('expecting file', j);
          } else if (j.type === 'file-complete') {
            const state = fileReceiveBuffers.current.get(j.id);
            if (state) {
              const blob = new Blob(state.chunks);
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = state.meta.name; a.textContent = `Download ${state.meta.name}`;
              document.body.appendChild(a);
              setMessages(m => [...m, { from: peerId, text: `Received file: ${state.meta.name} (saved link below)` }]);
            }
          }
        } catch (e) {
          setMessages(m => [...m, { from: peerId, text: ev.data }]);
        }
      } else {
        try {
          if (ev.data instanceof ArrayBuffer) {
            console.log('got arraybuffer');
          } else {
            const s = ev.data;
            try {
              const j = JSON.parse(s);
              if (j.type === 'file-chunk') {
                const state = fileReceiveBuffers.current.get(j.id);
                if (state) {
                  const ab = base64ToArrayBuffer(j.data);
                  state.chunks[j.seq] = new Uint8Array(ab);
                  state.received++;
                  if (state.received === state.meta.totalChunks) {
                    const buffers = state.chunks.map(u8 => u8.buffer);
                    fileReceiveBuffers.current.set(j.id, state);
                    setMessages(m => [...m, { from: peerId, text: `File ${state.meta.name} fully received.` }]);
                    const blob = new Blob(buffers);
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = state.meta.name; a.textContent = `Download ${state.meta.name}`;
                    document.body.appendChild(a);
                  }
                }
              }
            } catch (err) { }
          }
        } catch (err) { console.error('dc binary handling', err); }
      }
    };
    dc.onclose = () => console.log('dc close', peerId);
  }

  function attachRemoteStream(peerId, stream) {
    let el = document.getElementById('video-' + peerId);
    if (!el) {
      el = document.createElement('video');
      el.id = 'video-' + peerId;
      el.autoplay = true;
      el.playsInline = true;
      el.style.width = '200px';
      videoGridRef.current.appendChild(el);
    }
    el.srcObject = stream;
  }

  function sendChat(text) {
    setMessages(m => [...m, { from: 'me', text }]);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'broadcast', payload: { data: text } }));
    dcRefs.current.forEach((dc) => { if (dc.readyState === 'open') dc.send(JSON.stringify({ type: 'chat', text })); });
  }

  async function shareFile(file, targetPeerId = null) {
    const id = uuidv4();
    const chunkSize = 64 * 1024;
    const totalChunks = Math.ceil(file.size / chunkSize);
    const meta = { type: 'file-meta', id, name: file.name, size: file.size, totalChunks, chunkSize };

    const sendMeta = (dc) => { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(meta)); };

    if (targetPeerId) {
      const dc = dcRefs.current.get(targetPeerId);
      sendMeta(dc);
    } else {
      dcRefs.current.forEach(sendMeta);
    }

    const fileReader = file.stream().getReader();
    let seq = 0;
    while (true) {
      const { done, value } = await fileReader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.length) {
        const slice = value.slice(offset, offset + chunkSize);
        const base64 = arrayBufferToBase64(slice.buffer);
        const chunkMsg = JSON.stringify({ type: 'file-chunk', id, seq, data: base64 });
        if (targetPeerId) {
          const dc = dcRefs.current.get(targetPeerId);
          if (dc && dc.readyState === 'open') dc.send(chunkMsg);
        } else {
          dcRefs.current.forEach((dc) => { if (dc.readyState === 'open') dc.send(chunkMsg); });
        }
        seq++;
        offset += chunkSize;
      }
    }

    const completeMsg = { type: 'file-complete', id };
    if (targetPeerId) {
      const dc = dcRefs.current.get(targetPeerId);
      if (dc && dc.readyState === 'open') dc.send(JSON.stringify(completeMsg));
    } else {
      dcRefs.current.forEach((dc) => { if (dc.readyState === 'open') dc.send(JSON.stringify(completeMsg)); });
    }

    setMessages(m => [...m, { from: 'me', text: `Sent file ${file.name} (${file.size} bytes)` }]);
  }

  async function startScreenShare() {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];

      const combined = new MediaStream([...localStreamRef.current.getTracks(), screenTrack]);
      localVideoRef.current.srcObject = combined;

      pcRefs.current.forEach((pc) => {
        pc.addTrack(screenTrack, screenStream);
      });

      screenTrack.onended = () => {
        stopScreenShare(screenTrack);
      };

    } catch (e) { console.error('screen share failed', e); }
  }

  function stopScreenShare(screenTrack) {
    pcRefs.current.forEach((pc) => {
      const senders = pc.getSenders();
      senders.forEach(sender => {
        if (sender.track && sender.track === screenTrack) {
          pc.removeTrack(sender);
        }
      });
    });
    if (localStreamRef.current) localVideoRef.current.srcObject = localStreamRef.current;
  }

  function startRecording() {
    const streamToRecord = localVideoRef.current && localVideoRef.current.srcObject ? localVideoRef.current.srcObject : localStreamRef.current;
    if (!streamToRecord) return alert('No stream to record.');
    recordedChunksRef.current = [];
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const mr = new MediaRecorder(streamToRecord, { mimeType: mime });
    mr.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) recordedChunksRef.current.push(ev.data); };
    mr.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `recording-${Date.now()}.webm`; a.textContent = `Download recording`;
      document.body.appendChild(a);
      setMessages(m => [...m, { from: 'me', text: 'Recording stopped. Download link added to page.' }]);
    };
    mr.start();
    recorderRef.current = mr;
    setMessages(m => [...m, { from: 'me', text: 'Recording started.' }]);
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
  }

  return (
    <div className="min-h-screen p-4 bg-gray-50">
      <div className="max-w-6xl mx-auto">
        <header className="flex items-center justify-between py-4">
          <h1 className="text-2xl font-bold">WebRTC Room App (+ screenshare, recording, robust file transfer)</h1>
          <div className="flex gap-2">
            <input className="border p-1" value={displayName} onChange={e => setDisplayName(e.target.value)} />
            <input className="border p-1 w-32" value={roomId} onChange={e => setRoomId(e.target.value)} />
            <button className="px-3 py-1 bg-blue-600 text-white rounded" onClick={joinRoom}>Join</button>
          </div>
        </header>

        <nav className="mb-4">
          <button className={`px-3 py-1 ${tab==='room'?'bg-indigo-600 text-white':''}`} onClick={() => setTab('room')}>Room</button>
          <button className={`px-3 py-1 ${tab==='one2one'?'bg-indigo-600 text-white':''} ml-2`} onClick={() => setTab('one2one')}>One-to-One</button>
        </nav>

        {tab === 'room' && (
          <div>
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <div className="border p-2 h-96 overflow-auto" ref={videoGridRef}>
                  <video ref={localVideoRef} autoPlay muted playsInline style={{width:'200px'}} />
                </div>
                <div className="mt-2 flex gap-2">
                  <button onClick={startScreenShare} className="px-3 py-1 bg-yellow-500">Start Screen Share</button>
                  <button onClick={startRecording} className="px-3 py-1 bg-red-600 text-white">Start Recording</button>
                  <button onClick={stopRecording} className="px-3 py-1 bg-gray-300">Stop Recording</button>
                </div>
              </div>
              <aside>
                <h3 className="font-semibold">Participants</h3>
                <ul>
                  {peers.map(p => <li key={p}>{p}</li>)}
                </ul>

                <h3 className="mt-4 font-semibold">Chat</h3>
                <div className="h-48 overflow-auto border p-2 bg-white">
                  {messages.map((m,i) => <div key={i}><strong>{m.from}:</strong> {m.text}</div>)}
                </div>
                <ChatInput onSend={sendChat} onFile={shareFile} />
              </aside>
            </div>
          </div>
        )}

        {tab === 'one2one' && (
          <div>
            <h2 className="font-bold">One-to-One / Private Share</h2>
            <p>Select a peer to open a private media/data channel (direct). This reuses the same peer connection but you can add UI to make it private.</p>
            <div className="mt-2">
              <label className="block">Select peer</label>
              <select value={selectedPeer||''} onChange={e => setSelectedPeer(e.target.value)}>
                <option value="">-- choose --</option>
                {peers.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="mt-2">
              <p>When selected, you can click buttons to share camera/audio or documents privately via datachannel (this example uses the same connection's datachannel).</p>
            </div>
            <div className="mt-2">
              <input type="file" onChange={e => e.target.files[0] && shareFile(e.target.files[0], selectedPeer)} />
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

function ChatInput({ onSend, onFile }) {
  const [text, setText] = useState('');
  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <input value={text} onChange={e => setText(e.target.value)} className="flex-1 border p-1" />
        <button onClick={() => { if (text) { onSend(text); setText(''); } }} className="px-3 py-1 bg-green-600 text-white">Send</button>
      </div>
      <div className="mt-2">
        <input type="file" onChange={e => onFile(e.target.files[0])} />
      </div>
    </div>
  );
}
