/*
Moments — single-file React app (suitable for Vercel static deployment)
- Default export is a React component you can drop in a Create React App / Next.js page.
- Uses Tailwind CSS classes for styling (assumes Tailwind is available in the project).
- Local accounts stored in localStorage (simple username + password hash using subtle crypto if available).
- Timeline posts (text, images, videos, notes) stored in IndexedDB as blobs + metadata.
- Friend discovery & friend-requests use BroadcastChannel so multiple tabs on the same machine (or same origin) can discover each other and exchange requests.
- This is a single-file demo meant as a starting point. For production, add server-side storage, stronger auth, and rate-limits.

How to run on Vercel (quick):
1) Create a Next.js app and install Tailwind following Tailwind + Next.js docs.
2) Place this file as `app/page.tsx` (or `pages/index.tsx`) and ensure Tailwind works.
3) Deploy to Vercel.

Notes:
- This app intentionally keeps everything client-side for a local-only experience.
- Media is stored in IndexedDB; large uploads will increase local storage usage.
*/

import React, { useEffect, useMemo, useRef, useState } from "react";

// ---------- Simple helpers ----------
const uid = () => Math.random().toString(36).slice(2, 9);

async function hashPassword(password: string) {
  if (!(window as any).crypto || !(window.crypto.subtle)) return password; // fallback
  const enc = new TextEncoder().encode(password);
  const digest = await window.crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Simple IndexedDB wrapper ----------
function openDB(name = "moments-db", version = 1) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("posts")) {
        const store = db.createObjectStore("posts", { keyPath: "id" });
        store.createIndex("owner", "owner", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putPost(post: any) {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("posts", "readwrite");
    tx.objectStore("posts").put(post);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getPostsByOwner(owner: string) {
  const db = await openDB();
  return new Promise<any[]>((resolve, reject) => {
    const tx = db.transaction("posts", "readonly");
    const idx = tx.objectStore("posts").index("owner");
    const req = idx.getAll(owner);
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.created - a.created));
    req.onerror = () => reject(req.error);
  });
}

async function getAllPosts() {
  const db = await openDB();
  return new Promise<any[]>((resolve, reject) => {
    const tx = db.transaction("posts", "readonly");
    const req = tx.objectStore("posts").getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.created - a.created));
    req.onerror = () => reject(req.error);
  });
}

// Save blob to object store inside post object (we store file as blob inside the post record)

// ---------- Local account management (localStorage) ----------
const USERS_KEY = "moments_users";
const SESSION_KEY = "moments_session";

function readUsers() {
  const raw = localStorage.getItem(USERS_KEY) || "{}";
  try { return JSON.parse(raw); } catch { return {}; }
}

function writeUsers(users: any) { localStorage.setItem(USERS_KEY, JSON.stringify(users)); }

async function createAccount(username: string, password: string) {
  const users = readUsers();
  if (users[username]) throw new Error("username taken");
  const h = await hashPassword(password);
  users[username] = { username, passwordHash: h, id: uid(), created: Date.now() };
  writeUsers(users);
  return users[username];
}

async function signIn(username: string, password: string) {
  const users = readUsers();
  const u = users[username];
  if (!u) throw new Error("no such user");
  const h = await hashPassword(password);
  if (h !== u.passwordHash) throw new Error("wrong password");
  localStorage.setItem(SESSION_KEY, JSON.stringify({ username: u.username, id: u.id }));
  return u;
}

function signOut() { localStorage.removeItem(SESSION_KEY); }

function currentSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------- BroadcastChannel for local friend discovery & requests ----------
const CHANNEL_NAME = "moments_channel_v1";

function useMomentsBroadcast(onMessage: (msg: any) => void) {
  useEffect(() => {
    const bc = new BroadcastChannel(CHANNEL_NAME);
    bc.onmessage = e => onMessage(e.data);
    return () => bc.close();
  }, [onMessage]);
}

function sendBroadcast(data: any) {
  try {
    const bc = new BroadcastChannel(CHANNEL_NAME);
    bc.postMessage(data);
    bc.close();
  } catch (e) {
    console.warn("Broadcast failed", e);
  }
}

// ---------- Main React Component ----------
export default function MomentsApp() {
  const [user, setUser] = useState<any>(currentSession());
  const [viewingUser, setViewingUser] = useState<string | null>(null); // whose timeline we're viewing
  const [posts, setPosts] = useState<any[]>([]);
  const [peers, setPeers] = useState<Record<string, any>>({}); // discovered tabs: {tabId: {username?, lastSeen}}
  const [requests, setRequests] = useState<any[]>([]); // incoming friend requests
  const peerRef = useRef(peers);
  peerRef.current = peers;

  // listen broadcast messages
  useMomentsBroadcast(async (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "ping") {
      // update peers
      setPeers(prev => ({ ...prev, [msg.tabId]: { tabId: msg.tabId, username: msg.username || null, lastSeen: Date.now() } }));
    }
    if (msg.type === "friend-request" && msg.targetUsername === (user && user.username)) {
      setRequests(prev => [...prev, { id: uid(), from: msg.from, fromTabId: msg.fromTabId, time: Date.now() }]);
    }
    if (msg.type === "friend-accept" && msg.targetUsername === (user && user.username)) {
      // accepted by someone
      alert(`Friend request accepted by ${msg.from}`);
    }
    if (msg.type === "timeline-request" && msg.targetUsername === (user && user.username)) {
      // send timeline posts to requester via direct message
      const myPosts = await getPostsByOwner(msg.targetUsername);
      sendBroadcast({ type: "timeline-data", toTabId: msg.fromTabId, from: msg.targetUsername, data: myPosts });
    }
    if (msg.type === "timeline-data" && msg.toTabId === (window as any)._moments_tabId) {
      // Received timeline data from a peer. Store it locally under 'shared_from_<username>' for viewing
      const owner = `shared_from_${msg.from}`;
      for (const p of msg.data) {
        const copy = { ...p, id: `shared_${p.id}_${msg.from}`, owner };
        try { await putPost(copy); } catch (e) { /* continue */ }
      }
      // refresh
      const all = await getPostsByOwner(owner);
      setPosts(all);
      setViewingUser(owner);
    }
  });

  // broadcast presence ping every 2s
  useEffect(() => {
    (window as any)._moments_tabId = (window as any)._moments_tabId || uid();
    const idd = (window as any)._moments_tabId;
    const iv = setInterval(() => {
      const sess = currentSession();
      sendBroadcast({ type: "ping", tabId: idd, username: sess ? sess.username : null, ts: Date.now() });
    }, 2000);
    return () => clearInterval(iv);
  }, []);

  // clear old peers
  useEffect(() => {
    const t = setInterval(() => {
      setPeers(prev => {
        const copy = { ...prev };
        const cutoff = Date.now() - 6000;
        for (const k of Object.keys(copy)) if (copy[k].lastSeen < cutoff) delete copy[k];
        return copy;
      });
    }, 4000);
    return () => clearInterval(t);
  }, []);

  // load own posts when user or viewingUser changes
  useEffect(() => {
    (async () => {
      const owner = viewingUser || (user ? user.username : null);
      if (!owner) { setPosts([]); return; }
      const loaded = await getPostsByOwner(owner);
      setPosts(loaded);
    })();
  }, [user, viewingUser]);

  // ---------- UI subcomponents ----------
  function AuthPanel() {
    const [mode, setMode] = useState<"signin" | "signup">("signin");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [err, setErr] = useState("");

    async function submit(e: React.FormEvent) {
      e.preventDefault();
      setErr("");
      try {
        if (mode === "signup") {
          await createAccount(username.trim(), password);
          await signIn(username.trim(), password);
        } else {
          await signIn(username.trim(), password);
        }
        setUser(currentSession());
      } catch (e: any) {
        setErr(e.message || String(e));
      }
    }

    return (
      <div className="max-w-md w-full bg-white/80 backdrop-blur-md rounded-2xl p-6 shadow-lg">
        <h2 className="text-2xl font-semibold mb-4">{mode === "signin" ? "Sign in" : "Create account"} — Moments</h2>
        <form onSubmit={submit} className="space-y-3">
          <input required placeholder="username" value={username} onChange={e=>setUsername(e.target.value)} className="w-full p-3 rounded-lg border" />
          <input required placeholder="password" value={password} onChange={e=>setPassword(e.target.value)} type="password" className="w-full p-3 rounded-lg border" />
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-2 rounded-xl bg-slate-900 text-white">{mode === "signin" ? "Sign in" : "Create account"}</button>
            <button type="button" onClick={() => setMode(m => m === "signin" ? "signup" : "signin")} className="px-4 py-2 rounded-xl border">{mode === "signin" ? "Switch to Sign up" : "Switch to Sign in"}</button>
          </div>
        </form>
      </div>
    );
  }

  function Navbar() {
    return (
      <div className="flex items-center justify-between py-4">
        <div className="flex items-center gap-3">
          <div className="text-xl font-bold">Moments</div>
          <div className="text-sm text-slate-500">local demo</div>
        </div>
        <div className="flex items-center gap-3">
          {user ? (
            <>
              <div className="text-sm">Hello, <b>{user.username}</b></div>
              <button className="px-3 py-1 rounded-md border" onClick={() => { signOut(); setUser(null); setViewingUser(null); }}>Sign out</button>
            </>
          ) : (
            <div className="text-sm text-slate-500">Not signed in</div>
          )}
        </div>
      </div>
    );
  }

  function CreatePost() {
    const [text, setText] = useState("");
    const [note, setNote] = useState("");
    const [files, setFiles] = useState<FileList | null>(null);
    const [saving, setSaving] = useState(false);

    async function submit(e: React.FormEvent) {
      e.preventDefault();
      if (!user) return alert("sign in first");
      setSaving(true);
      const id = uid();
      const fileBlobs: any[] = [];
      if (files) {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          // read blob directly
          fileBlobs.push({ name: f.name, type: f.type, blob: f });
        }
      }
      const post = { id, owner: user.username, text, note, files: fileBlobs, created: Date.now() };
      await putPost(post);
      const updated = await getPostsByOwner(user.username);
      setPosts(updated);
      setText(""); setNote(""); setFiles(null);
      setSaving(false);
    }

    return (
      <form onSubmit={submit} className="bg-white/80 p-4 rounded-xl shadow-sm">
        <textarea placeholder="What's happening? (text)" value={text} onChange={e=>setText(e.target.value)} className="w-full p-3 rounded-lg border mb-2" />
        <input type="file" accept="image/*,video/*" onChange={e=>setFiles(e.target.files)} multiple className="mb-2" />
        <textarea placeholder="Private note (optional)" value={note} onChange={e=>setNote(e.target.value)} className="w-full p-3 rounded-lg border mb-2" />
        <div className="flex gap-2">
          <button className="px-4 py-2 rounded-xl bg-slate-900 text-white" type="submit" disabled={saving}>{saving ? 'Saving...' : 'Create'}</button>
        </div>
      </form>
    );
  }

  function PostCard({ p }: { p: any }) {
    return (
      <div className="bg-white/90 rounded-xl p-4 shadow mb-3">
        <div className="text-sm text-slate-600">{p.owner} • {new Date(p.created).toLocaleString()}</div>
        {p.text && <div className="mt-2 text-lg">{p.text}</div>}
        {p.files && p.files.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {p.files.map((f: any, i: number) => (
              <div key={i} className="rounded overflow-hidden">
                {f.type.startsWith('image') ? (
                  <img src={URL.createObjectURL(f.blob)} alt={f.name} className="w-full h-40 object-cover" />
                ) : (
                  <video src={URL.createObjectURL(f.blob)} controls className="w-full h-40 object-cover" />
                )}
              </div>
            ))}
          </div>
        )}
        {p.note && <details className="mt-2 text-sm text-slate-500"><summary className="cursor-pointer">Private note</summary><div className="mt-1">{p.note}</div></details>}
      </div>
    );
  }

  function PeersPanel() {
    const known = Object.values(peers).filter(x => x.tabId !== (window as any)._moments_tabId);
    async function sendFriendRequest(peer: any) {
      if (!user) return alert('sign in first to send requests');
      sendBroadcast({ type: 'friend-request', from: user.username, fromTabId: (window as any)._moments_tabId, targetTabId: peer.tabId, targetUsername: peer.username });
      alert('friend request sent');
    }

    async function requestTimeline(peer: any) {
      if (!user) return alert('sign in first');
      // ask peer to send their timeline
      sendBroadcast({ type: 'timeline-request', from: user.username, fromTabId: (window as any)._moments_tabId, targetTabId: peer.tabId, targetUsername: peer.username });
      alert('requested timeline — if peer accepts it will be sent to this tab');
    }

    return (
      <div className="bg-white/80 rounded-xl p-3">
        <div className="font-semibold mb-2">Nearby tabs</div>
        {known.length === 0 && <div className="text-sm text-slate-500">No other tabs detected yet.</div>}
        {known.map(k=> (
          <div key={k.tabId} className="flex items-center justify-between py-2 border-b last:border-b-0">
            <div>
              <div className="text-sm font-medium">{k.username || 'anonymous tab'}</div>
              <div className="text-xs text-slate-500">tab {k.tabId}</div>
            </div>
            <div className="flex gap-2">
              <button className="px-2 py-1 border rounded" onClick={()=>sendFriendRequest(k)}>Send friend request</button>
              <button className="px-2 py-1 border rounded" onClick={()=>requestTimeline(k)}>Request timeline</button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  function RequestsPanel() {
    async function accept(r: any) {
      // send accept
      sendBroadcast({ type: 'friend-accept', from: user.username, fromTabId: (window as any)._moments_tabId, targetTabId: r.fromTabId, targetUsername: r.from });
      setRequests(prev => prev.filter(x => x.id !== r.id));
      alert('Accepted — you can request their timeline now.');
    }
    return (
      <div className="bg-white/80 rounded-xl p-3">
        <div className="font-semibold mb-2">Friend requests</div>
        {requests.length === 0 && <div className="text-sm text-slate-500">No requests</div>}
        {requests.map(r => (
          <div key={r.id} className="flex items-center justify-between py-2 border-b last:border-b-0">
            <div><div className="text-sm font-medium">{r.from}</div><div className="text-xs text-slate-500">tab {r.fromTabId}</div></div>
            <div><button className="px-3 py-1 rounded border" onClick={()=>accept(r)}>Accept</button></div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 p-6 font-sans">
      <div className="max-w-6xl mx-auto grid grid-cols-3 gap-6">
        <div className="col-span-3">
          <Navbar />
        </div>

        <div className="col-span-1 space-y-4">
          {!user && <AuthPanel />}
          {user && <div className="bg-white/80 rounded-xl p-4 shadow">
            <div className="font-semibold mb-2">Actions</div>
            <div className="flex flex-col gap-2">
              <button className="px-3 py-2 rounded border" onClick={()=>{ setViewingUser(null); (async()=>{ const own = await getPostsByOwner(user.username); setPosts(own); })()}}>My timeline</button>
              <button className="px-3 py-2 rounded border" onClick={()=>{ const raw = prompt('Enter username to view shared timeline (e.g. shared_from_alice)'); if(raw) setViewingUser(raw); }}>View shared timeline</button>
            </div>
          </div>}

          <PeersPanel />

          <RequestsPanel />

          <div className="bg-white/80 rounded-xl p-3 text-xs text-slate-500">
            Tips: open another tab and sign in to another account to test friend requests. The app uses BroadcastChannel so tabs on the same origin can talk to each other.
          </div>
        </div>

        <div className="col-span-2 space-y-4">
          {user && <CreatePost />}

          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">{viewingUser ? `Viewing: ${viewingUser}` : (user ? `${user.username}'s timeline` : 'Timeline')}</h3>
              <div className="text-sm text-slate-500">{posts.length} posts</div>
            </div>
            <div>
              {posts.length === 0 && <div className="text-sm text-slate-500">No posts yet.</div>}
              {posts.map(p => <PostCard key={p.id} p={p} />)}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
