// HTML5 canvas signature pad for /c/:token/consents.
// Reads from #sig-pad + #sig-clear; writes data URL into #signature_data_url.
(function () {
  var c = document.getElementById('sig-pad');
  if (!c) return;
  var ctx = c.getContext('2d');
  var hidden = document.getElementById('signature_data_url');
  var drawing = false;
  var last = null;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111';
  function pos(e) {
    var r = c.getBoundingClientRect();
    var t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }
  function start(e) {
    e.preventDefault();
    drawing = true;
    last = pos(e);
  }
  function move(e) {
    if (!drawing) return;
    e.preventDefault();
    var p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    hidden.value = c.toDataURL('image/png');
  }
  function end() {
    drawing = false;
  }
  c.addEventListener('mousedown', start);
  c.addEventListener('mousemove', move);
  c.addEventListener('mouseup', end);
  c.addEventListener('mouseleave', end);
  c.addEventListener('touchstart', start);
  c.addEventListener('touchmove', move);
  c.addEventListener('touchend', end);
  document.getElementById('sig-clear').addEventListener('click', function () {
    ctx.clearRect(0, 0, c.width, c.height);
    hidden.value = '';
  });
})();
