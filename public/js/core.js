/* Shared state and tiny helpers. Loaded first; every other file builds on this. */

let token, me, socket, peer = null, users = [];
const online = new Set();            // active user ids
const typingNow = new Set();         // user ids currently typing to me
const typingTimers = {};             // auto-clear if a "stop typing" event is missed
const history = {}, unread = {};     // in-memory only: nothing persists across reloads
const $ = id => document.getElementById(id);
const peerUser = () => users.find(u => u.id === peer);
const newId = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);   // randomUUID needs HTTPS
const RANK = { failed: 0, sending: 0, sent: 1, delivered: 2, read: 3 };
const fmtTime = d => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function setStatus(m, s) { if (RANK[s] > RANK[m.status || 'sending'] || s === 'failed') m.status = s; }

// Extra shared state used by several files
const authHdr = () => ({ Authorization: 'Bearer ' + token });
let pending = null;                      // { blob, url } photo waiting to be sent
let replyingTo = null;                   // { cid, authorId, text, hasImage } message being replied to
let openCid = null;                      // message whose action buttons (reply/delete) are showing
let deleteTarget = null;                 // message the delete dialog is about
let myProfile = null;                    // my own full profile (email/phone included)
