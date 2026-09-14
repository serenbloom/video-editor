(function () {
  'use strict';

  var FONT_URL = 'https://fonts.gstatic.com/s/notosansjp/v56/-F6jfjtqLzI2JPCgQBnw7HFyzSD-AsregP8VFPYk75s.ttf';
  var FFMPEG_CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
  // jsDelivr's per-file ESM bundle: fully self-contained (no relative imports),
  // so it can be blob-ified and used as a module Worker regardless of the
  // page's own origin (a plain cross-origin classic Worker is blocked by the
  // browser, and a blob'd copy of the *unbundled* worker.js would still fail
  // to resolve its own relative imports).
  var FFMPEG_WORKER_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/worker.js/+esm';
  var TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm';
  var WHISPER_MODEL = 'Xenova/whisper-tiny';

  var TELOP_STYLES = {
    yellow_bold: {
      label: '黄色太字(バラエティ風)',
      position: 'bottom',
      ffmpeg: { fontcolor: 'yellow', box: 0, borderw: 8, bordercolor: 'black@0.9' },
      css: { color: '#ffe600', WebkitTextStroke: '2px #000', textShadow: '0 2px 6px rgba(0,0,0,.5)', background: 'transparent' }
    },
    white_box: {
      label: '白文字+黒帯',
      position: 'bottom',
      ffmpeg: { fontcolor: 'white', box: 1, boxcolor: 'black@0.55', boxborderw: 16 },
      css: { color: '#fff', WebkitTextStroke: '0', textShadow: 'none', background: 'rgba(0,0,0,.55)' }
    },
    pop_pink: {
      label: 'ポップピンク',
      position: 'bottom',
      ffmpeg: { fontcolor: 'white', box: 1, boxcolor: '0xFF3D7F@0.9', boxborderw: 20 },
      css: { color: '#fff', WebkitTextStroke: '0', textShadow: 'none', background: 'rgba(255,61,127,.9)' }
    },
    clean_minimal: {
      label: 'シンプル(白背景)',
      position: 'bottom',
      ffmpeg: { fontcolor: '0x222222', box: 1, boxcolor: 'white@0.85', boxborderw: 12 },
      css: { color: '#222', WebkitTextStroke: '0', textShadow: 'none', background: 'rgba(255,255,255,.85)' }
    },
    impact_center: {
      label: 'インパクト(中央大文字)',
      position: 'center',
      ffmpeg: { fontcolor: 'white', box: 0, borderw: 10, bordercolor: 'black' },
      css: { color: '#fff', WebkitTextStroke: '2px #000', textShadow: 'none', background: 'transparent' }
    }
  };

  var state = {
    clips: [],
    overlayBin: [],
    sequence: [],
    overlays: [],
    captions: [],
    selectedSeqId: null,
    selectedOverlayId: null,
    currentSeqIndex: 0,
    globalTime: 0,
    totalDuration: 0,
    playing: false
  };

  var HISTORY_LIMIT = 60;
  var history = { stack: [], index: -1, restoring: false };

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    ffmpegStatus: $('ffmpegStatus'),
    modelStatus: $('modelStatus'),
    undoBtn: $('undoBtn'),
    redoBtn: $('redoBtn'),
    projectNameInput: $('projectNameInput'),
    saveProjectBtn: $('saveProjectBtn'),
    projectSelect: $('projectSelect'),
    loadProjectBtn: $('loadProjectBtn'),
    deleteProjectBtn: $('deleteProjectBtn'),
    projectStatus: $('projectStatus'),
    clipInput: $('clipInput'),
    clipList: $('clipList'),
    overlayFileInput: $('overlayFileInput'),
    overlayBinList: $('overlayBinList'),
    previewStage: $('previewStage'),
    previewVideo: $('previewVideo'),
    overlayLayer: $('overlayLayer'),
    captionLayer: $('captionLayer'),
    playBtn: $('playBtn'),
    seekBar: $('seekBar'),
    timeLabel: $('timeLabel'),
    sequenceList: $('sequenceList'),
    sequenceEmptyHint: $('sequenceEmptyHint'),
    tabBtns: document.querySelectorAll('.tab-btn'),
    tabPanels: document.querySelectorAll('.tab-panel'),
    transcribeBtn: $('transcribeBtn'),
    transcribeProgress: $('transcribeProgress'),
    addCaptionBtn: $('addCaptionBtn'),
    captionList: $('captionList'),
    overlayList: $('overlayList'),
    colorEditor: $('colorEditor'),
    resolutionSelect: $('resolutionSelect'),
    fpsSelect: $('fpsSelect'),
    exportBtn: $('exportBtn'),
    exportProgress: $('exportProgress'),
    exportResult: $('exportResult')
  };

  function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function formatTime(s) {
    s = Math.max(0, s || 0);
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  function escapeHtml(str) {
    var d = document.createElement('div');
    d.textContent = str == null ? '' : str;
    return d.innerHTML;
  }
  function isTypingTarget(target) {
    if (!target) return false;
    var tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  function snapshotEditState() {
    return {
      sequence: JSON.parse(JSON.stringify(state.sequence)),
      overlays: JSON.parse(JSON.stringify(state.overlays)),
      captions: JSON.parse(JSON.stringify(state.captions)),
      selectedSeqId: state.selectedSeqId,
      selectedOverlayId: state.selectedOverlayId
    };
  }

  function pushHistory() {
    if (history.restoring) return;
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(snapshotEditState());
    if (history.stack.length > HISTORY_LIMIT) history.stack.shift();
    history.index = history.stack.length - 1;
    updateUndoRedoButtons();
  }

  function restoreSnapshot(snap) {
    history.restoring = true;
    state.sequence = JSON.parse(JSON.stringify(snap.sequence));
    state.overlays = JSON.parse(JSON.stringify(snap.overlays));
    state.captions = JSON.parse(JSON.stringify(snap.captions));
    state.selectedSeqId = snap.selectedSeqId;
    state.selectedOverlayId = snap.selectedOverlayId;
    recomputeOffsets();
    renderSequence();
    renderColorEditor();
    renderOverlayList();
    renderCaptionList();
    seekGlobal(Math.min(state.globalTime, state.totalDuration));
    renderOverlayVisibility(state.globalTime);
    renderCaptionVisibility(state.globalTime);
    history.restoring = false;
  }

  function undo() {
    if (history.index <= 0) return;
    history.index -= 1;
    restoreSnapshot(history.stack[history.index]);
    updateUndoRedoButtons();
  }

  function redo() {
    if (history.index >= history.stack.length - 1) return;
    history.index += 1;
    restoreSnapshot(history.stack[history.index]);
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    if (!el.undoBtn) return;
    el.undoBtn.disabled = history.index <= 0;
    el.redoBtn.disabled = history.index >= history.stack.length - 1;
  }

  try {
    var telopFont = new FontFace('RCTelopFont', 'url(' + FONT_URL + ')');
    telopFont.load().then(function (f) { document.fonts.add(f); }).catch(function () {});
  } catch (e) { /* FontFace unsupported; wrapping falls back to a heuristic */ }

  function probeMediaFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.src = url;
      video.addEventListener('loadedmetadata', function () {
        var duration = video.duration;
        var width = video.videoWidth;
        var height = video.videoHeight;
        var seekTo = Math.min(0.2, duration / 2);
        var onSeeked = function () {
          var canvas = document.createElement('canvas');
          canvas.width = 160;
          canvas.height = Math.round(160 * (height / width || 1));
          var ctx = canvas.getContext('2d');
          var thumb = null;
          try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            thumb = canvas.toDataURL('image/jpeg', 0.7);
          } catch (err) { thumb = null; }
          video.removeEventListener('seeked', onSeeked);
          resolve({ url: url, duration: duration, width: width, height: height, thumb: thumb });
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = seekTo;
      });
      video.addEventListener('error', function () {
        reject(new Error('動画を読み込めませんでした: ' + file.name));
      });
    });
  }

  function probeImageFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve({ url: url, duration: 3, width: img.naturalWidth, height: img.naturalHeight, thumb: url });
      };
      img.onerror = function () { reject(new Error('画像を読み込めませんでした: ' + file.name)); };
      img.src = url;
    });
  }

  function getClip(id) {
    for (var i = 0; i < state.clips.length; i++) if (state.clips[i].id === id) return state.clips[i];
    return null;
  }
  function getOverlayMedia(id) {
    for (var i = 0; i < state.overlayBin.length; i++) if (state.overlayBin[i].id === id) return state.overlayBin[i];
    return null;
  }

  el.clipInput.addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    files.forEach(function (file) {
      probeMediaFile(file).then(function (meta) {
        state.clips.push({
          id: uid(), name: file.name, file: file, url: meta.url,
          duration: meta.duration, width: meta.width, height: meta.height, thumb: meta.thumb,
          ffmpegName: null
        });
        renderClipList();
      }).catch(function (err) { alert(err.message); });
    });
    el.clipInput.value = '';
  });

  function renderClipList() {
    el.clipList.innerHTML = '';
    state.clips.forEach(function (clip) {
      var card = document.createElement('div');
      card.className = 'media-card';
      card.innerHTML =
        (clip.thumb ? '<img src="' + clip.thumb + '">' : '<div class="thumb-fallback">動画</div>') +
        '<div class="meta"><div class="name">' + escapeHtml(clip.name) + '</div>' +
        '<div class="dur">' + formatTime(clip.duration) + '</div></div>' +
        '<button class="add-btn">+ タイムラインに追加</button>';
      card.querySelector('.add-btn').addEventListener('click', function () { addToSequence(clip.id); });
      el.clipList.appendChild(card);
    });
  }

  el.overlayFileInput.addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    files.forEach(function (file) {
      var isVideo = file.type.indexOf('video') === 0;
      var probe = isVideo ? probeMediaFile(file) : probeImageFile(file);
      probe.then(function (meta) {
        state.overlayBin.push({
          id: uid(), name: file.name, file: file, url: meta.url, kind: isVideo ? 'video' : 'image',
          duration: meta.duration, width: meta.width, height: meta.height, thumb: meta.thumb,
          ffmpegName: null
        });
        renderOverlayBinList();
      }).catch(function (err) { alert(err.message); });
    });
    el.overlayFileInput.value = '';
  });

  function renderOverlayBinList() {
    el.overlayBinList.innerHTML = '';
    state.overlayBin.forEach(function (m) {
      var card = document.createElement('div');
      card.className = 'media-card';
      card.innerHTML =
        (m.thumb ? '<img src="' + m.thumb + '">' : '<div class="thumb-fallback">' + (m.kind === 'video' ? '動画' : '画像') + '</div>') +
        '<div class="meta"><div class="name">' + escapeHtml(m.name) + '</div>' +
        '<div class="dur">' + (m.kind === 'video' ? formatTime(m.duration) : '画像') + '</div></div>' +
        '<button class="add-btn">+ 追加</button>';
      card.querySelector('.add-btn').addEventListener('click', function () { addOverlayItem(m.id); });
      el.overlayBinList.appendChild(card);
    });
  }

  function addToSequence(clipId) {
    var clip = getClip(clipId);
    if (!clip) return;
    state.sequence.push({
      id: uid(), clipId: clipId, in: 0, out: clip.duration,
      color: { brightness: 0, contrast: 0, saturation: 100, hue: 0 },
      offset: 0, dur: clip.duration
    });
    recomputeOffsets();
    if (state.sequence.length === 1) { state.selectedSeqId = state.sequence[0].id; }
    renderSequence();
    renderColorEditor();
    seekGlobal(state.globalTime || 0);
    pushHistory();
  }

  function removeSeqItem(id) {
    state.sequence = state.sequence.filter(function (it) { return it.id !== id; });
    if (state.selectedSeqId === id) state.selectedSeqId = state.sequence.length ? state.sequence[0].id : null;
    recomputeOffsets();
    renderSequence();
    renderColorEditor();
    seekGlobal(Math.min(state.globalTime, state.totalDuration));
    pushHistory();
  }

  function moveSeqItem(id, dir) {
    var idx = state.sequence.findIndex(function (it) { return it.id === id; });
    var newIdx = idx + dir;
    if (idx === -1 || newIdx < 0 || newIdx >= state.sequence.length) return;
    var tmp = state.sequence[idx];
    state.sequence[idx] = state.sequence[newIdx];
    state.sequence[newIdx] = tmp;
    recomputeOffsets();
    renderSequence();
    seekGlobal(state.globalTime);
    pushHistory();
  }

  function recomputeOffsets() {
    var t = 0;
    state.sequence.forEach(function (item) {
      item.dur = Math.max(0.05, item.out - item.in);
      item.offset = t;
      t += item.dur;
    });
    state.totalDuration = t;
    el.seekBar.max = t.toFixed(2);
    if (state.globalTime > t) state.globalTime = t;
  }

  function renderSequence() {
    el.sequenceList.innerHTML = '';
    el.sequenceEmptyHint.style.display = state.sequence.length ? 'none' : 'block';
    state.sequence.forEach(function (item, idx) {
      var clip = getClip(item.clipId);
      if (!clip) return;
      var card = document.createElement('div');
      card.className = 'seq-item' + (item.id === state.selectedSeqId ? ' selected' : '');
      card.innerHTML =
        (clip.thumb ? '<img src="' + clip.thumb + '">' : '') +
        '<div>' +
        '<div class="name">' + (idx + 1) + '. ' + escapeHtml(clip.name) + '</div>' +
        '<div class="trims">' +
        'IN <input type="number" step="0.1" min="0" class="in-input" value="' + item.in.toFixed(1) + '">' +
        'OUT <input type="number" step="0.1" min="0" class="out-input" value="' + item.out.toFixed(1) + '">' +
        '/ ' + clip.duration.toFixed(1) + 's' +
        '</div></div>' +
        '<div class="actions">' +
        '<button class="up-btn" title="上へ">▲</button>' +
        '<button class="down-btn" title="下へ">▼</button>' +
        '<button class="del-btn" title="削除">✕</button>' +
        '</div>';
      card.addEventListener('click', function (e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        state.selectedSeqId = item.id;
        renderSequence();
        renderColorEditor();
      });
      card.querySelector('.in-input').addEventListener('change', function (e) {
        var v = clamp(parseFloat(e.target.value) || 0, 0, item.out - 0.1);
        item.in = v;
        recomputeOffsets(); renderSequence(); seekGlobal(state.globalTime); pushHistory();
      });
      card.querySelector('.out-input').addEventListener('change', function (e) {
        var v = clamp(parseFloat(e.target.value) || 0, item.in + 0.1, clip.duration);
        item.out = v;
        recomputeOffsets(); renderSequence(); seekGlobal(state.globalTime); pushHistory();
      });
      card.querySelector('.up-btn').addEventListener('click', function () { moveSeqItem(item.id, -1); });
      card.querySelector('.down-btn').addEventListener('click', function () { moveSeqItem(item.id, 1); });
      card.querySelector('.del-btn').addEventListener('click', function () { removeSeqItem(item.id); });
      el.sequenceList.appendChild(card);
    });
  }

  function ensureVideoSource(clip) {
    return new Promise(function (resolve) {
      if (el.previewVideo.dataset.clipId === clip.id) { resolve(); return; }
      el.previewVideo.dataset.clipId = clip.id;
      var onLoaded = function () {
        el.previewVideo.removeEventListener('loadedmetadata', onLoaded);
        resolve();
      };
      el.previewVideo.addEventListener('loadedmetadata', onLoaded);
      el.previewVideo.src = clip.url;
    });
  }

  function toCssFilter(color) {
    var b = 1 + (color.brightness / 100);
    var c = (100 + color.contrast) / 100;
    var s = color.saturation / 100;
    var h = color.hue;
    return 'brightness(' + b + ') contrast(' + c + ') saturate(' + s + ') hue-rotate(' + h + 'deg)';
  }

  function seekGlobal(t) {
    var seq = state.sequence;
    if (!seq.length) { updateTransportUI(); return Promise.resolve(); }
    t = clamp(t, 0, state.totalDuration);
    var idx = seq.findIndex(function (it) { return t >= it.offset && t < it.offset + it.dur; });
    if (idx === -1) idx = t >= state.totalDuration ? seq.length - 1 : 0;
    var item = seq[idx];
    var clip = getClip(item.clipId);
    if (!clip) return Promise.resolve();
    return ensureVideoSource(clip).then(function () {
      var local = item.in + (t - item.offset);
      el.previewVideo.currentTime = clamp(local, item.in, item.out);
      el.previewVideo.style.filter = toCssFilter(item.color);
      state.currentSeqIndex = idx;
      state.globalTime = t;
      updateTransportUI();
      renderOverlayVisibility(t);
      renderCaptionVisibility(t);
    });
  }

  function updateTransportUI() {
    el.seekBar.value = state.globalTime.toFixed(2);
    el.timeLabel.textContent = formatTime(state.globalTime) + ' / ' + formatTime(state.totalDuration);
  }

  var rafId = null;
  function tick() {
    if (!state.playing) return;
    var seq = state.sequence;
    var item = seq[state.currentSeqIndex];
    if (item) {
      var local = el.previewVideo.currentTime;
      var g = item.offset + (local - item.in);
      state.globalTime = clamp(g, 0, state.totalDuration);
      updateTransportUI();
      renderOverlayVisibility(state.globalTime);
      renderCaptionVisibility(state.globalTime);
      if (local >= item.out - 0.03) {
        if (state.currentSeqIndex < seq.length - 1) {
          var nextOffset = item.offset + item.dur + 0.001;
          seekGlobal(nextOffset).then(function () { if (state.playing) el.previewVideo.play(); });
        } else {
          pausePlayback();
          seekGlobal(0);
          return;
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  }
  function startPlayback() {
    if (!state.sequence.length) return;
    state.playing = true;
    el.playBtn.textContent = '⏸';
    el.previewVideo.play();
    rafId = requestAnimationFrame(tick);
  }
  function pausePlayback() {
    state.playing = false;
    el.playBtn.textContent = '▶';
    el.previewVideo.pause();
    if (rafId) cancelAnimationFrame(rafId);
  }
  el.playBtn.addEventListener('click', function () {
    if (state.playing) pausePlayback(); else startPlayback();
  });
  el.seekBar.addEventListener('input', function (e) {
    pausePlayback();
    seekGlobal(parseFloat(e.target.value) || 0);
  });

  function addOverlayItem(mediaId) {
    var media = getOverlayMedia(mediaId);
    if (!media) return;
    var dur = Math.min(media.kind === 'video' ? media.duration : 3, state.totalDuration || 3);
    var id = uid();
    state.overlays.push({
      id: id, mediaId: mediaId, start: 0, end: Math.max(0.5, dur),
      x: 10, y: 10, w: 30, h: 30, opacity: 1
    });
    state.selectedOverlayId = id;
    renderOverlayList();
    renderOverlayVisibility(state.globalTime);
    pushHistory();
  }

  function removeOverlay(id) {
    state.overlays = state.overlays.filter(function (o) { return o.id !== id; });
    if (state.selectedOverlayId === id) state.selectedOverlayId = null;
    renderOverlayList();
    renderOverlayVisibility(state.globalTime);
    pushHistory();
  }

  function renderOverlayList() {
    el.overlayList.innerHTML = '';
    state.overlays.forEach(function (ov) {
      var media = getOverlayMedia(ov.mediaId);
      if (!media) return;
      var card = document.createElement('div');
      card.className = 'item-card' + (ov.id === state.selectedOverlayId ? ' selected' : '');
      card.innerHTML =
        '<div class="row"><strong style="font-size:12px;">' + escapeHtml(media.name) + '</strong>' +
        '<button class="remove-btn">削除</button></div>' +
        '<div class="row">' +
        '<label class="inline">開始(秒)<input type="number" step="0.1" min="0" class="start-input" value="' + ov.start.toFixed(1) + '"></label>' +
        '<label class="inline">終了(秒)<input type="number" step="0.1" min="0" class="end-input" value="' + ov.end.toFixed(1) + '"></label>' +
        '</div>' +
        '<div class="row"><label class="inline">不透明度<input type="range" min="0" max="1" step="0.05" class="opacity-input" value="' + ov.opacity + '"></label>' +
        '<span class="rangeval">' + Math.round(ov.opacity * 100) + '%</span></div>';
      card.addEventListener('click', function (e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        state.selectedOverlayId = ov.id;
        renderOverlayList();
        renderOverlayVisibility(state.globalTime);
      });
      card.querySelector('.remove-btn').addEventListener('click', function () { removeOverlay(ov.id); });
      card.querySelector('.start-input').addEventListener('change', function (e) {
        ov.start = clamp(parseFloat(e.target.value) || 0, 0, ov.end - 0.1);
        renderOverlayVisibility(state.globalTime);
        pushHistory();
      });
      card.querySelector('.end-input').addEventListener('change', function (e) {
        ov.end = clamp(parseFloat(e.target.value) || 0, ov.start + 0.1, state.totalDuration || 9999);
        renderOverlayVisibility(state.globalTime);
        pushHistory();
      });
      var opacityInput = card.querySelector('.opacity-input');
      opacityInput.addEventListener('input', function (e) {
        ov.opacity = parseFloat(e.target.value);
        card.querySelector('.rangeval').textContent = Math.round(ov.opacity * 100) + '%';
        renderOverlayVisibility(state.globalTime);
      });
      opacityInput.addEventListener('change', function () { pushHistory(); });
      el.overlayList.appendChild(card);
    });
  }

  function renderOverlayVisibility(t) {
    el.overlayLayer.innerHTML = '';
    state.overlays.forEach(function (ov) {
      var media = getOverlayMedia(ov.mediaId);
      if (!media) return;
      var selected = ov.id === state.selectedOverlayId;
      var inWindow = t >= ov.start && t <= ov.end;
      if (!selected && !inWindow) return;
      var box = document.createElement('div');
      box.className = 'overlay-box';
      box.style.left = ov.x + '%';
      box.style.top = ov.y + '%';
      box.style.width = ov.w + '%';
      box.style.height = ov.h + '%';
      box.style.opacity = inWindow ? ov.opacity : 0.35;
      box.style.pointerEvents = selected ? 'auto' : 'none';
      box.style.borderColor = selected ? '#7c8cff' : 'rgba(255,255,255,.4)';
      var mediaEl = media.kind === 'video' ? document.createElement('video') : document.createElement('img');
      mediaEl.src = media.url;
      if (media.kind === 'video') { mediaEl.muted = true; mediaEl.loop = true; mediaEl.autoplay = inWindow; mediaEl.playsInline = true; }
      box.appendChild(mediaEl);
      if (selected) {
        var handle = document.createElement('div');
        handle.className = 'resize-handle';
        box.appendChild(handle);
        makeOverlayInteractive(box, handle, ov);
      }
      el.overlayLayer.appendChild(box);
    });
  }

  function makeOverlayInteractive(box, handle, ov) {
    box.addEventListener('mousedown', function (e) {
      if (e.target === handle) return;
      e.preventDefault();
      var rect = el.previewStage.getBoundingClientRect();
      var startX = e.clientX, startY = e.clientY, startLeft = ov.x, startTop = ov.y;
      function onMove(ev) {
        var dx = (ev.clientX - startX) / rect.width * 100;
        var dy = (ev.clientY - startY) / rect.height * 100;
        ov.x = clamp(startLeft + dx, 0, 100 - ov.w);
        ov.y = clamp(startTop + dy, 0, 100 - ov.h);
        box.style.left = ov.x + '%';
        box.style.top = ov.y + '%';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        pushHistory();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    handle.addEventListener('mousedown', function (e) {
      e.stopPropagation(); e.preventDefault();
      var rect = el.previewStage.getBoundingClientRect();
      var startX = e.clientX, startY = e.clientY, startW = ov.w, startH = ov.h;
      function onMove(ev) {
        var dx = (ev.clientX - startX) / rect.width * 100;
        var dy = (ev.clientY - startY) / rect.height * 100;
        ov.w = clamp(startW + dx, 4, 100 - ov.x);
        ov.h = clamp(startH + dy, 4, 100 - ov.y);
        box.style.width = ov.w + '%';
        box.style.height = ov.h + '%';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        pushHistory();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function addCaption(prefill, skipHistory) {
    var id = uid();
    var cap = Object.assign({
      id: id,
      start: state.globalTime,
      end: Math.min(state.globalTime + 2, state.totalDuration || state.globalTime + 2),
      text: '新しいテロップ',
      style: 'yellow_bold',
      position: TELOP_STYLES.yellow_bold.position,
      fontsizeBase: 56
    }, prefill || {});
    state.captions.push(cap);
    state.captions.sort(function (a, b) { return a.start - b.start; });
    renderCaptionList();
    renderCaptionVisibility(state.globalTime);
    if (!skipHistory) pushHistory();
    return cap;
  }
  el.addCaptionBtn.addEventListener('click', function () { addCaption(); });

  function removeCaption(id) {
    state.captions = state.captions.filter(function (c) { return c.id !== id; });
    renderCaptionList();
    renderCaptionVisibility(state.globalTime);
    pushHistory();
  }

  function renderCaptionList() {
    el.captionList.innerHTML = '';
    state.captions.forEach(function (cap) {
      var card = document.createElement('div');
      card.className = 'item-card';
      var styleOptions = Object.keys(TELOP_STYLES).map(function (key) {
        return '<option value="' + key + '"' + (cap.style === key ? ' selected' : '') + '>' + TELOP_STYLES[key].label + '</option>';
      }).join('');
      var posOptions = ['top', 'center', 'bottom'].map(function (p) {
        var jp = p === 'top' ? '上' : p === 'center' ? '中央' : '下';
        return '<option value="' + p + '"' + (cap.position === p ? ' selected' : '') + '>' + jp + '</option>';
      }).join('');
      card.innerHTML =
        '<div class="row"><textarea class="text-input">' + escapeHtml(cap.text) + '</textarea>' +
        '<button class="remove-btn">削除</button></div>' +
        '<div class="row">' +
        '<label class="inline">開始(秒)<input type="number" step="0.1" min="0" class="start-input" value="' + cap.start.toFixed(1) + '"></label>' +
        '<label class="inline">終了(秒)<input type="number" step="0.1" min="0" class="end-input" value="' + cap.end.toFixed(1) + '"></label>' +
        '</div>' +
        '<div class="row"><label class="inline">スタイル<select class="style-input">' + styleOptions + '</select></label>' +
        '<label class="inline">位置<select class="pos-input">' + posOptions + '</select></label></div>' +
        '<div class="row"><label class="inline">文字サイズ<input type="number" step="2" min="20" max="140" class="size-input" value="' + cap.fontsizeBase + '"></label></div>';
      card.querySelector('.text-input').addEventListener('input', function (e) {
        cap.text = e.target.value; renderCaptionVisibility(state.globalTime);
      });
      card.querySelector('.text-input').addEventListener('blur', function () { pushHistory(); });
      card.querySelector('.start-input').addEventListener('change', function (e) {
        cap.start = clamp(parseFloat(e.target.value) || 0, 0, cap.end - 0.1); renderCaptionVisibility(state.globalTime); pushHistory();
      });
      card.querySelector('.end-input').addEventListener('change', function (e) {
        cap.end = clamp(parseFloat(e.target.value) || 0, cap.start + 0.1, state.totalDuration || 9999); renderCaptionVisibility(state.globalTime); pushHistory();
      });
      card.querySelector('.style-input').addEventListener('change', function (e) {
        cap.style = e.target.value; cap.position = TELOP_STYLES[cap.style].position;
        renderCaptionList(); renderCaptionVisibility(state.globalTime); pushHistory();
      });
      card.querySelector('.pos-input').addEventListener('change', function (e) {
        cap.position = e.target.value; renderCaptionVisibility(state.globalTime); pushHistory();
      });
      card.querySelector('.size-input').addEventListener('change', function (e) {
        cap.fontsizeBase = clamp(parseInt(e.target.value, 10) || 56, 20, 140); renderCaptionVisibility(state.globalTime); pushHistory();
      });
      card.querySelector('.remove-btn').addEventListener('click', function () { removeCaption(cap.id); });
      el.captionList.appendChild(card);
    });
  }

  function renderCaptionVisibility(t) {
    el.captionLayer.innerHTML = '';
    var stageHeight = el.previewStage.clientHeight || 604;
    state.captions.forEach(function (cap) {
      if (t < cap.start || t > cap.end) return;
      var styleDef = TELOP_STYLES[cap.style] || TELOP_STYLES.yellow_bold;
      var div = document.createElement('div');
      div.className = 'caption-item';
      div.textContent = cap.text;
      var fontPx = cap.fontsizeBase * (stageHeight / 1920);
      div.style.fontSize = fontPx + 'px';
      div.style.fontFamily = '"RCTelopFont", sans-serif';
      div.style.color = styleDef.css.color;
      div.style.background = styleDef.css.background;
      div.style.webkitTextStroke = styleDef.css.WebkitTextStroke;
      div.style.textShadow = styleDef.css.textShadow;
      div.style.padding = styleDef.css.background !== 'transparent' ? '0.25em 0.6em' : '0';
      div.style.borderRadius = '6px';
      div.style.wordBreak = 'break-word';
      div.style.margin = '0 auto';
      div.style.width = 'fit-content';
      div.style.maxWidth = '88%';
      if (cap.position === 'top') { div.style.top = '6%'; }
      else if (cap.position === 'center') { div.style.top = '50%'; div.style.transform = 'translate(-50%,-50%)'; div.style.left = '50%'; div.style.right = 'auto'; }
      else { div.style.bottom = '6%'; }
      el.captionLayer.appendChild(div);
    });
  }

  function renderColorEditor() {
    var item = state.sequence.find(function (it) { return it.id === state.selectedSeqId; });
    if (!item) {
      el.colorEditor.innerHTML = '<p class="empty-hint">タイムラインのクリップを選択してください。</p>';
      return;
    }
    function sliderRow(label, key, min, max, step, unit) {
      return (
        '<div class="slider-row" data-key="' + key + '">' +
        '<div class="label-row"><span>' + label + '</span><span class="val">' + item.color[key] + unit + '</span></div>' +
        '<input type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + item.color[key] + '">' +
        '</div>'
      );
    }
    el.colorEditor.innerHTML =
      sliderRow('明るさ', 'brightness', -100, 100, 1, '') +
      sliderRow('コントラスト', 'contrast', -100, 100, 1, '') +
      sliderRow('彩度', 'saturation', 0, 200, 1, '%') +
      sliderRow('色相', 'hue', -180, 180, 1, '°') +
      '<button class="reset-btn">リセット</button>';
    el.colorEditor.querySelectorAll('.slider-row').forEach(function (row) {
      var key = row.dataset.key;
      var input = row.querySelector('input');
      input.addEventListener('input', function () {
        item.color[key] = parseFloat(input.value);
        row.querySelector('.val').textContent = input.value + (key === 'saturation' ? '%' : key === 'hue' ? '°' : '');
        if (state.currentSeqIndex === state.sequence.indexOf(item)) {
          el.previewVideo.style.filter = toCssFilter(item.color);
        }
      });
      input.addEventListener('change', function () { pushHistory(); });
    });
    el.colorEditor.querySelector('.reset-btn').addEventListener('click', function () {
      item.color = { brightness: 0, contrast: 0, saturation: 100, hue: 0 };
      renderColorEditor();
      if (state.currentSeqIndex === state.sequence.indexOf(item)) el.previewVideo.style.filter = toCssFilter(item.color);
      pushHistory();
    });
  }

  el.tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      el.tabBtns.forEach(function (b) { b.classList.remove('active'); });
      el.tabPanels.forEach(function (p) { p.classList.add('hidden'); });
      btn.classList.add('active');
      $('tab-' + btn.dataset.tab).classList.remove('hidden');
    });
  });

  function setFFmpegStatus(text, ready, error) {
    el.ffmpegStatus.textContent = 'FFmpeg: ' + text;
    el.ffmpegStatus.classList.toggle('ready', !!ready);
    el.ffmpegStatus.classList.toggle('error', !!error);
  }
  function setModelStatus(text, ready, error) {
    el.modelStatus.textContent = '音声認識: ' + text;
    el.modelStatus.classList.toggle('ready', !!ready);
    el.modelStatus.classList.toggle('error', !!error);
  }

  var ffmpegInstance = null;
  var fetchFileFn = null;
  var fontWritten = false;

  function appendExportLog(msg) {
    el.exportProgress.textContent = (el.exportProgress.textContent + '\n' + msg).split('\n').slice(-12).join('\n');
  }

  function getFFmpeg() {
    if (ffmpegInstance) return Promise.resolve(ffmpegInstance);
    setFFmpegStatus('読み込み中…');
    try {
      var FFmpeg = window.FFmpegWASM.FFmpeg;
      var toBlobURL = window.FFmpegUtil.toBlobURL;
      fetchFileFn = window.FFmpegUtil.fetchFile;
    } catch (e) {
      setFFmpegStatus('読み込み失敗', false, true);
      return Promise.reject(new Error('FFmpegライブラリの読み込みに失敗しました。ネットワーク接続を確認してください。'));
    }
    var ffmpeg = new FFmpeg();
    ffmpeg.on('log', function (e) { appendExportLog(e.message); });
    return Promise.all([
      toBlobURL(FFMPEG_CORE_BASE + '/ffmpeg-core.js', 'text/javascript'),
      toBlobURL(FFMPEG_CORE_BASE + '/ffmpeg-core.wasm', 'application/wasm'),
      toBlobURL(FFMPEG_WORKER_URL, 'text/javascript')
    ]).then(function (urls) {
      return ffmpeg.load({ coreURL: urls[0], wasmURL: urls[1], classWorkerURL: urls[2] }).then(function () {
        ffmpegInstance = ffmpeg;
        setFFmpegStatus('準備完了', true);
        return ffmpeg;
      });
    }).catch(function (err) {
      setFFmpegStatus('読み込み失敗', false, true);
      throw err;
    });
  }

  function ensureFileWritten(ffmpeg, media) {
    if (media.ffmpegName) return Promise.resolve(media.ffmpegName);
    var ext = (media.kind === 'image') ? 'img_' + media.id + '.png' :
      (media.file && media.file.name && /\.[a-z0-9]+$/i.test(media.file.name)) ?
        media.id + media.file.name.slice(media.file.name.lastIndexOf('.')) : media.id + '.mp4';
    media.ffmpegName = ext;
    return fetchFileFn(media.file).then(function (data) {
      return ffmpeg.writeFile(media.ffmpegName, data);
    }).then(function () { return media.ffmpegName; });
  }

  function ensureFontWritten(ffmpeg) {
    if (fontWritten) return Promise.resolve();
    return fetch(FONT_URL).then(function (r) { return r.arrayBuffer(); })
      .then(function (buf) { return ffmpeg.writeFile('font.ttf', new Uint8Array(buf)); })
      .then(function () { fontWritten = true; });
  }

  function wrapCaptionLines(text, fontsizePx, maxWidthPx) {
    var canvas = wrapCaptionLines._canvas || (wrapCaptionLines._canvas = document.createElement('canvas'));
    var ctx = canvas.getContext('2d');
    ctx.font = '700 ' + fontsizePx + 'px "RCTelopFont", sans-serif';
    var manualLines = String(text || '').split('\n');
    var out = [];
    manualLines.forEach(function (line) {
      line = line.trim();
      if (!line) { out.push(' '); return; }
      var cur = '';
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        var test = cur + ch;
        if (cur && ctx.measureText(test).width > maxWidthPx) {
          out.push(cur);
          cur = ch;
        } else {
          cur = test;
        }
      }
      if (cur) out.push(cur);
    });
    return out.length ? out : [' '];
  }

  function toFFmpegColor(color) {
    return {
      brightness: color.brightness / 100,
      contrast: (100 + color.contrast) / 100,
      saturation: color.saturation / 100,
      hue: color.hue
    };
  }

  el.exportBtn.addEventListener('click', function () { runExport(); });

  function runExport() {
    if (!state.sequence.length) { alert('タイムラインにクリップを追加してください。'); return; }
    var res = el.resolutionSelect.value.split('x');
    var W = parseInt(res[0], 10), H = parseInt(res[1], 10);
    var fps = parseInt(el.fpsSelect.value, 10);

    el.exportBtn.disabled = true;
    el.exportProgress.textContent = '準備中…';
    el.exportResult.innerHTML = '';

    var ffmpeg;
    var inputArgs = [];
    var clipIndexMap = {};

    function addClipInput(clip) {
      if (clipIndexMap[clip.id] != null) return Promise.resolve(clipIndexMap[clip.id]);
      return ensureFileWritten(ffmpeg, clip).then(function (name) {
        var idx = inputArgs.length;
        inputArgs.push(['-i', name]);
        clipIndexMap[clip.id] = idx;
        return idx;
      });
    }

    getFFmpeg()
      .then(function (ff) { ffmpeg = ff; return ensureFontWritten(ffmpeg); })
      .then(function () {
        return document.fonts.load('700 60px "RCTelopFont"').catch(function () {});
      })
      .then(function () {
        var seqChain = Promise.resolve();
        var sequenceParams = [];
        state.sequence.forEach(function (item) {
          seqChain = seqChain.then(function () {
            var clip = getClip(item.clipId);
            return addClipInput(clip).then(function (idx) {
              sequenceParams.push({ inputIndex: idx, in: item.in, out: item.out, color: toFFmpegColor(item.color) });
            });
          });
        });
        return seqChain.then(function () { return sequenceParams; });
      })
      .then(function (sequenceParams) {
        var overlayChain = Promise.resolve();
        var overlayParams = [];
        state.overlays.forEach(function (ov) {
          overlayChain = overlayChain.then(function () {
            var media = getOverlayMedia(ov.mediaId);
            if (!media) return;
            return ensureFileWritten(ffmpeg, media).then(function (name) {
              var duration = Math.max(0.1, ov.end - ov.start);
              var idx = inputArgs.length;
              if (media.kind === 'image') {
                inputArgs.push(['-loop', '1', '-t', String(duration.toFixed(2)), '-i', name]);
              } else {
                inputArgs.push(['-i', name]);
              }
              overlayParams.push({
                inputIndex: idx, kind: media.kind, duration: duration,
                x: Math.round(ov.x / 100 * W), y: Math.round(ov.y / 100 * H),
                w: Math.round(ov.w / 100 * W), h: Math.round(ov.h / 100 * H),
                opacity: ov.opacity, start: ov.start, end: ov.end
              });
            });
          });
        });
        return overlayChain.then(function () { return { sequenceParams: sequenceParams, overlayParams: overlayParams }; });
      })
      .then(function (acc) {
        var maxTextWidth = W * 0.86;
        var captionParams = state.captions.map(function (cap, ci) {
          var fontsize = Math.round(cap.fontsizeBase * (H / 1920));
          var lines = wrapCaptionLines(cap.text, fontsize, maxTextWidth);
          var files = lines.map(function (line, li) {
            var fname = 'cap_' + ci + '_' + li + '.txt';
            return ffmpeg.writeFile(fname, new TextEncoder().encode(line)).then(function () { return fname; });
          });
          return Promise.all(files).then(function (fileNames) {
            var styleDef = TELOP_STYLES[cap.style] || TELOP_STYLES.yellow_bold;
            return Object.assign({
              lines: fileNames, fontsize: fontsize, position: cap.position,
              start: cap.start, end: cap.end
            }, styleDef.ffmpeg);
          });
        });
        return Promise.all(captionParams).then(function (captionParamsResolved) {
          return { sequence: acc.sequenceParams, overlays: acc.overlayParams, captions: captionParamsResolved };
        });
      })
      .then(function (graphInput) {
        var built = window.FilterGraph.buildFilterGraph({
          width: W, height: H, fps: fps, fontFile: 'font.ttf',
          sequence: graphInput.sequence, overlays: graphInput.overlays, captions: graphInput.captions
        });
        var flatInputs = inputArgs.reduce(function (a, b) { return a.concat(b); }, []);
        var args = flatInputs.concat([
          '-filter_complex', built.filterComplex,
          '-map', '[' + built.videoLabel + ']',
          '-map', '[' + built.audioLabel + ']',
          '-r', String(fps),
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
          '-c:a', 'aac',
          'output.mp4'
        ]);
        el.exportProgress.textContent = '書き出し中…';
        return ffmpeg.exec(args);
      })
      .then(function () { return ffmpeg.readFile('output.mp4'); })
      .then(function (data) {
        var blob = new Blob([data.buffer], { type: 'video/mp4' });
        var url = URL.createObjectURL(blob);
        el.exportResult.innerHTML = '<video controls src="' + url + '"></video><a href="' + url + '" download="reel-cutter-output.mp4">書き出した動画をダウンロード</a>';
        el.exportProgress.textContent = '完了しました。';
      })
      .catch(function (err) {
        console.error(err);
        el.exportProgress.textContent = 'エラーが発生しました: ' + (err && err.message ? err.message : err);
      })
      .finally(function () {
        el.exportBtn.disabled = false;
      });
  }

  var transcriberPromise = null;
  function getTranscriber() {
    if (transcriberPromise) return transcriberPromise;
    setModelStatus('モデル読み込み中…');
    transcriberPromise = import(/* webpackIgnore: true */ TRANSFORMERS_URL).then(function (mod) {
      mod.env.allowLocalModels = false;
      return mod.pipeline('automatic-speech-recognition', WHISPER_MODEL, {
        progress_callback: function (p) {
          if (p.status === 'progress') setModelStatus('モデル読み込み中… ' + Math.round(p.progress || 0) + '%');
        }
      });
    }).then(function (transcriber) {
      setModelStatus('準備完了', true);
      return transcriber;
    }).catch(function (err) {
      setModelStatus('読み込み失敗', false, true);
      transcriberPromise = null;
      throw err;
    });
    return transcriberPromise;
  }

  function extractAudioFloat32(clip, inSec, outSec) {
    return getFFmpeg().then(function (ffmpeg) {
      return ensureFileWritten(ffmpeg, clip).then(function (name) {
        var outName = 'asr_' + uid() + '.wav';
        return ffmpeg.exec(['-i', name, '-ss', String(inSec), '-to', String(outSec), '-ac', '1', '-ar', '16000', outName])
          .then(function () { return ffmpeg.readFile(outName); })
          .then(function (data) {
            ffmpeg.deleteFile(outName).catch(function () {});
            var ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            var AudioCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
            var ctx = new AudioCtx(1, 1, 16000);
            return ctx.decodeAudioData(ab);
          })
          .then(function (buffer) { return buffer.getChannelData(0); });
      });
    });
  }

  function transcribeSelected() {
    if (!state.sequence.length) { alert('タイムラインにクリップを追加してください。'); return; }
    var targets = state.selectedSeqId ?
      state.sequence.filter(function (it) { return it.id === state.selectedSeqId; }) :
      state.sequence;

    el.transcribeBtn.disabled = true;
    el.transcribeProgress.textContent = '準備中…';

    var chain = getTranscriber();
    targets.forEach(function (item, i) {
      chain = chain.then(function (transcriber) {
        el.transcribeProgress.textContent = '音声を解析中… (' + (i + 1) + '/' + targets.length + ')';
        var clip = getClip(item.clipId);
        return extractAudioFloat32(clip, item.in, item.out).then(function (samples) {
          return transcriber(samples, {
            chunk_length_s: 30, stride_length_s: 5,
            return_timestamps: true, language: 'japanese', task: 'transcribe'
          });
        }).then(function (output) {
          var chunks = (output && output.chunks) || [{ text: output.text, timestamp: [0, item.dur] }];
          chunks.forEach(function (ch) {
            var text = (ch.text || '').trim();
            if (!text) return;
            var localStart = (ch.timestamp && ch.timestamp[0] != null) ? ch.timestamp[0] : 0;
            var localEnd = (ch.timestamp && ch.timestamp[1] != null) ? ch.timestamp[1] : item.dur;
            addCaption({
              start: item.offset + localStart,
              end: item.offset + localEnd,
              text: text,
              style: 'white_box',
              position: TELOP_STYLES.white_box.position
            }, true);
          });
          return transcriber;
        }).catch(function (err) {
          console.error(err);
          el.transcribeProgress.textContent = 'クリップ ' + (i + 1) + ' の解析でエラーが発生しました: ' + err.message;
          return transcriber;
        });
      });
    });
    chain.then(function () {
      el.transcribeProgress.textContent = '完了しました。';
      pushHistory();
    }).catch(function (err) {
      el.transcribeProgress.textContent = 'エラー: ' + (err && err.message ? err.message : err);
    }).finally(function () {
      el.transcribeBtn.disabled = false;
    });
  }
  el.transcribeBtn.addEventListener('click', transcribeSelected);

  window.addEventListener('resize', function () { renderCaptionVisibility(state.globalTime); });

  if (el.undoBtn) el.undoBtn.addEventListener('click', undo);
  if (el.redoBtn) el.redoBtn.addEventListener('click', redo);

  document.addEventListener('keydown', function (e) {
    var typing = isTypingTarget(document.activeElement);
    var mod = e.ctrlKey || e.metaKey;
    if (mod && !typing && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (mod && !typing && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault(); redo(); return;
    }
    if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault(); promptSaveProject(); return;
    }
    if (typing) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.playing) pausePlayback(); else startPlayback();
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      pausePlayback();
      seekGlobal(state.globalTime - (e.shiftKey ? 5 : 1));
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      pausePlayback();
      seekGlobal(state.globalTime + (e.shiftKey ? 5 : 1));
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedOverlayId) { e.preventDefault(); removeOverlay(state.selectedOverlayId); return; }
      if (state.selectedSeqId) { e.preventDefault(); removeSeqItem(state.selectedSeqId); return; }
    }
  });

  var PROJECT_DB_NAME = 'reel-cutter-db';
  var PROJECT_STORE = 'projects';
  function openProjectDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(PROJECT_DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(PROJECT_STORE, { keyPath: 'name' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function dbPut(record) {
    return openProjectDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(PROJECT_STORE, 'readwrite');
        tx.objectStore(PROJECT_STORE).put(record);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function dbGet(name) {
    return openProjectDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(PROJECT_STORE, 'readonly');
        var req = tx.objectStore(PROJECT_STORE).get(name);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function dbGetAllNames() {
    return openProjectDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(PROJECT_STORE, 'readonly');
        var req = tx.objectStore(PROJECT_STORE).getAllKeys();
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function dbDelete(name) {
    return openProjectDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(PROJECT_STORE, 'readwrite');
        tx.objectStore(PROJECT_STORE).delete(name);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function refreshProjectList() {
    if (!el.projectSelect) return Promise.resolve();
    return dbGetAllNames().then(function (names) {
      el.projectSelect.innerHTML = names.map(function (n) {
        return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>';
      }).join('');
    }).catch(function () {});
  }

  function setProjectStatus(text) {
    if (el.projectStatus) el.projectStatus.textContent = text;
  }

  function promptSaveProject() {
    var name = (el.projectNameInput && el.projectNameInput.value.trim()) || prompt('プロジェクト名を入力してください', '');
    if (!name) return;
    if (el.projectNameInput) el.projectNameInput.value = name;
    saveProject(name);
  }

  function saveProject(name) {
    setProjectStatus('保存中…');
    var record = {
      name: name,
      savedAt: Date.now(),
      resolution: el.resolutionSelect ? el.resolutionSelect.value : '1080x1920',
      fps: el.fpsSelect ? el.fpsSelect.value : '30',
      clips: state.clips.map(function (c) {
        return { id: c.id, name: c.name, file: c.file, duration: c.duration, width: c.width, height: c.height };
      }),
      overlayBin: state.overlayBin.map(function (m) {
        return { id: m.id, name: m.name, file: m.file, kind: m.kind, duration: m.duration, width: m.width, height: m.height };
      }),
      sequence: JSON.parse(JSON.stringify(state.sequence)),
      overlays: JSON.parse(JSON.stringify(state.overlays)),
      captions: JSON.parse(JSON.stringify(state.captions))
    };
    dbPut(record).then(function () {
      setProjectStatus('保存しました(' + new Date(record.savedAt).toLocaleTimeString() + ')');
      return refreshProjectList();
    }).then(function () {
      if (el.projectSelect) el.projectSelect.value = name;
    }).catch(function (err) {
      setProjectStatus('保存に失敗しました: ' + err.message);
    });
  }

  function loadProject(name) {
    if (!name) return;
    setProjectStatus('読み込み中…');
    dbGet(name).then(function (record) {
      if (!record) { setProjectStatus('見つかりませんでした'); return; }
      var probeChain = Promise.resolve();
      var newClips = [];
      record.clips.forEach(function (c) {
        probeChain = probeChain.then(function () {
          return probeMediaFile(c.file).then(function (meta) {
            newClips.push({
              id: c.id, name: c.name, file: c.file, url: meta.url,
              duration: c.duration, width: c.width, height: c.height, thumb: meta.thumb,
              ffmpegName: null
            });
          });
        });
      });
      var newOverlayBin = [];
      record.overlayBin.forEach(function (m) {
        probeChain = probeChain.then(function () {
          var probe = m.kind === 'video' ? probeMediaFile(m.file) : probeImageFile(m.file);
          return probe.then(function (meta) {
            newOverlayBin.push({
              id: m.id, name: m.name, file: m.file, kind: m.kind, url: meta.url,
              duration: m.duration, width: m.width, height: m.height, thumb: meta.thumb,
              ffmpegName: null
            });
          });
        });
      });
      return probeChain.then(function () {
        state.clips = newClips;
        state.overlayBin = newOverlayBin;
        state.sequence = record.sequence || [];
        state.overlays = record.overlays || [];
        state.captions = record.captions || [];
        state.selectedSeqId = state.sequence.length ? state.sequence[0].id : null;
        state.selectedOverlayId = null;
        if (el.resolutionSelect && record.resolution) el.resolutionSelect.value = record.resolution;
        if (el.fpsSelect && record.fps) el.fpsSelect.value = record.fps;
        if (el.projectNameInput) el.projectNameInput.value = name;
        recomputeOffsets();
        renderClipList();
        renderOverlayBinList();
        renderSequence();
        renderColorEditor();
        renderOverlayList();
        renderCaptionList();
        seekGlobal(0);
        history.stack = [];
        history.index = -1;
        pushHistory();
        setProjectStatus('「' + name + '」を読み込みました');
      });
    }).catch(function (err) {
      setProjectStatus('読み込みに失敗しました: ' + err.message);
    });
  }

  if (el.saveProjectBtn) el.saveProjectBtn.addEventListener('click', promptSaveProject);
  if (el.loadProjectBtn) el.loadProjectBtn.addEventListener('click', function () {
    loadProject(el.projectSelect && el.projectSelect.value);
  });
  if (el.deleteProjectBtn) el.deleteProjectBtn.addEventListener('click', function () {
    var name = el.projectSelect && el.projectSelect.value;
    if (!name) return;
    if (!confirm('プロジェクト「' + name + '」を削除しますか?')) return;
    dbDelete(name).then(refreshProjectList).then(function () { setProjectStatus('削除しました'); });
  });
  refreshProjectList();

  updateTransportUI();
  pushHistory();
})();
