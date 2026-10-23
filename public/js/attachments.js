/* Photo attachments (viewed in-app only; no download controls): pick, compress, preview, full-screen viewer. */

function loadImg(file) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(file), i = new Image();
    i.onload = () => { URL.revokeObjectURL(u); res(i); };
    i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('That file is not a readable image')); };
    i.src = u;
  });
}
// Re-encode to JPEG, max 1600px: keeps messages small and strips metadata such as GPS location
async function compressImage(file) {
  const img = await loadImg(file);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Could not process the image')), 'image/jpeg', 0.82));
}
async function pickImage(input) {
  const file = input.files[0]; input.value = '';
  if (!file || peer == null) return;
  try {
    const blob = await compressImage(file);
    if (blob.size > 4 * 1024 * 1024) return alert('Image is too large even after compression.');
    clearPending(); pending = { blob, url: URL.createObjectURL(blob) };
    $('previewImg').style.backgroundImage = `url("${pending.url}")`;
    renderChat(); $('text').focus();
  } catch (e) { alert(e.message); }
}
function clearPending() { if (pending) { URL.revokeObjectURL(pending.url); pending = null; } renderChat(); }

function openViewer(url) { $('viewerImg').style.backgroundImage = `url("${url}")`; $('viewer').style.display = 'block'; }
function closeViewer() { $('viewer').style.display = 'none'; $('viewerImg').style.backgroundImage = ''; }
