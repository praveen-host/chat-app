// Small input validators shared by routes and socket handlers.
const config = require('./config');

const isJpeg = b => Buffer.isBuffer(b) && b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;

const cleanIds = a => Array.isArray(a) ? a.filter(x => typeof x === 'string' && x.length <= 64).slice(0, 200) : [];

// A reply carries a snapshot of the quoted message (the server keeps no history to look it up).
// Returns null (no reply), false (invalid) or the sanitised reply object.
function cleanReply(r, meId, toId) {
  if (r === undefined || r === null) return null;
  if (typeof r !== 'object' || typeof r.cid !== 'string' || !r.cid || r.cid.length > 64) return false;
  if (r.authorId !== meId && r.authorId !== toId) return false;     // 1:1 chat: the quoted message is mine or theirs
  return {
    cid: r.cid,
    authorId: r.authorId,
    text: typeof r.text === 'string' ? r.text.slice(0, config.MAX_REPLY_TEXT) : '',
    hasImage: !!r.hasImage,
  };
}

module.exports = { isJpeg, cleanIds, cleanReply };
