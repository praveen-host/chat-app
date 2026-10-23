/* Boot: global shortcuts, then restore a saved session (or show the login screen). */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeViewer(); closeProfile(); closePeerProfile(); closeDelete();
});

restoreSession();
